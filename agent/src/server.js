'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { config, loadRuntimes } = require('./config');
const { docker } = require('./docker');
const { audit } = require('./audit');
const sites = require('./sites');
const geo = require('./geo');
const protect = require('./protect');
const probe = require('./probe');
const consoleSvc = require('./console');
const proxylog = require('./proxylog');
const metrics = require('./metrics');
const database = require('./database');
const certs = require('./certs');
const dnsFiles = require('./dns');
const update = require('./update');
const backupctl = require('./backupctl');
const storage = require('./storage');
const jobs = require('./jobs');
const { fsJson, fsDownload, fsArchive } = require('./fsops');
const { parseSiteId, ValidationError, domain: normDomain } = require('./validate');

const routes = [];
/** scope: 'read' | 'files' (dashboard + worker) | 'admin' (worker only) */
function route(method, pattern, scope, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, scope, handler });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function authenticate(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return null;
  if (safeEqual(m[1], config.tokens.worker)) return 'worker';
  if (safeEqual(m[1], config.tokens.dashboard)) return 'dashboard';
  return null;
}

const failures = new Map();
function tooManyFailures(ip) {
  const now = Date.now();
  const rec = (failures.get(ip) || []).filter((t) => now - t < 60000);
  failures.set(ip, rec);
  return rec.length >= 20;
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(new ValidationError('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function startStream(res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  return (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };
}

const qpath = (q) => q.get('path') || '';

// ---------------------------------------------------------------- read-only routes
route('GET', '/v1/system', 'read', async () => {
  const info = await docker(['info', '--format', '{{json .}}'], { timeout: 15000 });
  let d = {};
  try { d = JSON.parse(info.stdout); } catch (_) { /* ignore */ }
  let disk = null;
  try {
    const s = fs.statfsSync(config.DATA_DIR);
    disk = { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
  } catch (_) { /* ignore */ }
  let backup = null;
  try { backup = JSON.parse(fs.readFileSync(path.join(config.DATA_DIR, 'backup-status.json'), 'utf8')); } catch (_) { /* no backup configured yet */ }
  const ps = await docker(['ps', '-a', '--filter', 'label=com.docker.compose.project=webmanager', '--format', '{{json .}}']);
  const services = ps.stdout.split('\n').filter(Boolean).map((l) => { try { const j = JSON.parse(l); return { name: j.Names, state: j.State, status: j.Status }; } catch (_) { return null; } }).filter(Boolean);
  return {
    version: config.version,
    docker: { ok: info.code === 0, version: d.ServerVersion, containers: d.Containers, running: d.ContainersRunning, images: d.Images, os: d.OperatingSystem, arch: d.Architecture },
    host: { load: os.loadavg(), memTotal: d.MemTotal || os.totalmem(), cpus: d.NCPU || os.cpus().length, uptimeSec: os.uptime() },
    disk,
    backup,
    backupRemote: backupctl.summary(),
    services,
    runtimes: Object.entries(loadRuntimes().runtimes).map(([key, v]) => ({ key, label: v.label, types: v.types, fixedPort: v.fixedPort || null, kind: v.kind, image: v.image })),
    dashboardDomain: certs.getDashboardDomain(),
    dashboardCert: certs.certInfo('dashboard'),
    acmeStaging: config.acmeStaging,
  };
});

route('GET', '/v1/geo', 'read', async () => geo.status());
route('GET', '/v1/update', 'read', async () => update.status());
route('GET', '/v1/backup', 'read', async () => backupctl.status());
route('GET', '/v1/storage', 'read', async () => storage.plan());
route('GET', '/v1/storage/sites', 'read', async () => storage.sitesUsage());
route('GET', '/v1/sites/:id/metrics', 'files', async (ctx) => metrics.query(parseSiteId(ctx.params.id), ctx.query.get('range') || '24h'));
route('GET', '/v1/sites/:id/report', 'files', async (ctx) => metrics.report(parseSiteId(ctx.params.id), 7));
route('GET', '/v1/sites/:id/database', 'files', async (ctx) => {
  const id = parseSiteId(ctx.params.id);
  return { ...(await database.status(id)), admin: await database.adminStatus(id), dumps: database.listDumps(sites.paths(id).dir) };
});
route('GET', '/v1/sites/:id/database/dumps/:name', 'files', async (ctx) => {
  const f = database.dumpPath(sites.paths(parseSiteId(ctx.params.id)).dir, ctx.params.name);
  ctx.res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': fs.statSync(f).size, 'Content-Disposition': `attachment; filename="${ctx.params.name}"`, 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(f).pipe(ctx.res);
  return undefined;
});
route('DELETE', '/v1/sites/:id/database/dumps/:name', 'files', async (ctx) => database.deleteDump(sites.paths(parseSiteId(ctx.params.id)).dir, ctx.params.name));
route('GET', '/v1/protection', 'read', async () => protect.status());

route('GET', '/v1/stats', 'read', async (ctx) => {
  const ids = (ctx.query.get('ids') || '').split(',').filter(Boolean).map((s) => parseSiteId(s));
  return { stats: await sites.stats(ids.length ? ids : sites.listSiteIds()) };
});

route('GET', '/v1/statuses', 'read', async () => {
  const out = {};
  for (const id of sites.listSiteIds()) out[id] = await sites.siteStatus(id);
  return { statuses: out };
});
route('GET', '/v1/probe', 'read', async (ctx) => {
  const ids = String(ctx.query.get('ids') || '').split(',').map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0);
  return { results: await probe.probeSites(ids) };
});
route('GET', '/v1/sites/:id/status', 'read', async (ctx) => sites.siteStatus(parseSiteId(ctx.params.id)));
route('GET', '/v1/sites/:id/logs', 'read', async (ctx) => ({ log: await sites.siteLogs(parseSiteId(ctx.params.id), ctx.query.get('tail')) }));
route('GET', '/v1/sites/:id/applog', 'files', async (ctx) => {
  const name = ctx.query.get('name') || 'access.log';
  if (!/^[\w.-]{1,60}\.log(\.1)?$/.test(name)) throw new ValidationError('Invalid log name');
  try {
    const r = await fsJson(parseSiteId(ctx.params.id), 'logs', 'tail', { rel: name, lines: parseInt(ctx.query.get('lines') || '200', 10) });
    return { log: r.content };
  } catch (e) {
    if (/does not exist/.test(e.message)) return { log: '' };
    throw e;
  }
});

route('GET', '/v1/certs/:name', 'read', async (ctx) => certs.certInfo(ctx.params.name));
route('GET', '/v1/dns', 'read', async () => dnsFiles.status());
route('POST', '/v1/certs/dns', 'read', async (ctx) => {
  const list = Array.isArray(ctx.body.domains) ? ctx.body.domains.slice(0, 20) : [];
  const out = [];
  for (const d of list) out.push(await certs.dnsDiag(d));
  return { results: out };
});
route('POST', '/v1/certs/verify', 'read', async (ctx) => certs.verifyServed(normDomain(ctx.body.domain, true)));
route('GET', '/v1/dashboard', 'read', async () => ({ domain: certs.getDashboardDomain(), cert: certs.certInfo('dashboard') }));

// ---------------------------------------------------------------- file manager (confined to a site's files/)
route('GET', '/v1/sites/:id/fs/list', 'files', (ctx) => fsJson(parseSiteId(ctx.params.id), 'files', 'list', { rel: qpath(ctx.query) }));
route('GET', '/v1/sites/:id/fs/read', 'files', (ctx) => fsJson(parseSiteId(ctx.params.id), 'files', 'read', { rel: qpath(ctx.query) }));
route('PUT', '/v1/sites/:id/fs/write', 'files', (ctx) => fsJson(parseSiteId(ctx.params.id), 'files', 'write', { rel: qpath(ctx.query) }, ctx.req));
route('PUT', '/v1/sites/:id/fs/upload', 'files', (ctx) => fsJson(parseSiteId(ctx.params.id), 'files', 'upload', { rel: qpath(ctx.query) }, ctx.req));
route('POST', '/v1/sites/:id/fs/mkdir', 'files', (ctx) => fsJson(parseSiteId(ctx.params.id), 'files', 'mkdir', { rel: String(ctx.body.path || '') }));
route('POST', '/v1/sites/:id/fs/rename', 'files', (ctx) => fsJson(parseSiteId(ctx.params.id), 'files', 'rename', { rel: String(ctx.body.path || ''), to: String(ctx.body.to || '') }));
route('POST', '/v1/sites/:id/fs/copy', 'files', (ctx) => fsJson(parseSiteId(ctx.params.id), 'files', 'copy', { rel: String(ctx.body.path || ''), to: String(ctx.body.to || '') }));
route('DELETE', '/v1/sites/:id/fs', 'files', async (ctx) => {
  const r = await fsJson(parseSiteId(ctx.params.id), 'files', 'delete', { rel: qpath(ctx.query) });
  audit('fs.delete', { site: ctx.params.id, path: qpath(ctx.query).slice(0, 200), actor: ctx.actor });
  return r;
});
route('POST', '/v1/sites/:id/fs/zip', 'files', async (ctx) => {
  const r = await fsJson(parseSiteId(ctx.params.id), 'files', 'zip', { rel: String(ctx.body.dir || ''), names: ctx.body.names, to: String(ctx.body.to || '') });
  audit('fs.zip', { site: ctx.params.id, dir: String(ctx.body.dir || '').slice(0, 200), to: String(ctx.body.to || '').slice(0, 200), count: Array.isArray(ctx.body.names) ? ctx.body.names.length : 0, actor: ctx.actor });
  return r;
});
route('POST', '/v1/sites/:id/fs/archive', 'files', async (ctx) => {
  fsArchive(parseSiteId(ctx.params.id), 'files', String(ctx.body.dir || ''), ctx.body.names, String(ctx.body.filename || 'archive.zip').replace(/[^\w. -]/g, '_').slice(0, 100), ctx.res);
  return undefined;
});
route('GET', '/v1/sites/:id/fs/download', 'files', async (ctx) => { fsDownload(parseSiteId(ctx.params.id), 'files', qpath(ctx.query), ctx.res); return undefined; });
route('GET', '/v1/sites/:id/package-scripts', 'files', async (ctx) => {
  try {
    const r = await fsJson(parseSiteId(ctx.params.id), 'files', 'read', { rel: 'package.json', max: 512 * 1024 });
    const pkg = JSON.parse(r.content);
    const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? Object.keys(pkg.scripts).filter((k) => /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,99}$/.test(k)) : [];
    return { exists: true, name: typeof pkg.name === 'string' ? pkg.name.slice(0, 100) : null, scripts, hasLock: false };
  } catch (e) {
    return { exists: false, scripts: [] };
  }
});

// ---------------------------------------------------------------- privileged routes (worker only)
route('PUT', '/v1/sites/:id', 'admin', async (ctx) => {
  const id = parseSiteId(ctx.params.id);
  const spec = { ...ctx.body.spec, id };
  const r = await sites.applySite(spec, { start: ctx.body.start === undefined ? 'keep' : ctx.body.start });
  return r;
});
route('POST', '/v1/sites/:id/clone-from', 'admin', async (ctx) => sites.cloneFiles(parseSiteId(ctx.body.source), parseSiteId(ctx.params.id)));
route('PUT', '/v1/protection', 'admin', async (ctx) => protect.setConfig(ctx.body));
route('POST', '/v1/protection/unban', 'admin', async (ctx) => protect.unban(String(ctx.body.ip || '')));
route('POST', '/v1/geo/update', 'admin', async () => {
  const st = await geo.update();
  const sitesUpdated = await sites.refreshGeoSites();
  return { ...st, sitesUpdated };
});
const dbEngine = (id) => {
  const spec = sites.loadSpec(id);
  const engine = spec && spec.database ? spec.database.engine : null;
  if (!engine) throw new ValidationError('No database is active for this website');
  return engine;
};
route('POST', '/v1/sites/:id/database/admin/start', 'admin', async (ctx) => { const id = parseSiteId(ctx.params.id); const p = sites.paths(id); return database.startAdmin(id, { network: p.network, cfg: p.cfg }); });
route('POST', '/v1/sites/:id/database/admin/stop', 'admin', async (ctx) => database.stopAdmin(parseSiteId(ctx.params.id)));
route('POST', '/v1/sites/:id/database/dump', 'admin', async (ctx) => { const id = parseSiteId(ctx.params.id); return database.dump(id, sites.paths(id).dir, dbEngine(id)); });
route('POST', '/v1/sites/:id/database/restore', 'admin', async (ctx) => { const id = parseSiteId(ctx.params.id); return database.restore(id, sites.paths(id).dir, dbEngine(id), String(ctx.body.name || '')); });
route('POST', '/v1/sites/:id/database/password', 'admin', async (ctx) => { const id = parseSiteId(ctx.params.id); return database.setPassword(id, dbEngine(id), String(ctx.body.password || '')); });
route('POST', '/v1/sites/:id/database/purge', 'admin', async (ctx) => { const id = parseSiteId(ctx.params.id); return database.purge(id, sites.paths(id).dir); });
route('POST', '/v1/sites/:id/action', 'admin', async (ctx) => sites.siteAction(parseSiteId(ctx.params.id), String(ctx.body.action)));
route('DELETE', '/v1/sites/:id', 'admin', async (ctx) => sites.deleteSite(parseSiteId(ctx.params.id), { purge: ctx.query.get('purge') === '1' }));
route('POST', '/v1/sites/:id/exec', 'admin', async (ctx) => {
  const id = parseSiteId(ctx.params.id);
  const emit = startStream(ctx.res);
  ctx.streaming = true;
  const aborted = { v: false };
  ctx.res.on('close', () => { if (!ctx.res.writableFinished) { aborted.v = true; if (ctx.body.jobId) jobs.killJob(ctx.body.jobId); } });
  try {
    const code = await jobs.execInSite(id, ctx.body, (line) => emit({ t: 'out', d: line }));
    emit({ t: 'exit', code });
  } catch (e) {
    emit({ t: 'out', d: `Error: ${e.message}` });
    emit({ t: 'exit', code: 126 });
  }
  ctx.res.end();
  return undefined;
});
// Scope 'console': dashboard and worker token. The dashboard only passes it on for administrators (see docs/SECURITY.md).
// By default only the worker token may ask for tickets (the dashboard hands requests over through the database); CONSOLE_TICKETS=dashboard allows the dashboard token, too.
route('POST', '/v1/sites/:id/console', config.consoleTicketsByWorker ? 'admin' : 'console', async (ctx) => consoleSvc.issue(parseSiteId(ctx.params.id), ctx.body));
route('POST', '/v1/console/end-user', 'console', async (ctx) => {
  const id = parseInt(ctx.body.userId, 10);
  if (!Number.isInteger(id) || id < 1) throw new ValidationError('Invalid user');
  const n = consoleSvc.endUser(id);
  if (n) audit('console.end_user', { userId: id, sessions: n, reason: String(ctx.body.reason || '').slice(0, 80) });
  return { ended: n };
});
route('POST', '/v1/console/end-site', 'console', async (ctx) => {
  const n = consoleSvc.endSite(parseSiteId(ctx.body.siteId));
  if (n) audit('console.end_site', { site: parseSiteId(ctx.body.siteId), sessions: n });
  return { ended: n };
});
route('GET', '/v1/console/sessions', 'console', async () => ({ sessions: consoleSvc.listSessions() }));
route('POST', '/v1/console/sessions/:sid/kill', 'console', async (ctx) => {
  if (!/^[0-9a-f]{16}$/.test(ctx.params.sid)) throw new ValidationError('Invalid session');
  const ok = consoleSvc.killSession(ctx.params.sid);
  if (ok) audit('console.kill', { session: ctx.params.sid, actor: String(ctx.body.actor || '').slice(0, 120) });
  return { ok };
});
route('POST', '/v1/jobs/:jobId/kill', 'admin', async (ctx) => ({ killed: await jobs.killJob(ctx.params.jobId) }));
route('POST', '/v1/certs/:name/issue', 'admin', async (ctx) => {
  const emit = startStream(ctx.res);
  ctx.streaming = true;
  try {
    const siteId = ctx.params.name === 'dashboard' ? null : parseSiteId(ctx.params.name);
    const result = await certs.issue({ name: ctx.params.name, domains: ctx.body.domains, email: ctx.body.email, siteId, dns: ctx.body.dns === true }, (l) => emit({ t: 'out', d: l }));
    emit({ t: 'result', result });
    emit({ t: 'exit', code: result.ok ? 0 : 1 });
  } catch (e) {
    emit({ t: 'out', d: `Error: ${e.message}` });
    emit({ t: 'exit', code: 1 });
  }
  ctx.res.end();
  return undefined;
});
route('POST', '/v1/certs/renew', 'admin', async (ctx) => {
  const emit = startStream(ctx.res);
  ctx.streaming = true;
  try {
    const result = await certs.renewAll((l) => emit({ t: 'out', d: l }));
    emit({ t: 'result', result });
    emit({ t: 'exit', code: result.ok ? 0 : 1 });
  } catch (e) {
    emit({ t: 'out', d: `Error: ${e.message}` });
    emit({ t: 'exit', code: 1 });
  }
  ctx.res.end();
  return undefined;
});
route('PUT', '/v1/dns', 'admin', async (ctx) => {
  dnsFiles.save({ provider: ctx.body.provider, token: ctx.body.token, wait: ctx.body.wait });
  audit('dns.save', { provider: ctx.body.provider });
  return dnsFiles.status();
});
route('DELETE', '/v1/dns', 'admin', async () => {
  dnsFiles.clear();
  audit('dns.clear', {});
  return dnsFiles.status();
});
route('POST', '/v1/dns/test', 'admin', async (ctx) => {
  const emit = startStream(ctx.res);
  ctx.streaming = true;
  try {
    const result = await certs.dnsTest((l) => emit({ t: 'out', d: l }));
    emit({ t: 'result', result });
    emit({ t: 'exit', code: result.ok ? 0 : 1 });
  } catch (e) {
    emit({ t: 'out', d: `Error: ${e.message}` });
    emit({ t: 'exit', code: 1 });
  }
  ctx.res.end();
  return undefined;
});
route('POST', '/v1/dns/records', 'admin', async (ctx) => {
  const emit = startStream(ctx.res);
  ctx.streaming = true;
  try {
    const result = await certs.dnsRecords({ domains: ctx.body.domains, ips: ctx.body.ips }, (l) => emit({ t: 'out', d: l }));
    emit({ t: 'result', result });
    emit({ t: 'exit', code: result.ok ? 0 : 1 });
  } catch (e) {
    emit({ t: 'out', d: `Error: ${e.message}` });
    emit({ t: 'exit', code: 1 });
  }
  ctx.res.end();
  return undefined;
});
route('PUT', '/v1/dashboard', 'admin', async (ctx) => {
  const d = ctx.body.domain ? normDomain(ctx.body.domain) : '';
  certs.setDashboardDomain(d);
  audit('dashboard.domain', { domain: d });
  await certs.applyDashboard();
  return { domain: d };
});
route('POST', '/v1/storage/cleanup', 'admin', async (ctx) => storage.cleanup(ctx.body.categories));
route('POST', '/v1/backup/request', 'admin', async (ctx) => {
  audit('backup.request', { action: String(ctx.body.action || '') });
  return backupctl.request(ctx.body);
});
route('POST', '/v1/update/auto', 'admin', async (ctx) => {
  audit('update.auto', { mode: String(ctx.body.mode || ''), from: ctx.body.from, to: ctx.body.to });
  return update.setAuto(ctx.body);
});
route('POST', '/v1/update/request', 'admin', async (ctx) => {
  audit('update.request', { action: String(ctx.body.action || ''), version: String(ctx.body.version || '') });
  return update.request(ctx.body);
});
route('POST', '/v1/reconcile', 'admin', async () => {
  const attached = await sites.reconcileNetworks();
  await certs.applyDashboard().catch((e) => audit('dashboard.apply_failed', { error: e.message }));
  return { attached };
});
route('POST', '/v1/images/ensure', 'admin', async (ctx) => {
  const rt = Object.prototype.hasOwnProperty.call(loadRuntimes().runtimes, String(ctx.body.runtime)) ? loadRuntimes().runtimes[String(ctx.body.runtime)] : null;
  if (!rt) throw new ValidationError('Runtime template is not approved');
  if (ctx.body.stream) {
    const emit = startStream(ctx.res);
    ctx.streaming = true;
    try {
      await sites.ensureImage(rt, (l) => emit({ t: 'out', d: l }));
      emit({ t: 'exit', code: 0 });
    } catch (e) {
      emit({ t: 'out', d: `Error: ${e.message}` });
      emit({ t: 'exit', code: 1 });
    }
    ctx.res.end();
    return undefined;
  }
  await sites.ensureImage(rt);
  return { ok: true, image: rt.image };
});

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://agent');
  const ip = req.socket.remoteAddress || '?';
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const r = await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 8000 });
      return sendJson(res, r.code === 0 ? 200 : 503, { ok: r.code === 0, docker: r.stdout.trim() || null });
    }
    const actor = authenticate(req);
    if (!actor) {
      if (tooManyFailures(ip)) return sendJson(res, 429, { error: 'Too many failed attempts' });
      failures.get(ip).push(Date.now());
      audit('auth.failed', { ip, method: req.method, path: url.pathname.slice(0, 120) });
      return sendJson(res, 401, { error: 'Not authorized' });
    }
    const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!match) return sendJson(res, 404, { error: 'Unknown route' });
    if (match.scope === 'admin' && actor !== 'worker') {
      audit('auth.forbidden', { ip, actor, method: req.method, path: url.pathname.slice(0, 120) });
      return sendJson(res, 403, { error: 'No permission for this action' });
    }
    const values = match.re.exec(url.pathname).slice(1);
    const params = {};
    match.keys.forEach((k, i) => { params[k] = decodeURIComponent(values[i]); });
    const ctx = { req, res, params, query: url.searchParams, actor, body: {} };
    const streamsBody = /\/fs\/(write|upload)$/.test(url.pathname);
    if (!streamsBody && ['POST', 'PUT', 'DELETE'].includes(req.method)) ctx.body = await readBody(req);
    if (streamsBody) {
      const len = parseInt(req.headers['content-length'] || '0', 10);
      if (len > 128 * 1024 * 1024) return sendJson(res, 413, { error: 'File is too large' });
    }
    const result = await match.handler(ctx);
    if (!ctx.streaming && !res.headersSent && result !== undefined) sendJson(res, 200, result);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) process.stderr.write(`[agent] ${req.method} ${url.pathname}: ${e.stack || e.message}\n`);
    if (res.headersSent) { try { res.end(); } catch (_) { /* ignore */ } return; }
    sendJson(res, status, { error: e.message });
  }
});
// WebSocket of the web console: authenticated by the one-time ticket in the path, not by a token
server.on('upgrade', (req, socket, head) => { consoleSvc.handleUpgrade(req, socket, head).catch(() => socket.destroy()); });
server.requestTimeout = 0;
server.headersTimeout = 30000;

function tick(fn, ms) { setInterval(() => fn().catch((e) => process.stderr.write(`[agent] ${e.message}\n`)), ms).unref(); }

if (require.main === module) {
  server.listen(config.port, '0.0.0.0', () => {
    audit('agent.start', { port: config.port, version: config.version });
    // Self-healing: dashboard route, proxy network attachments, log rotation.
    const boot = async () => { await certs.applyRealIp().catch((e) => audit('agent.boot_warning', { error: e.message })); await certs.applyDashboard(); await sites.reconcileNetworks(); };
    boot().catch((e) => audit('agent.boot_warning', { error: e.message }));
    tick(async () => { await sites.reconcileNetworks(); }, 60_000);
    tick(async () => { sites.rotateLogs(); }, 3_600_000);
    protect.start();
    database.cleanupAdminOnBoot().catch(() => {});
    tick(async () => { await database.sweepAdmin(); }, 60_000);
    metrics.start();
    proxylog.start();
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
}

module.exports = { server };
