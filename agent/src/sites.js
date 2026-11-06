'use strict';
const fs = require('fs');
const { execFile } = require('child_process');
const path = require('path');
const { config, loadRuntimes } = require('./config');
const { docker, dockerOk, dockerStream } = require('./docker');
const { audit } = require('./audit');
const proxy = require('./proxy');
const geo = require('./geo');
const waf = require('./waf');
const database = require('./database');
const { validateSpec, containerHash, siteName, ValidationError } = require('./validate');

const NET_POOL = process.env.SITE_NET_POOL || '10.210';
const CONFIG_REV = 'r1';

const names = (id) => ({
  site: siteName(id),
  container: `wm-${siteName(id)}`,
  network: `wm-net-${String(id).padStart(3, '0')}`,
  dir: path.join(config.SITES_DIR, siteName(id)),
  uid: config.uidBase + id,
});

const paths = (id) => {
  const n = names(id);
  return {
    ...n,
    files: path.join(n.dir, 'files'),
    logs: path.join(n.dir, 'logs'),
    cfg: path.join(n.dir, 'config'),
    mount: path.join(n.dir, 'config', 'mount'),
    envFile: path.join(n.dir, 'config', 'env'),
    specFile: path.join(n.dir, 'config', 'spec.json'),
  };
};

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function loadSpec(id) {
  try { return JSON.parse(fs.readFileSync(paths(id).specFile, 'utf8')); } catch (_) { return null; }
}

function listSiteIds() {
  try {
    return fs.readdirSync(config.SITES_DIR)
      .map((n) => /^site-(\d{3,5})$/.exec(n))
      .filter(Boolean)
      .map((m) => parseInt(m[1], 10))
      .sort((a, b) => a - b);
  } catch (_) { return []; }
}

function ensureDirs(id) {
  const p = paths(id);
  fs.mkdirSync(config.SITES_DIR, { recursive: true, mode: 0o755 });
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o755 });
  for (const d of [p.files, p.logs]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o750 });
    fs.chownSync(d, p.uid, p.uid);
    fs.chmodSync(d, 0o750);
  }
  fs.mkdirSync(p.cfg, { recursive: true, mode: 0o700 });
  fs.chmodSync(p.cfg, 0o700);
  fs.mkdirSync(p.mount, { recursive: true, mode: 0o755 });
  fs.chmodSync(p.mount, 0o755);
}

function renderSiteNginx(spec, rt) {
  if (spec.webserverConf) return spec.webserverConf.endsWith('\n') ? spec.webserverConf : `${spec.webserverConf}\n`;
  const file = rt.kind === 'php' ? 'php.nginx.conf' : 'static.nginx.conf';
  const t = fs.readFileSync(path.join(config.TEMPLATES_DIR, 'site', file), 'utf8');
  return t.replace(/\{\{APP_RULES\}\}/g, '').replace(/\{\{DOCROOT\}\}/g, spec.docroot);
}

