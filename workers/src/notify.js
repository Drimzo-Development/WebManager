'use strict';
const nodemailer = require('nodemailer');
const { q } = require('./db');
const agent = require('./agent');
const { decrypt } = require('./crypto');
const fs = require('fs');
const path = require('path');
const { renderMail } = require('./mailtemplate');
const channels = require('./channels');
const uptime = require('./uptime');
const resources = require('./resources');
const maintenance = require('./maintenance');

const APP_KEY = process.env.APP_KEY || '';
const DOWN_AFTER_CHECKS = 2; // consecutive failed checks (one per minute) before an outage is reported
const CERT_REMINDER_MS = 3 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const BACKUP_STALE_MS = 36 * 3600 * 1000;
const BAN_WINDOW_MS = 15 * 60 * 1000;
const BAN_REMINDER_MS = 3600 * 1000;

const LOGO_FILE = process.env.MAIL_LOGO || path.join(__dirname, '..', 'assets', 'logo.png');

const slug = (id) => `site-${String(id).padStart(3, '0')}`;

async function settings() {
  const rows = await q("SELECT k, v FROM settings WHERE k LIKE 'smtp\\_%' OR k LIKE 'notify\\_%' OR k = 'brand_name'");
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}

function recipients(s) {
  return String(s.notify_to || '').split(/[\s,;]+/).filter((x) => /^[^@\s]+@[^@\s]+$/.test(x));
}

