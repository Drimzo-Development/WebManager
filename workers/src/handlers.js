'use strict';
const { q } = require('./db');
const agent = require('./agent');
const { decrypt, encrypt } = require('./crypto');
const crypto = require('crypto');

const APP_KEY = process.env.APP_KEY || '';
const { welcomeHtml, welcomePhp } = require('./welcome');
const notify = require('./notify');
const cron = require('./cron');
const report = require('./report');
const apps = require('./apps');

class JobError extends Error {}

async function loadSite(id) {
  const rows = await q('SELECT * FROM sites WHERE id = ?', [id]);
  if (!rows.length) throw new JobError(`Website ${id} no longer exists`);
  return rows[0];
}

const lines = (text) => String(text || '').split(/[\s,]+/).filter(Boolean);

/** Builds the agent spec (including decrypted environment) from the database. */
async function buildSpec(site) {
  const env = {};
  for (const r of await q('SELECT name, value_enc FROM site_env WHERE site_id = ?', [site.id])) {
    env[r.name] = decrypt(r.value_enc, APP_KEY);
  }
  const domains = (await q('SELECT domain FROM site_domains WHERE site_id = ? ORDER BY id', [site.id])).map((r) => r.domain);
  return {
    id: site.id, type: site.type, runtime: site.runtime, internalPort: site.internal_port, docroot: site.docroot,
    memoryMb: site.memory_mb, cpus: parseFloat(site.cpus), pids: site.pids,
    startCommand: site.start_command, installCommand: site.install_command, buildCommand: site.build_command,
    env, domains, autostart: !!site.autostart, webserverConf: site.webserver_conf || '', gate: !!site.gate_enabled, gateBypass: lines(site.gate_bypass_paths),
    maintenance: !!site.maintenance_enabled, maintenanceAllow: lines(site.maintenance_allow_ips),
    geoMode: site.geo_mode || 'off', geoCountries: lines(site.geo_countries),
    database: site.db_enabled && site.db_engine ? {
      external: site.db_external ? { allow: lines(site.db_external_allow) } : null,
      engine: site.db_engine, name: site.db_name, user: site.db_user, memoryMb: site.db_memory_mb || 512,
      password: decrypt(site.db_password_enc, APP_KEY), rootPassword: site.db_root_enc ? decrypt(site.db_root_enc, APP_KEY) : '',
    } : null,
    secHeaders: site.sec_headers ? JSON.parse(site.sec_headers) : null,
    wafMode: site.waf_mode || 'off', wafCategories: lines(site.waf_categories), wafExempt: lines(site.waf_exempt),
    ipAllow: lines(site.ip_allow), ipDeny: lines(site.ip_deny), rateRps: site.rate_limit_rps || 0, rateBurst: site.rate_limit_burst || 0, connLimit: site.conn_limit || 0,
  };
}

const PRESETS = {
  composer_install: 'composer install --no-dev --optimize-autoloader --no-interaction',
  artisan_migrate: 'php artisan migrate --force',
  artisan_storage_link: 'php artisan storage:link --force',
  artisan_optimize: 'php artisan optimize',
  artisan_optimize_clear: 'php artisan optimize:clear',
};

function gitBody(site) {
  return {
    kind: 'gitsync', url: site.git_url, branch: site.git_branch || undefined,
    username: site.git_username || undefined, token: site.git_token_enc ? decrypt(site.git_token_enc, APP_KEY) : undefined,
  };
}

/** Makes sure the runtime image exists; a first-time build/pull is streamed into the job log. */
async function ensureRuntime(ctx, site) {
  let code = 0;
  await agent.stream('POST', '/v1/images/ensure', { runtime: site.runtime, stream: true }, (m) => {
    if (m.t === 'out') ctx.log(m.d);
    if (m.t === 'exit') code = m.code;
  }, ctx.signal);
  if (code !== 0) throw new JobError('The runtime image could not be provided.');
}

async function setDesired(siteId, state) {
  await q('UPDATE sites SET desired_state = ? WHERE id = ?', [state, siteId]);
}