/** Runs `nginx -t` for a custom config in a network-less throwaway container, so a broken file never reaches the site. */
async function testSiteNginx(spec, rt, content) {
  const p = paths(spec.id);
  const dir = path.join(p.cfg, 'nginx-test');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'nginx.conf'), content, { mode: 0o644 });
  try {
    const r = await docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--user', `${p.uid}:${p.uid}`, '--memory', '128m', '--pids-limit', '64',
      '--tmpfs', '/tmp:rw,nosuid,size=16m,mode=1777', '--tmpfs', '/var/log/site:rw,nosuid,size=4m,mode=1777',
      '-v', `${dir}:/etc/site:ro`, '-v', `${p.files}:${rt.mountFiles || '/app'}:ro`,
      '--entrypoint', 'nginx', rt.image, '-e', 'stderr', '-t', '-c', '/etc/site/nginx.conf'], { timeout: 30000 });
    if (r.code !== 0) {
      throw httpError(422, `Web server configuration rejected: ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function buildEnv(spec, rt) {
  const env = {};
  if (rt.kind === 'node') Object.assign(env, { NODE_ENV: 'production', HOST: '0.0.0.0', HOSTNAME: '0.0.0.0' });
  if (rt.kind === 'generic') Object.assign(env, { HOST: '0.0.0.0' });
  Object.assign(env, database.envFor(spec.database, spec.id));
  Object.assign(env, spec.env);
  if (rt.kind === 'node' || rt.kind === 'generic') env.PORT = String(spec.internalPort);
  env.TZ = env.TZ || process.env.TZ || 'UTC';
  return env;
}

function writeEnvFile(id, env) {
  const p = paths(id);
  const body = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.writeFileSync(p.envFile, body, { mode: 0o600 });
  fs.chmodSync(p.envFile, 0o600);
}

function subnetFor(id) {
  const idx = id - 1;
  if (idx >= 2048) throw httpError(422, 'Maximum number of website networks reached (extend SITE_NET_POOL)');
  return `${NET_POOL}.${Math.floor(idx / 8)}.${(idx % 8) * 32}/27`;
}

async function ensureNetwork(id) {
  const n = names(id);
  const r = await docker(['network', 'inspect', n.network]);
  if (r.code !== 0) {
    await dockerOk(['network', 'create', '--driver', 'bridge', '--subnet', subnetFor(id),
      '--label', 'drimzo.managed=true', '--label', `drimzo.site=${id}`, n.network]);
  }
  await attachProxy(id);
}

async function attachProxy(id) {
  const n = names(id);
  const insp = await docker(['inspect', '-f', '{{json .NetworkSettings.Networks}}', config.proxyContainer]);
  if (insp.code !== 0) return false; // proxy not running yet; the reconcile loop retries
  let nets = {};
  try { nets = JSON.parse(insp.stdout); } catch (_) { /* ignore */ }
  if (nets[n.network]) return true;
  const r = await docker(['network', 'connect', n.network, config.proxyContainer]);
  return r.code === 0 || /already exists/.test(r.stderr);
}

/** --build-arg list from the runtime template (keys/values are validated; templates/runtimes.json is root-owned). */
function buildArgs(rt) {
  const out = [];
  for (const [k, v] of Object.entries(rt.buildArgs || {})) {
    if (!/^[A-Z][A-Z0-9_]{0,40}$/.test(k) || !/^[a-z0-9][a-z0-9._:\/-]{0,150}$/.test(String(v))) throw httpError(500, 'Invalid build argument in the runtime template');
    out.push('--build-arg', `${k}=${v}`);
  }
  return out;
}

async function ensureImage(rt, emit) {
  const ref = rt.digest ? `${rt.image.split(':')[0]}@${rt.digest}` : rt.image;
  const r = await docker(['image', 'inspect', ref]);
  if (r.code === 0) return;
  if (rt.build) {
    const ctx = path.join(config.RUNTIME_CTX_DIR, String(rt.build));
    if (!/^[a-z0-9-]+$/.test(String(rt.build)) || !fs.existsSync(path.join(ctx, 'Dockerfile'))) {
      throw httpError(500, 'Build context of the runtime template is missing');
    }
    audit('image.build', { image: rt.image });
    if (emit) {
      emit(`Building runtime image ${rt.image} (once, 3–15 minutes depending on the server) …`);
      const code = await dockerStream(['build', '--pull', ...buildArgs(rt), '-t', rt.image, ctx], emit, { timeoutSec: 2400 });
      if (code !== 0) throw httpError(502, `Image build failed (exit code ${code})`);
      emit('Image built.');
    } else {
      await dockerOk(['build', '--pull', ...buildArgs(rt), '-t', rt.image, ctx], { timeout: 2_400_000 });
    }
  } else {
    audit('image.pull', { image: ref });
    if (emit) {
      emit(`Pulling image ${ref} …`);
      const code = await dockerStream(['pull', ref], emit, { timeoutSec: 1800 });
      if (code !== 0) throw httpError(502, `Image could not be pulled (exit code ${code})`);
    } else {
      await dockerOk(['pull', ref], { timeout: 1_800_000 });
    }
  }
}

function healthCmd(spec, rt) {
  if (rt.kind === 'static' || rt.kind === 'php') return 'wget -q -T 3 -O /dev/null http://127.0.0.1:8080/_wm_health';
  if (rt.health) return rt.health.replace(/\{\{PORT\}\}/g, String(spec.internalPort));
  return null;
}

function defaultStart(spec, rt) {
  if (spec.startCommand) return spec.startCommand;
  if (rt.kind === 'node') return 'npm start';
  throw new ValidationError('A start command is required for this application');
}

function containerArgs(spec, rt, hash, startCmd) {
  const p = paths(spec.id);
  const mem = `${spec.memoryMb}m`;
  const args = [
    'create', '--name', p.container, '--hostname', p.site,
    '--network', p.network,
    '--restart', spec.autostart ? 'unless-stopped' : 'no',
    '--user', `${p.uid}:${p.uid}`,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', String(spec.pids), '--memory', mem, '--memory-swap', mem, '--cpus', String(spec.cpus),
    '--ulimit', 'nofile=8192:8192', '--init',
    '--tmpfs', '/tmp:rw,nosuid,size=256m,mode=1777',
    '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
    '--label', 'drimzo.managed=true', '--label', `drimzo.site=${spec.id}`, '--label', `drimzo.hash=${hash}`,
    '--env-file', p.envFile,
  ];
  const mountFiles = rt.mountFiles || '/app';
  args.push('-v', `${p.files}:${mountFiles}${rt.filesReadOnly ? ':ro' : ''}`);
  const hc = healthCmd(spec, rt);
  if (hc) {
    args.push('--health-cmd', hc, '--health-interval', '30s', '--health-timeout', '5s',
      '--health-retries', '3', '--health-start-period', '30s');
  }
  let cmd = [];
  if (rt.kind === 'static' || rt.kind === 'php') {
    args.push('-v', `${p.logs}:/var/log/site`, '-v', `${p.mount}:/etc/site:ro`);
    if (rt.kind === 'static') cmd = ['nginx', '-e', 'stderr', '-c', '/etc/site/nginx.conf', '-g', 'daemon off;'];
  } else {
    args.push('-w', rt.workdir || '/app');
    args.push('-v', `${p.logs}:/var/log/site`);
    cmd = ['sh', '-c', startCmd];
  }
  args.push(rt.image, ...cmd);
  return args;
}

async function inspectContainer(id) {
  const r = await docker(['inspect', names(id).container]);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout)[0]; } catch (_) { return null; }
}

function vhostFile(id) { return `${siteName(id)}.conf`; }

async function syncVhost(spec) {
  const n = names(spec.id);
  if (!spec.domains.length) {
    geo.writeSiteMap(n.site, 'off', []);
    return proxy.removeVhost(vhostFile(spec.id));
  }
  const wafOn = (spec.wafMode || 'off') !== 'off' && (spec.wafCategories || []).length > 0;
  if (wafOn) await proxy.installVhost(waf.RULES_FILE, waf.renderRules()); // shared maps first, the vhost refers to them
  const geoMap = geo.writeSiteMap(n.site, spec.geoMode || 'off', spec.geoCountries || []);
  const content = proxy.renderVhost({
    name: n.site, domains: spec.domains, upstream: `${n.container}:${spec.internalPort}`, tls: proxy.certExists(n.site),
    gate: !!spec.gate, bypass: spec.gateBypass || [], maintenance: !!spec.maintenance, allowIps: spec.maintenanceAllow || [],
    ipAllow: spec.ipAllow || [], ipDeny: spec.ipDeny || [], rateRps: spec.rateRps || 0, rateBurst: spec.rateBurst || 0, connLimit: spec.connLimit || 0, geoMap,
    secHeaders: spec.secHeaders || null,
    wafConf: wafOn ? { mode: spec.wafMode, categories: spec.wafCategories, exempt: spec.wafExempt || [] } : null,
  });
  return proxy.installVhost(vhostFile(spec.id), content);
}

/** Idempotent: brings directories, config, network, container and proxy route in line with the spec. */
async function applySite(raw, { start = 'keep' } = {}) {
  const runtimes = loadRuntimes();
  const spec = validateSpec(raw, runtimes);
  const rt = runtimes.runtimes[spec.runtime];
  const startCmd = rt.kind === 'static' || rt.kind === 'php' ? '' : defaultStart(spec, rt);
  const p = paths(spec.id);

  ensureDirs(spec.id);
  fs.writeFileSync(p.specFile, JSON.stringify(spec, null, 2), { mode: 0o600 });
  writeEnvFile(spec.id, buildEnv(spec, rt));
  if (rt.kind === 'static' || rt.kind === 'php') {
    const conf = renderSiteNginx(spec, rt);
    if (spec.webserverConf) await testSiteNginx(spec, rt, conf);
    fs.writeFileSync(path.join(p.mount, 'nginx.conf'), conf, { mode: 0o644 });
  } else if (spec.webserverConf) {
    throw httpError(422, 'There is no web server configuration for this website type');
  }
  await ensureNetwork(spec.id);
  // the database (only when switched on) must be up before the website that connects to it
  if (spec.database) await database.ensure(spec, { id: spec.id, network: p.network, dir: p.dir, cfg: p.cfg });
  else await database.removeIfPresent(spec.id);
  await ensureImage(rt);

  const hash = containerHash(spec, runtimes, CONFIG_REV + startCmd);
  const existing = await inspectContainer(spec.id);
  let wasRunning = false;
  let created = false;
  if (existing && existing.Config.Labels['drimzo.hash'] === hash) {
    wasRunning = existing.State.Running;
    // restart policy may have changed
    await docker(['update', '--restart', spec.autostart ? 'unless-stopped' : 'no', p.container]);
  } else {
    if (existing) {
      wasRunning = existing.State.Running;
      await docker(['rm', '-f', p.container]);
    }
    await dockerOk(containerArgs(spec, rt, hash, startCmd));
    created = true;
  }

  const shouldStart = start === true || start === 'start' || (start === 'keep' && wasRunning);
  if (shouldStart) {
    const r = await docker(['start', p.container]);
    if (r.code !== 0) throw httpError(502, `Container could not be started: ${r.stderr.trim().slice(0, 300)}`);
  }
  await syncVhost(spec);
  audit('site.apply', { site: p.site, created, started: shouldStart });
  return { created, started: shouldStart, name: p.container };
}

function run(cmd, args, timeout, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 1 << 20, ...opts }, (err, stdout, stderr) => {
      if (err) reject(httpError(502, `${cmd} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

/**
 * Copies the project files of one site into another (symlinks are copied as links, never followed).
 * The copy runs with the uid of the SOURCE site into a private staging directory, so even a source tree that is
 * manipulated while it is being copied (symlink swaps) cannot make the agent read or write anything the site itself
 * could not. Only the finished copy is handed to the target site, as root, without following links.
 */
async function cloneFiles(srcId, dstId) {
  if (srcId === dstId) throw httpError(422, 'Source and target are identical');
  const s = paths(srcId);
  const d = paths(dstId);
  if (!fs.existsSync(s.files)) throw httpError(404, 'The source website has no file directory');
  ensureDirs(dstId);
  const stage = fs.mkdtempSync(path.join(d.dir, '.clone-'));
  try {
    fs.chownSync(stage, s.uid, s.uid);
    fs.chmodSync(stage, 0o700);
    await run('cp', ['-a', `${s.files}/.`, `${stage}/`], 30 * 60 * 1000, { uid: s.uid, gid: s.uid, cwd: '/' });
    await run('chown', ['-R', '-h', `${d.uid}:${d.uid}`, stage], 10 * 60 * 1000);
    for (const name of fs.readdirSync(stage)) {
      const target = path.join(d.files, name);
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(path.join(stage, name), target);
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  audit('site.clone_files', { from: s.site, to: d.site });
  return { ok: true };
}

async function siteAction(id, action) {
  const p = paths(id);
  const spec = loadSpec(id);
  if (!spec) throw httpError(404, 'Website is not known to the agent');
  const insp = await inspectContainer(id);
  if (!insp) throw httpError(409, 'Container does not exist – please run “Apply” first');
  let r;
  switch (action) {
    case 'start': await attachProxy(id); r = await docker(['start', p.container]); break;
    case 'stop': r = await docker(['stop', '-t', '20', p.container], { timeout: 60000 }); break;
    case 'restart': await attachProxy(id); r = await docker(['restart', '-t', '20', p.container], { timeout: 90000 }); break;
    default: throw new ValidationError('Unknown action');
  }
  audit('site.action', { site: p.site, action, code: r.code });
  if (r.code !== 0) throw httpError(502, `Action failed: ${r.stderr.trim().slice(0, 300)}`);
  return { ok: true };
}

async function deleteSite(id, { purge = false } = {}) {
  const p = paths(id);
  await docker(['rm', '-f', p.container], { timeout: 60000 });
  await database.remove(id);
  // kill leftovers of build/install jobs of this site
  const jobs = await docker(['ps', '-aq', '--filter', `label=drimzo.job-site=${id}`]);
  for (const cid of jobs.stdout.split('\n').filter(Boolean)) await docker(['rm', '-f', cid]);
  await proxy.removeVhost(vhostFile(id));
  await docker(['network', 'disconnect', '-f', p.network, config.proxyContainer]);
  await docker(['network', 'rm', p.network]);
  let location = null;
  if (fs.existsSync(p.dir)) {
    if (purge) {
      fs.rmSync(p.dir, { recursive: true, force: true });
    } else {
      fs.mkdirSync(config.TRASH_DIR, { recursive: true, mode: 0o700 });
      location = path.join(config.TRASH_DIR, `${p.site}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      fs.renameSync(p.dir, location);
      fs.chmodSync(location, 0o700);
    }
  }
  audit('site.delete', { site: p.site, purge, trash: location });
  return { ok: true, trash: location ? path.basename(location) : null };
}

async function siteStatus(id) {
  const p = paths(id);
  const insp = await inspectContainer(id);
  const spec = loadSpec(id);
  if (!insp) return { exists: false, state: spec ? 'missing' : 'unknown', health: null, vhost: false };
  const st = insp.State;
  let state = st.Status; // created, running, paused, restarting, exited, dead
  if (st.Restarting) state = 'restarting';
  const nets = Object.keys(insp.NetworkSettings.Networks || {});
  return {
    exists: true,
    state,
    running: st.Running,
    health: st.Health ? st.Health.Status : null,
    exitCode: st.ExitCode,
    oomKilled: st.OOMKilled,
    startedAt: st.StartedAt,
    finishedAt: st.FinishedAt,
    restartCount: insp.RestartCount,
    image: insp.Config.Image,
    network: nets.includes(p.network),
    vhost: fs.existsSync(path.join(config.PROXY_CONF_DIR, vhostFile(id))),
    tls: proxy.certExists(p.site),
    error: st.Error || null,
  };
}

async function siteLogs(id, tail = 200) {
  const n = Math.min(Math.max(parseInt(tail, 10) || 200, 1), 2000);
  const r = await docker(['logs', '--tail', String(n), '--timestamps', names(id).container], { timeout: 30000 });
  if (r.code !== 0 && /No such container/i.test(r.stderr)) throw httpError(404, 'Container does not exist');
  return (r.stdout + r.stderr).split('\n').slice(-n - 1).join('\n');
}

function parseSize(s) {
  const m = /^([\d.]+)\s*([KMGT]?i?B)/i.exec(String(s || '').trim());
  if (!m) return 0;
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1048576, GIB: 1073741824, TIB: 1099511627776 };
  return Math.round(parseFloat(m[1]) * (mult[m[2].toUpperCase()] || 1));
}

async function stats(ids) {
  const targets = ids.map((i) => names(i).container);
  if (!targets.length) return {};
  const r = await docker(['stats', '--no-stream', '--format', '{{json .}}', ...targets], { timeout: 30000 });
  const out = {};
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    try {
      const j = JSON.parse(line);
      const m = /^wm-site-(\d+)$/.exec(j.Name);
      if (!m) continue;
      const [used, limit] = String(j.MemUsage).split('/');
      out[parseInt(m[1], 10)] = {
        cpuPercent: parseFloat(String(j.CPUPerc).replace('%', '')) || 0,
        memBytes: parseSize(used), memLimitBytes: parseSize(limit), memPercent: parseFloat(String(j.MemPerc).replace('%', '')) || 0,
        pids: parseInt(j.PIDs, 10) || 0, net: j.NetIO, block: j.BlockIO,
      };
    } catch (_) { /* ignore */ }
  }
  return out;
}

/** Rebuilds the vhost of every website with a country rule (after the country data was refreshed). */
async function refreshGeoSites() {
  const done = [];
  for (const id of listSiteIds()) {
    const spec = loadSpec(id);
    if (!spec || !spec.geoMode || spec.geoMode === 'off' || !spec.domains.length) continue;
    await syncVhost(spec);
    done.push(id);
  }
  return done;
}

/** Re-attaches the proxy to all site networks (needed after the proxy container was re-created). */
async function reconcileNetworks() {
  const fixed = [];
  for (const id of listSiteIds()) {
    if (!loadSpec(id)) continue;
    const had = await docker(['network', 'inspect', names(id).network]);
    if (had.code !== 0) continue;
    if (await attachProxy(id)) fixed.push(id);
  }
  return fixed;
}

/** Rotates logs/ files with copy-truncate once they exceed 20 MB. */
function rotateLogs() {
  for (const id of listSiteIds()) {
    const dir = paths(id).logs;
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of entries) {
      if (!/^[\w.-]+\.log$/.test(f)) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.lstatSync(full);
        if (!st.isFile() || st.size < 20 * 1024 * 1024) continue;
        fs.copyFileSync(full, `${full}.1`);
        fs.chownSync(`${full}.1`, st.uid, st.gid);
        fs.truncateSync(full, 0);
      } catch (_) { /* ignore */ }
    }
  }
}

module.exports = {
  cloneFiles, refreshGeoSites, database, names, paths, loadSpec, listSiteIds, applySite, siteAction, deleteSite, siteStatus, siteLogs, stats,
  reconcileNetworks, rotateLogs, syncVhost, attachProxy, ensureImage, buildEnv, httpError, vhostFile, subnetFor,
};