function transport(s) {
  if (!s.smtp_host) throw new Error('No SMTP server is configured.');
  const security = s.smtp_security || 'starttls';
  const port = parseInt(s.smtp_port || (security === 'tls' ? '465' : '587'), 10);
  const auth = s.smtp_user ? { user: s.smtp_user, pass: s.smtp_pass_enc ? decrypt(s.smtp_pass_enc, APP_KEY) : '' } : undefined;
  return nodemailer.createTransport({
    host: s.smtp_host,
    port,
    secure: security === 'tls',
    requireTLS: security === 'starttls',
    ignoreTLS: security === 'none',
    auth,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}

/** Address of the dashboard for the button in the mails, or null when no domain is configured. */
async function dashboardUrl() {
  try {
    const [d] = await q("SELECT v FROM settings WHERE k = 'dashboard_domain'");
    if (!d || !d.v) return null;
    const [c] = await q("SELECT status FROM certificates WHERE name = 'dashboard'");
    return `${c && ['issued', 'verified'].includes(c.status) ? 'https' : 'http'}://${d.v}/`;
  } catch (_) { return null; }
}

/**
 * Sends a mail (HTML with a plain-text alternative) to the configured recipients (or `to`).
 * Options: kind ('ok'|'warn'|'error'|'info'), title, facts [[label, value]], link (false = no dashboard button).
 * Throws with a readable message on failure.
 */
const DEFAULT_BRAND = 'Drimzo Development';
const brandName = (cfg) => (String((cfg && cfg.brand_name) || '').trim() || DEFAULT_BRAND).slice(0, 40);

/** Logo for mails: the dashboard logo when it is a raster image (mail clients do not show SVG), else the packaged default. */
async function mailLogo() {
  try {
    const [row] = await q("SELECT mime, data FROM brand_assets WHERE k = 'logo'");
    if (row) {
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[row.mime];
      return ext ? { content: Buffer.from(row.data), filename: `logo.${ext}` } : null;
    }
  } catch (_) { /* table missing: default logo */ }
  try { return { content: fs.readFileSync(LOGO_FILE), filename: 'logo.png' }; } catch (_) { return null; }
}

async function sendMail(subject, text, { to, s, kind = 'info', title, facts, link } = {}) {
  const cfg = s || await settings();
  const rcpt = to || recipients(cfg);
  if (!rcpt.length) throw new Error('No recipient addresses are set.');
  const from = cfg.smtp_from || cfg.smtp_user;
  if (!from) throw new Error('No sender address is set.');
  const logo = await mailLogo();
  const brand = brandName(cfg);
  const url = link === false ? null : await dashboardUrl();
  const html = renderMail({ title: title || subject, text, kind, facts, link: url ? { url } : undefined, logo: !!logo, brand });
  const plain = facts && facts.length ? `${text}\n\n${facts.filter((f) => f[1]).map(([a, b]) => `${a}: ${b}`).join('\n')}` : text;
  const attachments = logo ? [{ filename: logo.filename, content: logo.content, cid: 'logo', contentDisposition: 'inline' }] : [];
  return transport(cfg).sendMail({ from, to: rcpt, subject: `[${brand}] ${subject}`, text: plain, html, attachments });
}

/** An e-mail can be sent: server, sender and at least one recipient are set. */
function emailReady(cfg) {
  return !!(cfg.smtp_host && (cfg.smtp_from || cfg.smtp_user) && recipients(cfg).length);
}

/** Webhook / ntfy / Telegram channels that are set up. */
function activeChannels(cfg) {
  return channels.fromSettings(cfg, (v) => decrypt(v, APP_KEY));
}

/**
 * Sends a notification through every channel that is set up (e-mail, webhook, ntfy, Telegram). A failing channel is logged and does
 * not stop the others; it only throws when no channel could deliver (so the caller tries again at the next pass instead of
 * repeating the message on the channels that worked). Returns [{ type, ok, error? }].
 */
async function deliver(subject, text, opts = {}) {
  const cfg = opts.s || await settings();
  const results = [];
  if (emailReady(cfg)) {
    try { await sendMail(subject, text, { ...opts, s: cfg }); results.push({ type: 'email', ok: true }); } catch (e) { results.push({ type: 'email', ok: false, error: e.message }); }
  }
  const msg = { brand: brandName(cfg), subject, text, kind: opts.kind || 'info', facts: opts.facts, title: opts.title };
  results.push(...await channels.sendAll(activeChannels(cfg), msg));
  if (!results.length) throw new Error('No notification channel is set up.');
  for (const r of results) if (!r.ok) process.stderr.write(`[worker] notification via ${r.type} failed: ${r.error}\n`);
  if (!results.some((r) => r.ok)) throw new Error(results.map((r) => `${r.type}: ${r.error}`).join('; '));
  return results;
}

/** Text and facts of the sign-in warning (pure, so they can be tested). */
function loginText(name) {
  return [
    name ? `Hello ${name},` : '',
    'a sign-in to your account took place.',
    'If it was you, nothing needs to be done. If not, change your password immediately under “My account” and set up two-factor authentication.',
  ].filter(Boolean).join('\n\n');
}

function browserOf(ua) {
  const u = String(ua || '');
  const b = /Edg\//.test(u) ? 'Edge' : /OPR\/|Opera/.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : '';
  const os = /Windows/.test(u) ? 'Windows' : /Android/.test(u) ? 'Android' : /iPhone|iPad|iOS/.test(u) ? 'iOS' : /Mac OS X/.test(u) ? 'macOS' : /Linux/.test(u) ? 'Linux' : '';
  return [b, os].filter(Boolean).join(' on ') || 'Unknown browser';
}

function loginFacts({ ip, ua, at }) {
  const t = Date.parse(at);
  return [
    ['Time', Number.isNaN(t) ? '' : new Date(t).toLocaleString('en-GB', { timeZone: process.env.TZ || 'UTC' })],
    ['IP address', ip],
    ['Device', browserOf(ua)],
  ];
}

/** Pure state machine for outage detection; returns the next state and the event to report (if any). */
function evaluate(prev, isDown) {
  const p = prev || { count: 0, notified: false };
  if (isDown) {
    const count = p.count + 1;
    if (count >= DOWN_AFTER_CHECKS && !p.notified) return { state: { count, notified: true, since: p.since || Date.now() }, event: 'down' };
    return { state: { count, notified: p.notified, since: p.since || Date.now() }, event: null };
  }
  if (p.notified) return { state: { count: 0, notified: false }, event: 'up', downMs: Date.now() - (p.since || Date.now()) };
  return { state: { count: 0, notified: false }, event: null };
}

const monitor = new Map();
/** Windows that are active during the current pass ({ global, sites }); null = unknown, nothing is muted. */
let mute = null;
const muted = (siteId) => maintenance.isMuted(mute, siteId);

function siteIsDown(site, st) {
  if (site.lifecycle !== 'ready' || site.desired_state !== 'running') return false;
  if (!st || !st.exists) return true;
  if (!st.running || st.state === 'restarting') return true;
  return st.health === 'unhealthy';
}

function duration(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  return min < 60 ? `${min} minutes` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

async function checkSites(s) {
  if (s.notify_site_down !== '1') return;
  const sites = await q('SELECT id, name, lifecycle, desired_state FROM sites');
  const { statuses } = await agent.call('GET', '/v1/statuses', undefined, { timeoutMs: 20000 });
  for (const site of sites) {
    // a persisted "notified" marker survives worker restarts, so the recovery mail is not lost
    let prev = monitor.get(site.id);
    if (!prev) {
      const [row] = await q('SELECT v FROM settings WHERE k = ?', [`mon:${site.id}`]);
      prev = row ? { count: DOWN_AFTER_CHECKS, notified: true, since: Date.parse(row.v) || Date.now() } : { count: 0, notified: false };
    }
    const st = statuses[String(site.id)];
    const containerDown = siteIsDown(site, st);
    // a running container that no longer answers HTTP counts as an outage as well (only for websites that should be running)
    const check = !containerDown && site.lifecycle === 'ready' && site.desired_state === 'running' ? await uptime.latest(site.id) : null;
    const httpDown = uptime.probeDown(check);
    const res = evaluate(prev, containerDown || httpDown);
    if (muted(site.id)) {
      // maintenance window: say nothing. A website that is still down afterwards is reported at the next pass;
      // one that was reported before and recovers meanwhile just loses its marker (no "running again" mail for a planned stop).
      if (res.event === 'down') monitor.set(site.id, { count: DOWN_AFTER_CHECKS - 1, notified: false, since: res.state.since });
      else monitor.set(site.id, res.state);
      if (res.event === 'up') await q('DELETE FROM settings WHERE k = ?', [`mon:${site.id}`]);
      continue;
    }
    monitor.set(site.id, res.state);
    if (res.event === 'down') {
      const doms = (await q('SELECT domain FROM site_domains WHERE site_id = ?', [site.id])).map((r) => r.domain);
      await deliver(`Website “${site.name}” is not reachable`,
        `${httpDown ? 'The website is running but does not answer HTTP requests correctly.' : 'The website is no longer running.'}\n\nPlease check logs and status in the WebManager.`,
        { s, kind: 'error', title: `“${site.name}” is not reachable`, facts: [['Website', site.name], ['ID', slug(site.id)], ['Domains', doms.join(', ')], ['Reason', httpDown ? `HTTP check failed${check.error ? `: ${check.error}` : ''}` : 'Container is not running'], ['Time', new Date().toLocaleString('en-GB', { timeZone: process.env.TZ || 'UTC' })]] });
      await q("REPLACE INTO settings (k, v) VALUES (?, ?)", [`mon:${site.id}`, new Date(res.state.since).toISOString()]);
    } else if (res.event === 'up') {
      await deliver(`Website “${site.name}” is running again`, 'The website is reachable again.',
        { s, kind: 'ok', title: `“${site.name}” is running again`, facts: [['Website', site.name], ['ID', slug(site.id)], ['Downtime', `about ${duration(res.downMs)}`]] });
      await q('DELETE FROM settings WHERE k = ?', [`mon:${site.id}`]);
    }
  }
}

async function checkCerts(s) {
  if (s.notify_cert !== '1') return;
  const days = Math.min(Math.max(parseInt(s.notify_cert_days || '14', 10) || 14, 1), 60);
  const certs = await q("SELECT name, not_after FROM certificates WHERE not_after IS NOT NULL AND status IN ('issued','verified')");
  for (const c of certs) {
    const left = Math.floor((Date.parse(`${String(c.not_after).replace(' ', 'T')}Z`) - Date.now()) / 86400000);
    if (Number.isNaN(left) || left > days) continue;
    const key = `notified:cert:${c.name}`;
    const [row] = await q('SELECT v FROM settings WHERE k = ?', [key]);
    if (row && Date.now() - Date.parse(row.v) < CERT_REMINDER_MS) continue;
    const label = c.name === 'dashboard' ? 'Dashboard' : c.name;
    await deliver(`Certificate for ${label} ${left < 0 ? 'has expired' : 'expires soon'}`,
      `The HTTPS certificate “${label}” ${left < 0 ? `expired ${-left} days ago` : `expires in ${left} days`}.\nAutomatic renewal runs daily; if it fails, check DNS and that the domain is reachable on port 80, then start the certificate check under “System & settings”.`, { s, kind: left < 0 ? 'error' : 'warn', facts: [['Certificate', label], ['Remaining', left < 0 ? `expired ${-left} days ago` : `${left} days`]] });
    await q('REPLACE INTO settings (k, v) VALUES (?, ?)', [key, new Date().toISOString()]);
  }
}

/** Share of the data disk that is used (0-100), or null when unknown. */
function diskUsedPercent(disk) {
  if (!disk || !disk.totalBytes) return null;
  return Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 1000) / 10;
}

/** Describes what is wrong with the last backup, or null if everything is fine (or no backup is configured). */
function backupProblem(status, now = Date.now()) {
  if (!status || !status.at) return null;
  const at = Date.parse(status.at);
  if (status.ok === false) return { kind: 'failed', at, text: `The last backup (${status.at}) failed.` };
  if (!Number.isNaN(at) && now - at > BACKUP_STALE_MS) {
    return { kind: 'stale', at, text: `The last successful backup is more than ${Math.floor((now - at) / 3600000)} hours old (${status.at}).` };
  }
  return null;
}

const VER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const cmpVer = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

/**
 * Mails about updates (pure, testable): a new version (once per version) and the result of an AUTOMATIC update (once per run).
 * `u` is the agent's /v1/update answer, `sent` the set of markers that were mailed before. Returns [{ key, subject, text, kind, facts }].
 */
function updateMails(u, sent) {
  const out = [];
  if (!u || !VER.test(String(u.version || ''))) return out;
  const newer = (u.releases || []).filter((r) => VER.test(r.version) && cmpVer(r.version, u.version) > 0).sort((a, b) => cmpVer(b.version, a.version));
  if (newer.length) {
    const top = newer[0];
    const key = `update:${top.version}`;
    if (!sent.has(key)) {
      const sameMinor = u.version.split('.').slice(0, 2).join('.') === top.version.split('.').slice(0, 2).join('.');
      const auto = u.auto && u.auto.mode === 'patch' && sameMinor
        ? `This patch version will be installed automatically (time window ${u.auto.from}:00 to ${u.auto.to}:00 server time).`
        : 'To update: System & settings → Updates → “Update now”.';
      const notes = String(top.notes || '').trim().slice(0, 1500);
      out.push({ key, kind: 'info', subject: `New version ${top.version} available`,
        text: `Version ${top.version} of the WebManager has been released.${notes ? `\n\nChanges:\n${notes}` : ''}\n\n${auto}`,
        facts: [['Installed', u.version], ['Available', top.version]] });
    }
  }
  const st = u.state;
  if (st && st.auto === true && (st.state === 'ok' || st.state === 'failed')) {
    const key = `update-run:${st.at}`;
    if (!sent.has(key)) {
      const tail = String(u.logTail || '').trim().split('\n').slice(-12).join('\n');
      out.push(st.state === 'ok'
        ? { key, kind: 'ok', subject: `Automatic update to ${st.version} succeeded`, text: `The WebManager was updated automatically to version ${st.version} (configuration and database were backed up first, a health check followed).`, facts: [['Version', st.version], ['Time', st.at]] }
        : { key, kind: 'error', subject: `Automatic update to ${st.version} failed`, text: `The automatic update to version ${st.version} failed. It was rolled back to the previous state; websites and data were not affected. Further automatic attempts for this version are paused until you save the setting again under System & settings → Updates.${tail ? `\n\nExcerpt from the log:\n${tail}` : ''}`, facts: [['Version', st.version], ['Time', st.at]] });
    }
  }
  return out;
}

async function checkUpdates(s) {
  if (s.notify_update === '0') return;
  const u = await agent.call('GET', '/v1/update', undefined, { timeoutMs: 20000 });
  const keys = [];
  for (const r of (u.releases || [])) keys.push(`notified:update:${r.version}`);
  if (u.state && u.state.at) keys.push(`notified:update-run:${u.state.at}`);
  const sent = new Set();
  if (keys.length) for (const row of await q(`SELECT k FROM settings WHERE k IN (${keys.map(() => '?').join(',')})`, keys)) sent.add(row.k.replace(/^notified:/, ''));
  for (const m of updateMails(u, sent)) {
    await deliver(m.subject, m.text, { s, kind: m.kind, facts: m.facts });
    await q('REPLACE INTO settings (k, v) VALUES (?, ?)', [`notified:${m.key}`, new Date().toISOString()]);
  }
}

/** Problems with the external backup target / restore tests (null = fine or not configured). */
function remoteBackupProblems(rb, now = Date.now()) {
  if (!rb || !rb.configured) return [];
  const out = [];
  if (rb.upload && rb.upload.ok === false) out.push({ kind: 'remote_failed', text: `The upload of the last backup to the external target failed (${rb.upload.at}). The local backup exists but is not stored outside the server.` });
  else if (rb.upload && rb.upload.ok && now - Date.parse(rb.upload.at) > BACKUP_STALE_MS + DAY_MS) out.push({ kind: 'remote_stale', text: `The last backup on the external target is older than two days (${rb.upload.at}).` });
  if (rb.verify && rb.verify.ok === false) out.push({ kind: 'verify_failed', text: `The restore test of the last backup failed (${rb.verify.at}). The backup may not be restorable.` });
  return out;
}

/** Reminder bookkeeping in the settings table: true when `key` was not notified within `everyMs`. */
async function due(key, everyMs) {
  const [row] = await q('SELECT v FROM settings WHERE k = ?', [key]);
  return !row || Date.now() - Date.parse(row.v) >= everyMs;
}
const mark = (key) => q('REPLACE INTO settings (k, v) VALUES (?, ?)', [key, new Date().toISOString()]);

async function checkJobs(s) {
  if (s.notify_jobs !== '1') return;
  const key = 'notified:jobs_since';
  const [row] = await q('SELECT v FROM settings WHERE k = ?', [key]);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (!row) { await q('REPLACE INTO settings (k, v) VALUES (?, ?)', [key, now]); return; } // start counting from now
  let failed = await q(`SELECT id, title, error, site_id, finished_at FROM jobs WHERE status = 'failed' AND type NOT IN ('mail.test', 'notify.test') AND finished_at > ?
       AND NOT (type = 'site.cron' AND JSON_VALUE(payload, '$.cronId') IN (SELECT CAST(id AS CHAR) FROM site_cron WHERE notify_fail = 0))
     ORDER BY finished_at LIMIT 50`, [row.v]);
  const cursor = failed.length ? String(failed[failed.length - 1].finished_at) : null;
  failed = failed.filter((j) => !muted(j.site_id));
  if (!failed.length) {
    if (cursor) await q('REPLACE INTO settings (k, v) VALUES (?, ?)', [key, cursor]);
    return;
  }
  const lines = failed.slice(0, 10).map((j) => `• #${j.id} ${j.title}${j.error ? ` – ${j.error}` : ''}`);
  if (failed.length > 10) lines.push(`… and ${failed.length - 10} more`);
  const body = ['The following tasks failed:', '', ...lines, '', 'Details are in the task history of the WebManager.'].join('\n');
  await deliver(failed.length === 1 ? 'Task failed' : `${failed.length} tasks failed`, body, { s, kind: 'error' });
  await q('REPLACE INTO settings (k, v) VALUES (?, ?)', [key, cursor]);
}

async function checkSystem(s) {
  if (s.notify_disk !== '1' && s.notify_backup !== '1') return;
  const sys = await agent.call('GET', '/v1/system', undefined, { timeoutMs: 30000 });
  if (s.notify_disk === '1') {
    const limit = Math.min(Math.max(parseInt(s.notify_disk_percent || '90', 10) || 90, 50), 99);
    const used = diskUsedPercent(sys.disk);
    if (used !== null && used >= limit && await due('notified:disk', DAY_MS)) {
      const free = Math.round(sys.disk.freeBytes / 1048576);
      await deliver('Disk space is running low', `The disk of the WebManager is ${used} % full (limit: ${limit} %). ${free} MB are still free.
Clean up: System & settings → Storage (old images, update backups, dumps, logs, trash) or remove old backups, logs or website files.`, { s, kind: 'warn', facts: [['Used', `${used} %`], ['Free', `${free} MB`]] });
      await mark('notified:disk');
    }
  }
  if (s.notify_backup === '1') {
    const prob = backupProblem(sys.backup);
    if (prob && await due(`notified:backup:${prob.kind}`, DAY_MS)) {
      await deliver(prob.kind === 'failed' ? 'Backup failed' : 'Backup overdue', `${prob.text}
Details: /var/log/webmanager/backup-*.log on the server.`, { s, kind: prob.kind === 'failed' ? 'error' : 'warn' });
      await mark(`notified:backup:${prob.kind}`);
    }
    for (const p of remoteBackupProblems(sys.backupRemote)) {
      if (!(await due(`notified:backup:${p.kind}`, DAY_MS))) continue;
      await deliver(p.kind === 'verify_failed' ? 'Restore test failed' : 'External backup target: problem', `${p.text}\nDetails: System & settings → Backups in the WebManager.`, { s, kind: 'error' });
      await mark(`notified:backup:${p.kind}`);
    }
  }
}

const memState = new Map();
const restartSeen = new Map();

/** Memory pressure, restarts after memory exhaustion and websites that outgrow a disk limit. */
async function checkResources(s) {
  if (s.notify_resources === '0') return;
  const limit = Math.min(Math.max(parseInt(s.notify_mem_percent || '90', 10) || 90, 50), 99);
  const diskGb = Math.max(parseFloat(s.notify_site_disk_gb || '0') || 0, 0);
  const sites = await q("SELECT id, name, memory_mb FROM sites WHERE lifecycle = 'ready' AND desired_state = 'running'");
  if (!sites.length) return;
  const ids = sites.map((x) => x.id).join(',');
  const [{ statuses }, { stats }] = await Promise.all([
    agent.call('GET', '/v1/statuses', undefined, { timeoutMs: 20000 }),
    agent.call('GET', `/v1/stats?ids=${ids}`, undefined, { timeoutMs: 40000 }),
  ]);
  for (const site of sites) {
    const st = statuses[String(site.id)];
    const ss = stats[String(site.id)];
    // restarts (the restart counter of the container; remembered across worker restarts)
    if (st && Number.isInteger(st.restartCount)) {
      let prev = restartSeen.get(site.id);
      if (prev === undefined) {
        const [row] = await q('SELECT v FROM settings WHERE k = ?', [`res:restarts:${site.id}`]);
        prev = row ? parseInt(row.v, 10) : undefined;
      }
      const ev = resources.restartEvent(prev, st);
      if (prev !== st.restartCount) await q('REPLACE INTO settings (k, v) VALUES (?, ?)', [`res:restarts:${site.id}`, String(st.restartCount)]);
      restartSeen.set(site.id, st.restartCount);
      if (ev && !muted(site.id) && await due(`notified:restart:${site.id}`, 3600 * 1000)) {
        await deliver(ev.oom ? `Website “${site.name}” ran out of memory` : `Website “${site.name}” was restarted`,
          ev.oom
            ? `The container was stopped because it used more memory than its limit (${site.memory_mb} MB) and was started again.\nRaise the memory limit under Settings, or check the application for a memory leak.`
            : `The container restarted ${ev.restarts} time(s) since the last check. The log shows why (Operations → Logs).`,
          { s, kind: 'warn', facts: [['Website', site.name], ['ID', slug(site.id)], ['Memory limit', `${site.memory_mb} MB`], ['Restarts', String(ev.restarts)]] });
        await mark(`notified:restart:${site.id}`);
      }
    }
    // memory close to the limit for several minutes
    if (ss && Number.isFinite(ss.memPercent)) {
      const res = resources.pressure(memState.get(site.id), ss.memPercent, limit);
      memState.set(site.id, res.state);
      if (res.event === 'high' && !muted(site.id) && await due(`notified:mem:${site.id}`, 6 * 3600 * 1000)) {
        await deliver(`Website “${site.name}” is running out of memory`,
          `The website has used ${Math.round(ss.memPercent)} % of its memory limit (${site.memory_mb} MB) for several minutes. At the limit the container is stopped and restarted.\nRaise the limit under Settings if this is normal load.`,
          { s, kind: 'warn', facts: [['Website', site.name], ['ID', slug(site.id)], ['Used', `${Math.round(ss.memBytes / 1048576)} MB of ${site.memory_mb} MB`]] });
        await mark(`notified:mem:${site.id}`);
      }
    }
  }
  if (diskGb > 0) {
    const rows = await q('SELECT d.site_id, d.bytes, x.name FROM site_disk d JOIN sites x ON x.id = d.site_id WHERE d.day = (SELECT MAX(day) FROM site_disk WHERE site_id = d.site_id)');
    for (const r of rows) {
      if (muted(r.site_id) || Number(r.bytes) < diskGb * 1073741824 || !(await due(`notified:sitedisk:${r.site_id}`, 7 * DAY_MS))) continue;
      await deliver(`Website “${r.name}” uses a lot of disk space`,
        `The files, logs and database of the website take up ${(Number(r.bytes) / 1073741824).toFixed(1)} GB (your limit: ${diskGb} GB).\nClean up under Content → Files, or check the logs.`,
        { s, kind: 'warn', facts: [['Website', r.name], ['ID', slug(r.site_id)], ['Used', `${(Number(r.bytes) / 1073741824).toFixed(1)} GB`]] });
      await mark(`notified:sitedisk:${r.site_id}`);
    }
  }
}

/**
 * Detects a wave of automatic bans (pure): `protection` is the agent's /v1/protection answer. Returns null or { count, flood, errors, sample }
 * when at least `threshold` addresses were banned within the last 15 minutes.
 */
function banWave(protection, now, threshold) {
  const min = protection && protection.config && protection.config.autoBan ? protection.config.autoBan.banMinutes : 60;
  const fresh = ((protection && protection.bans) || []).filter((b) => {
    const start = b.since ? Date.parse(b.since) : Date.parse(b.until) - min * 60000;
    return !Number.isNaN(start) && now - start <= BAN_WINDOW_MS;
  });
  if (!fresh.length || fresh.length < threshold) return null;
  const errors = fresh.filter((b) => /erroneous/.test(b.reason || '')).length;
  return { count: fresh.length, flood: fresh.length - errors, errors, sample: fresh.slice(0, 5).map((b) => b.ip) };
}

async function checkBans(s) {
  if (s.notify_bans !== '1') return;
  const threshold = Math.min(Math.max(parseInt(s.notify_bans_threshold || '10', 10) || 10, 2), 1000);
  const prot = await agent.call('GET', '/v1/protection', undefined, { timeoutMs: 20000 });
  const wave = banWave(prot, Date.now(), threshold);
  if (!wave || !(await due('notified:bans', BAN_REMINDER_MS))) return;
  await deliver(`${wave.count} addresses banned automatically`,
    `The flood protection banned ${wave.count} addresses within the last 15 minutes. This usually means an attack or a misbehaving crawler.\nBans and the current settings: Protection in the WebManager.`,
    { s, kind: 'warn', facts: [['Banned', String(wave.count)], ['Too many requests', String(wave.flood)], ['Too many errors', String(wave.errors)], ['Examples', wave.sample.join(', ')]] });
  await mark('notified:bans');
}

/** One monitoring pass; never throws (a broken mail server must not stop the worker). */
async function tick() {
  let s;
  try { s = await settings(); } catch (_) { return; }
  if (s.notify_enabled !== '1') return;
  try { mute = await maintenance.load(); } catch (_) { mute = null; } // if the windows cannot be read, notifications are not held back
  // checks that are not about one website stay quiet only while a window for everything is active
  const general = new Set([checkCerts, checkSystem, checkUpdates, checkBans]);
  for (const fn of [checkSites, checkCerts, checkJobs, checkSystem, checkUpdates, checkBans, checkResources]) {
    if (general.has(fn) && muted(null)) continue;
    try { await fn(s); } catch (e) { process.stderr.write(`[worker] notify ${fn.name}: ${e.message}\n`); }
  }
}

module.exports = { deliver, emailReady, activeChannels, banWave, loginText, loginFacts, browserOf, sendMail, settings, recipients, evaluate, siteIsDown, diskUsedPercent, backupProblem, remoteBackupProblems, updateMails, tick };