/** Runs a command stream on the agent; returns the exit code. */
async function runExec(ctx, siteId, body) {
  let code = null;
  await agent.stream('POST', `/v1/sites/${siteId}/exec`, { ...body, jobId: ctx.job.id }, (m) => {
    if (m.t === 'out') ctx.log(m.d);
    if (m.t === 'exit') code = m.code;
  }, ctx.signal);
  return code;
}

async function waitHealthy(ctx, siteId, seconds = 60) {
  const deadline = Date.now() + seconds * 1000;
  let st = null;
  while (Date.now() < deadline) {
    if (ctx.signal.aborted) throw new JobError('Cancelled');
    st = await agent.call('GET', `/v1/sites/${siteId}/status`);
    if (st.running && (!st.health || st.health === 'healthy')) return st;
    if (st.state === 'exited' || st.state === 'dead') break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return st;
}

async function updateCertState(name, siteId, result) {
  if (!result) return;
  const info = result.cert || {};
  const verified = result.ok === true;
  await q(
    `INSERT INTO certificates (name, site_id, status, not_after, last_error, last_checked_at, verified_at)
     VALUES (?, ?, ?, ?, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), not_after = VALUES(not_after), last_error = VALUES(last_error),
       last_checked_at = NOW(), verified_at = VALUES(verified_at)`,
    [name, siteId, verified ? 'verified' : (info.exists ? 'issued' : 'failed'),
      info.notAfter ? info.notAfter.slice(0, 19).replace('T', ' ') : null,
      verified ? null : `Stage: ${result.stage || '?'}`, verified ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null],
  );
}

/** Hands the stored DNS provider token to the agent (the agent keeps it in a file only root can read). False when none is set up. */
async function pushDnsCredentials() {
  const rows = await q("SELECT k, v FROM settings WHERE k IN ('dns_provider', 'dns_token_enc', 'dns_wait')");
  const s = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  if (!s.dns_provider || !s.dns_token_enc) return false;
  await agent.call('PUT', '/v1/dns', { provider: s.dns_provider, token: decrypt(s.dns_token_enc, APP_KEY), wait: parseInt(s.dns_wait || '30', 10) });
  return true;
}

/** Streams an agent DNS call into the job log; returns the agent's result. */
async function dnsStream(ctx, path, body) {
  let result = null;
  await agent.stream('POST', path, body, (m) => {
    if (m.t === 'out') ctx.log(m.d);
    if (m.t === 'result') result = m.result;
  }, ctx.signal);
  return result;
}

const handlers = {
  async 'site.create'(ctx) {
    const site = await loadSite(ctx.job.site_id);
    const p = ctx.payload;
    await ensureRuntime(ctx, site);
    ctx.log('== Create container configuration');
    await agent.call('PUT', `/v1/sites/${site.id}`, { spec: await buildSpec(site), start: false });

    const needsNode = ['node', 'express', 'next'].includes(site.type);
    if (p.app) {
      // application template: the files and the configuration come from its recipe (the database was set up with the container)
      await apps.install(ctx, site, p.app, { runExec, agent, fail: (m) => new JobError(m) });
    } else if (!site.git_url && site.type === 'static') {
      await agent.putRaw(`/v1/sites/${site.id}/fs/write?path=index.html`, welcomeHtml(site.name)).catch(() => {});
    } else if (!site.git_url && site.type === 'php') {
      await agent.putRaw(`/v1/sites/${site.id}/fs/write?path=index.php`, welcomePhp(site.name)).catch(() => {});
    }
    if (site.git_url) {
      ctx.log('== Load Git repository');
      const code = await runExec(ctx, site.id, gitBody(site));
      if (code !== 0) throw new JobError(`Git fetch failed (exit code ${code})`);
    }
    if (p.runInstall && site.install_command) {
      ctx.log('== Run install command');
      const code = await runExec(ctx, site.id, { kind: 'shell', command: site.install_command });
      if (code !== 0) throw new JobError(`Installation failed (exit code ${code})`);
    }
    if (p.runBuild && site.build_command) {
      ctx.log('== Run build');
      const code = await runExec(ctx, site.id, { kind: 'shell', command: site.build_command });
      if (code !== 0) throw new JobError(`Build failed (exit code ${code})`);
    }
    await q("UPDATE sites SET lifecycle = 'ready' WHERE id = ?", [site.id]);
    if (p.start !== false && (site.autostart || p.start === true)) {
      if (needsNode && !site.start_command && !p.hasPackageJson) ctx.log('Note: No project has been uploaded yet (no package.json). The start may fail.');
      ctx.log('== Start container');
      await agent.call('PUT', `/v1/sites/${site.id}`, { spec: await buildSpec(site), start: true });
      await setDesired(site.id, 'running');
      const st = await waitHealthy(ctx, site.id, 45);
      ctx.log(`Status: ${st ? st.state : '?'}${st && st.health ? ` / Health: ${st.health}` : ''}`);
      if (!st || !st.running) throw new JobError('Container is not running. Check the logs in the “Logs” tab.');
    }
  },

  async 'site.clone'(ctx) {
    const site = await loadSite(ctx.job.site_id);
    const p = ctx.payload;
    const source = await loadSite(p.source);
    await ensureRuntime(ctx, site);
    ctx.log('== Create container configuration');
    await agent.call('PUT', `/v1/sites/${site.id}`, { spec: await buildSpec(site), start: false });
    if (p.copyFiles) {
      ctx.log(`== Copy files of “${source.name}” (may take a while for large projects)`);
      await agent.call('POST', `/v1/sites/${site.id}/clone-from`, { source: source.id });
      ctx.log('Files copied.');
    } else if (site.type === 'static') {
      await agent.putRaw(`/v1/sites/${site.id}/fs/write?path=index.html`, welcomeHtml(site.name)).catch(() => {});
    } else if (site.type === 'php') {
      await agent.putRaw(`/v1/sites/${site.id}/fs/write?path=index.php`, welcomePhp(site.name)).catch(() => {});
    }
    await q("UPDATE sites SET lifecycle = 'ready' WHERE id = ?", [site.id]);
    if (p.start) {
      ctx.log('== Start container');
      await agent.call('PUT', `/v1/sites/${site.id}`, { spec: await buildSpec(site), start: true });
      await setDesired(site.id, 'running');
      const st = await waitHealthy(ctx, site.id, 45);
      ctx.log(`Status: ${st ? st.state : '?'}${st && st.health ? ` / Health: ${st.health}` : ''}`);
    }
    ctx.log('Done. Assign a domain of its own to the copy (e.g. staging.example.com).');
  },

  async 'site.apply'(ctx) {
    const site = await loadSite(ctx.job.site_id);
    await ensureRuntime(ctx, site);
    ctx.log('== Apply configuration');
    const r = await agent.call('PUT', `/v1/sites/${site.id}`, { spec: await buildSpec(site), start: 'keep' });
    ctx.log(r.created ? 'Container was recreated.' : 'Container configuration unchanged.');
    if (site.desired_state === 'running' && !r.started) {
      await agent.call('POST', `/v1/sites/${site.id}/action`, { action: 'start' });
    }
    if (ctx.payload.restart && !r.created) await agent.call('POST', `/v1/sites/${site.id}/action`, { action: 'restart' });
    await q("UPDATE sites SET lifecycle = 'ready' WHERE id = ?", [site.id]);
    ctx.log('Done.');
  },

  async 'site.start'(ctx) {
    const site = await loadSite(ctx.job.site_id);
    await ensureRuntime(ctx, site);
    await agent.call('PUT', `/v1/sites/${site.id}`, { spec: await buildSpec(site), start: true });
    await setDesired(site.id, 'running');
    const st = await waitHealthy(ctx, site.id, 45);
    ctx.log(`Status: ${st ? st.state : '?'}${st && st.health ? ` / Health: ${st.health}` : ''}`);
    if (!st || !st.running) throw new JobError('Container is not running');
  },

  async 'site.stop'(ctx) {
    const site = await loadSite(ctx.job.site_id);
    await agent.call('POST', `/v1/sites/${site.id}/action`, { action: 'stop' });
    await setDesired(site.id, 'stopped');
    ctx.log('Stopped.');
  },

  async 'site.restart'(ctx) {
    const site = await loadSite(ctx.job.site_id);
    await ensureRuntime(ctx, site);
    await agent.call('PUT', `/v1/sites/${site.id}`, { spec: await buildSpec(site), start: 'keep' });
    await agent.call('POST', `/v1/sites/${site.id}/action`, { action: 'restart' });
    await setDesired(site.id, 'running');
    const st = await waitHealthy(ctx, site.id, 45);
    ctx.log(`Status: ${st ? st.state : '?'}${st && st.health ? ` / Health: ${st.health}` : ''}`);
    if (!st || !st.running) throw new JobError('Container is not running after the restart');
  },

  async 'site.delete'(ctx) {
    const id = ctx.job.site_id;
    ctx.log('== Remove container, network and proxy route');
    const r = await agent.call('DELETE', `/v1/sites/${id}${ctx.payload.purge ? '?purge=1' : ''}`);
    ctx.log(r.trash ? `Files were moved to trash/${r.trash} (not deleted).` : 'Files were deleted permanently.');
    await q('DELETE FROM certificates WHERE site_id = ?', [id]);
    await q('DELETE FROM sites WHERE id = ?', [id]);
    ctx.log('Website removed.');
  },

  /** One run of a cron job: the command runs in a throw-away container of the website (same environment as the Commands tab). */
  async 'site.cron'(ctx) {
    const [job] = await q('SELECT * FROM site_cron WHERE id = ?', [Number(ctx.payload.cronId) || 0]);
    if (!job) throw new JobError('The cron job no longer exists');
    const site = await loadSite(ctx.job.site_id);
    const started = Date.now();
    const finish = async (status, exit) => {
      await q('UPDATE site_cron SET last_run_at = ?, last_status = ?, last_exit = ?, last_job_id = ?, last_duration_ms = ? WHERE id = ?',
        [new Date(started).toISOString().slice(0, 19).replace('T', ' '), status, exit, ctx.job.id, Math.min(Date.now() - started, 4294967295), job.id]);
    };
    if (site.lifecycle !== 'ready' || site.desired_state !== 'running') {
      await finish('skipped', null);
      ctx.log('The website is not running – the run is skipped.');
      return;
    }
    ctx.log(`== Cron job “${job.name}” (${job.schedule}), time limit ${job.timeout_sec} s`);
    let code;
    try {
      code = await runExec(ctx, site.id, { kind: 'shell', command: job.command, timeoutSec: job.timeout_sec });
    } catch (e) {
      await finish('failed', null);
      throw e;
    }
    ctx.setExit(code);
    await finish(code === 0 ? 'ok' : 'failed', code);
    if (code !== 0) throw new JobError(`Cron job “${job.name}” ended with exit code ${code}`);
  },

  async 'site.exec'(ctx) {
    const site = await loadSite(ctx.job.site_id);
    const p = ctx.payload;
    let body;
    if (p.kind === 'npm') body = { kind: 'npm', sub: p.sub, script: p.script };
    else if (p.kind === 'git') body = gitBody(site);
    else if (p.kind === 'extract') body = { kind: 'extract', archive: p.archive, strip: p.strip !== false };
    else if (p.kind === 'shell' && p.preset) {
      if (!Object.prototype.hasOwnProperty.call(PRESETS, p.preset) || site.type !== 'laravel') throw new JobError('Unknown command');
      body = { kind: 'shell', command: PRESETS[p.preset] };
    } else if (p.kind === 'shell' && p.which === 'install') body = { kind: 'shell', command: site.install_command };
    else if (p.kind === 'shell' && p.which === 'build') body = { kind: 'shell', command: site.build_command };
    else throw new JobError('Unknown task');
    if (body.kind === 'shell' && !body.command) throw new JobError('No matching command is configured for this website');
    const code = await runExec(ctx, site.id, body);
    ctx.setExit(code);
    if (code !== 0) throw new JobError(`Command ended with exit code ${code}`);
    for (const [flag, which, label] of [['runInstall', 'install_command', 'Install command'], ['runBuild', 'build_command', 'Build command']]) {
      if (p[flag] && site[which]) {
        ctx.log(`== Run ${label}`);
        const c = await runExec(ctx, site.id, { kind: 'shell', command: site[which] });
        if (c !== 0) throw new JobError(`${label} failed (exit code ${c})`);
      }
    }
    if (p.restartAfter) {
      ctx.log('== Restart application');
      await agent.call('POST', `/v1/sites/${site.id}/action`, { action: 'restart' });
    }
  },

  async 'site.cert'(ctx) {
    const site = await loadSite(ctx.job.site_id);
    const name = `site-${String(site.id).padStart(3, '0')}`;
    const domains = (await q('SELECT domain FROM site_domains WHERE site_id = ? ORDER BY id', [site.id])).map((r) => r.domain);
    if (!domains.length) throw new JobError('No domains are assigned to the website');
    const viaDns = !!ctx.payload.dns || domains.some((d) => d.startsWith('*.'));
    if (viaDns && !(await pushDnsCredentials())) throw new JobError('No DNS provider is set up (System → DNS provider)');
    // make sure the agent knows the current domain list before validating
    await agent.call('PUT', `/v1/sites/${site.id}`, { spec: await buildSpec(site), start: 'keep' });
    let result = null;
    await agent.stream('POST', `/v1/certs/${name}/issue`, { domains, email: ctx.payload.email, dns: viaDns }, (m) => {
      if (m.t === 'out') ctx.log(m.d);
      if (m.t === 'result') result = m.result;
    }, ctx.signal);
    await updateCertState(name, site.id, result);
    if (!result || !result.ok) throw new JobError('Certificate could not be set up or verified');
  },

  async 'dashboard.cert'(ctx) {
    const domain = ctx.payload.domain;
    await agent.call('PUT', '/v1/dashboard', { domain });
    ctx.log(`Dashboard-Domain: ${domain}`);
    if (!ctx.payload.email) return;
    let result = null;
    await agent.stream('POST', '/v1/certs/dashboard/issue', { domains: [domain], email: ctx.payload.email }, (m) => {
      if (m.t === 'out') ctx.log(m.d);
      if (m.t === 'result') result = m.result;
    }, ctx.signal);
    await updateCertState('dashboard', null, result);
    if (!result || !result.ok) throw new JobError('Dashboard certificate could not be set up or verified');
  },

  async 'dashboard.domain'(ctx) {
    await agent.call('PUT', '/v1/dashboard', { domain: ctx.payload.domain || '' });
    ctx.log(ctx.payload.domain ? `Dashboard domain set: ${ctx.payload.domain}` : 'Dashboard domain removed (access by IP).');
  },

  async 'dns.apply'(ctx) {
    if (!(await pushDnsCredentials())) {
      await agent.call('DELETE', '/v1/dns');
      ctx.log('The DNS provider was removed. Certificates that were validated through DNS can no longer be renewed until one is set up again.');
      return;
    }
    ctx.log('The token was stored on the server. Testing it …');
    const r = await dnsStream(ctx, '/v1/dns/test', {});
    if (!r || !r.ok) throw new JobError('The DNS provider did not accept the token (it is saved; correct it and save again)');
  },

  async 'dns.test'(ctx) {
    if (!(await pushDnsCredentials())) throw new JobError('No DNS provider is set up');
    const r = await dnsStream(ctx, '/v1/dns/test', {});
    if (!r || !r.ok) throw new JobError('The DNS provider did not accept the token');
  },

  async 'site.dns_records'(ctx) {
    const domains = (await q('SELECT domain FROM site_domains WHERE site_id = ? ORDER BY id', [ctx.job.site_id])).map((r) => r.domain);
    if (!domains.length) throw new JobError('No domains are assigned to the website');
    if (!(await pushDnsCredentials())) throw new JobError('No DNS provider is set up');
    const r = await dnsStream(ctx, '/v1/dns/records', { domains });
    if (!r || !r.ok) throw new JobError('The DNS records could not be set');
  },

  async 'certs.renew'(ctx) {
    await pushDnsCredentials().catch((e) => ctx.log(`DNS provider: ${e.message}`)); // certificates validated through DNS need it
    let result = null;
    await agent.stream('POST', '/v1/certs/renew', {}, (m) => {
      if (m.t === 'out') ctx.log(m.d);
      if (m.t === 'result') result = m.result;
    }, ctx.signal);
    await q("REPLACE INTO settings (k, v) VALUES ('last_cert_renewal', ?)", [new Date().toISOString()]);
    if (result && result.certs) {
      for (const [name, c] of Object.entries(result.certs)) {
        await q(
          `INSERT INTO certificates (name, site_id, status, not_after, last_checked_at)
           VALUES (?, ?, 'issued', ?, NOW())
           ON DUPLICATE KEY UPDATE not_after = VALUES(not_after), last_checked_at = NOW()`,
          [name, name === 'dashboard' ? null : parseInt(name.slice(5), 10), c.notAfter.slice(0, 19).replace('T', ' ')],
        );
      }
    }
    if (!result || !result.ok) throw new JobError('Certificate renewal reported an error');
  },

  async 'site.report'(ctx) {
    ctx.log('Compiling the statistics report …');
    try {
      const to = await report.sendReport(ctx.job.site_id);
      ctx.log(`Sent to: ${to.join(', ')}`);
    } catch (e) {
      throw new JobError(`Sending failed: ${e.message}`);
    }
  },

  /** Test message through every notification channel that is set up (e-mail, webhook, ntfy, Telegram). */
  async 'notify.test'(ctx) {
    const s = await notify.settings();
    const names = { email: 'Email', webhook: 'Webhook', ntfy: 'ntfy', telegram: 'Telegram' };
    if (notify.emailReady(s)) ctx.log(`Email: ${s.smtp_host}:${s.smtp_port || '–'} (${s.smtp_security || 'starttls'}) → ${notify.recipients(s).join(', ')}`);
    for (const ch of notify.activeChannels(s)) ctx.log(`${names[ch.type]}: set up`);
    let results;
    try {
      results = await notify.deliver('Test message', 'This is a test message from your dashboard (webmanager).\nIf you can read this, notifications work.', { s, kind: 'ok', title: 'Notifications work' });
    } catch (e) {
      throw new JobError(`Sending failed: ${e.message}`);
    }
    for (const r of results) ctx.log(`${names[r.type]}: ${r.ok ? 'delivered' : `FAILED – ${r.error}`}`);
    if (results.some((r) => !r.ok)) throw new JobError('At least one channel could not be reached (see above).');
  },

  async 'mail.test'(ctx) { return handlers['notify.test'](ctx); },

  /** "Someone signed in" mail to the person who signed in (queued by the dashboard after a successful login). */
  async 'mail.login'(ctx) {
    const { to, name, ip, ua, at } = ctx.payload;
    const s = await notify.settings();
    if (!/^[^@\s]+@[^@\s]+$/.test(String(to || ''))) throw new JobError('No valid recipient address.');
    try {
      await notify.sendMail('New sign-in to your account', notify.loginText(name), {
        s, to: [to], kind: 'warn', title: 'New sign-in to your account',
        facts: notify.loginFacts({ ip, ua, at }),
      });
      ctx.log(`Notice sent to ${to}`);
    } catch (e) {
      throw new JobError(`Sending failed: ${e.message}`);
    }
  },

  /** First-time build of the common runtime images (minutes), with visible progress instead of a silent wait during the update. */
  async 'images.prepare'(ctx) {
    let failed = 0;
    for (const rt of ['static', 'php-8.3']) {
      ctx.log(`== Runtime image ${rt}`);
      let code = 0;
      try {
        await agent.stream('POST', '/v1/images/ensure', { runtime: rt, stream: true }, (m) => {
          if (m.t === 'out') ctx.log(m.d);
          if (m.t === 'exit') code = m.code;
        }, ctx.signal);
      } catch (e) {
        code = 1;
        ctx.log(`Error: ${e.message}`);
      }
      if (code !== 0) failed++;
    }
    if (failed) throw new JobError(`${failed} runtime image(s) could not be prepared. They will be built when the first matching website is created.`);
  },

  async 'db.admin.start'(ctx) {
    const r = await agent.call('POST', `/v1/sites/${ctx.job.site_id}/database/admin/start`, {});
    ctx.log(`Database management started (switches off after ${r.minutes} minutes).`);
  },

  async 'db.admin.stop'(ctx) {
    await agent.call('POST', `/v1/sites/${ctx.job.site_id}/database/admin/stop`, {});
    ctx.log('Database management ended.');
  },

  async 'db.dump'(ctx) {
    const r = await agent.call('POST', `/v1/sites/${ctx.job.site_id}/database/dump`, {});
    ctx.log(`Dump created: ${r.name} (${Math.round(r.size / 1024)} KB)`);
  },

  async 'db.restore'(ctx) {
    ctx.log(`Restoring ${ctx.payload.name} …`);
    await agent.call('POST', `/v1/sites/${ctx.job.site_id}/database/restore`, { name: ctx.payload.name });
    ctx.log('Restore completed.');
  },

  /** New password: first inside the database, then in the stored credentials, then the website gets it through its environment. */
  async 'db.rotate'(ctx) {
    const site = await loadSite(ctx.job.site_id);
    if (!site.db_enabled || !site.db_engine) throw new JobError('No database is active for this website.');
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const pw = Array.from(crypto.randomBytes(32), (b) => chars[b % chars.length]).join('');
    await agent.call('POST', `/v1/sites/${site.id}/database/password`, { password: pw });
    await q('UPDATE sites SET db_password_enc = ? WHERE id = ?', [encrypt(pw, APP_KEY), site.id]);
    ctx.log('Password changed in the database. The website receives it through its environment variables after updating.');
    await agent.call('PUT', `/v1/sites/${site.id}`, { spec: await buildSpec(await loadSite(site.id)), start: 'keep' });
    ctx.log('Website updated.');
  },

  async 'db.purge'(ctx) {
    const site = await loadSite(ctx.job.site_id);
    await q('UPDATE sites SET db_enabled = 0 WHERE id = ?', [site.id]);
    await agent.call('PUT', `/v1/sites/${site.id}`, { spec: await buildSpec(await loadSite(site.id)), start: 'keep' });
    await agent.call('POST', `/v1/sites/${site.id}/database/purge`, {});
    await q('UPDATE sites SET db_engine = NULL, db_name = NULL, db_user = NULL, db_password_enc = NULL, db_root_enc = NULL WHERE id = ?', [site.id]);
    ctx.log('Database and all data were deleted.');
  },

  async 'protection.apply'(ctx) {
    const [row] = await q("SELECT v FROM settings WHERE k = 'protection_config'");
    const conf = row ? JSON.parse(row.v) : {};
    await agent.call('PUT', '/v1/protection', conf);
    ctx.log('Protection settings passed to the proxy.');
  },

  async 'protection.unban'(ctx) {
    await agent.call('POST', '/v1/protection/unban', { ip: ctx.payload.ip });
    ctx.log(`${ctx.payload.ip} was unblocked.`);
  },

  async 'geo.update'(ctx) {
    ctx.log('Loading country data of the five Regional Internet Registries (RIPE, ARIN, APNIC, LACNIC, AFRINIC) …');
    const r = await agent.call('POST', '/v1/geo/update', {});
    await q("REPLACE INTO settings (k, v) VALUES ('last_geo_update', ?)", [new Date().toISOString()]);
    ctx.log(`Done: ${r.countries} countries, ${r.ranges} address ranges.`);
    if (r.sitesUpdated && r.sitesUpdated.length) ctx.log(`Country rules updated for ${r.sitesUpdated.length} website(s).`);
  },

  /** Hands an update check / update request to the host helper (systemd path unit); the update itself runs on the host. */
  async 'system.update'(ctx) {
    const action = ctx.payload && ['update', 'auto', 'rollback'].includes(ctx.payload.action) ? ctx.payload.action : 'check';
    if (action === 'rollback') {
      try {
        await agent.call('POST', '/v1/update/request', { action: 'rollback' });
      } catch (e) {
        throw new JobError(e.message);
      }
      ctx.log('The roll back to the previous program version was handed over to the server. It backs up the current state first, then restores program files and database from before the last update and restarts the services; the dashboard is briefly unreachable.');
      return;
    }
    if (action === 'auto') {
      try {
        const r = await agent.call('POST', '/v1/update/auto', { mode: ctx.payload.mode, from: ctx.payload.from, to: ctx.payload.to });
        ctx.log(r.mode === 'patch'
          ? `Automatic updates of patch versions are enabled (time window ${r.from}:00 to ${r.to}:00 server time).`
          : 'Automatic updates are switched off.');
      } catch (e) {
        throw new JobError(e.message);
      }
      return;
    }
    const version = action === 'update' ? String(ctx.payload.version || '') : undefined;
    try {
      await agent.call('POST', '/v1/update/request', { action, version });
    } catch (e) {
      throw new JobError(e.message);
    }
    ctx.log(action === 'update'
      ? `Update to version ${version} was handed over to the server. It backs up configuration and database first and then restarts the services; the dashboard is briefly unreachable.`
      : 'Check for new versions requested.');
  },

  /** Hands a backup / upload / restore-test request to the host helper (systemd path unit); the work itself runs on the host. */
  async 'system.backup'(ctx) {
    const action = ['backup', 'upload', 'verify', 'verify-remote'].includes(ctx.payload && ctx.payload.action) ? ctx.payload.action : null;
    if (!action) throw new JobError('Unknown backup action');
    try {
      await agent.call('POST', '/v1/backup/request', { action });
    } catch (e) {
      throw new JobError(e.message);
    }
    const label = { backup: 'Backup', upload: 'Upload to the external target', verify: 'Restore test of the local backup', 'verify-remote': 'Restore test of the backup from the external target' }[action];
    ctx.log(`${label} was handed over to the server. Progress and result are shown under System & settings → Backups.`);
  },

  /** Storage cleanup: the agent recomputes the candidates by fixed rules; only category ids are passed. */
  async 'system.cleanup'(ctx) {
    const cats = Array.isArray(ctx.payload.categories) ? ctx.payload.categories : [];
    ctx.log(`Cleaning up: ${cats.join(', ')}`);
    const r = await agent.call('POST', '/v1/storage/cleanup', { categories: cats }, { timeoutMs: 20 * 60 * 1000 });
    const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);
    for (const [id, c] of Object.entries(r.categories || {})) ctx.log(`${id}: ${c.deleted} entries removed, about ${fmt(c.freed)} freed`);
    for (const e of r.errors || []) ctx.log(`Error: ${e}`);
    ctx.log(`In total about ${fmt(r.freed || 0)} freed.`);
    if ((r.errors || []).length) throw new JobError(`${r.errors.length} entries could not be removed`);
  },

  async 'system.reconcile'(ctx) {
    ctx.log('== Reconcile all websites with the database');
    const [dash] = await q("SELECT v FROM settings WHERE k = 'dashboard_domain'");
    if (dash && dash.v) await agent.call('PUT', '/v1/dashboard', { domain: dash.v });
    const sites = await q("SELECT * FROM sites WHERE lifecycle = 'ready' ORDER BY id");
    let failed = 0;
    for (const site of sites) {
      try {
        await agent.call('PUT', `/v1/sites/${site.id}`, { spec: await buildSpec(site), start: site.desired_state === 'running' });
        ctx.log(`site-${String(site.id).padStart(3, '0')} ${site.name}: ok`);
      } catch (e) {
        failed++;
        ctx.log(`site-${String(site.id).padStart(3, '0')} ${site.name}: ERROR ${e.message}`);
      }
    }
    await agent.call('POST', '/v1/reconcile', {});
    if (failed) throw new JobError(`${failed} website(s) could not be reconciled`);
  },
};

module.exports = { handlers, JobError, buildSpec };
