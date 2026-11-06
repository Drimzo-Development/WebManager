'use strict';
/**
 * Optional database container per website (MariaDB or PostgreSQL). It is never created implicitly: the website's
 * spec carries a `database` object only when an operator switched the feature on. The container lives on the
 * website's own private network (no published ports), stores its data in <site dir>/db and gets the same kind of
 * hardening as the websites. Credentials are handed to the website through environment variables.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { config, loadRuntimes } = require('./config');
const { docker, dockerOk } = require('./docker');
const { audit } = require('./audit');

const DUMP_RE = /^db-\d{8}-\d{6}\.sql\.gz$/;
const ENV = { ...process.env, DOCKER_CONFIG: process.env.DOCKER_CONFIG || '/tmp/.docker', DOCKER_CLI_HINTS: 'false' };

const fwdName = (id) => `wm-dbfwd-site-${String(id).padStart(3, '0')}`;
const EXTERNAL_PORT_BASE = 33000;
const externalPort = (id) => {
  if (id > 32000) throw Object.assign(new Error('External access is only possible for websites up to number 32000'), { status: 422 });
  return EXTERNAL_PORT_BASE + id;
};
const siteSlug = (id) => `site-${String(id).padStart(3, '0')}`;
const containerName = (id) => `wm-db-${siteSlug(id)}`;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** The image and port of an engine, from the allowlist in templates/runtimes.json. */
function engineDef(engine) {
  const dbs = (loadRuntimes().databases) || {};
  if (!Object.prototype.hasOwnProperty.call(dbs, engine)) throw httpError(422, 'Database type is not approved');
  return dbs[engine];
}

/** Environment variables a website receives for its database. User-defined variables still win. */
function envFor(db, id) {
  if (!db) return {};
  const host = containerName(id);
  const def = engineDef(db.engine);
  const scheme = db.engine === 'postgres' ? 'postgresql' : 'mysql';
  return {
    DB_CONNECTION: db.engine === 'postgres' ? 'pgsql' : 'mysql',
    DB_HOST: host,
    DB_PORT: String(def.port),
    DB_DATABASE: db.name,
    DB_USERNAME: db.user,
    DB_PASSWORD: db.password,
    DATABASE_URL: `${scheme}://${db.user}:${db.password}@${host}:${def.port}/${db.name}`,
  };
}

function dbHash(db, def) {
  return crypto.createHash('sha256').update(JSON.stringify([db.engine, def.image, db.name, db.user, db.memoryMb])).digest('hex').slice(0, 32);
}

async function ensureImage(ref) {
  if (!/^[a-z0-9][a-z0-9._\/-]*:[A-Za-z0-9._-]+$/.test(ref)) throw httpError(500, 'Invalid image reference');
  const r = await docker(['image', 'inspect', ref]);
  if (r.code === 0) return;
  audit('image.pull', { image: ref });
  await dockerOk(['pull', ref], { timeout: 1_800_000 });
}

async function inspect(id) {
  const r = await docker(['inspect', containerName(id)]);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout)[0]; } catch (_) { return null; }
}

async function waitHealthy(id, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const c = await inspect(id);
    if (!c || !c.State.Running) return false;
    if (!c.State.Health || c.State.Health.Status === 'healthy') return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** Creates or starts the database container for `spec.database`; recreates it only when engine, size or image changed. */
async function ensure(spec, p) {
  const db = spec.database;
  const def = engineDef(db.engine);
  const name = containerName(spec.id);
  await ensureImage(def.image);
  fs.mkdirSync(path.join(p.dir, 'db'), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(p.dir, 'db'), 0o700);

  const hash = dbHash(db, def);
  let c = await inspect(spec.id);
  let created = false;
  if (c && c.Config.Labels['drimzo.dbhash'] !== hash) {
    await docker(['rm', '-f', name], { timeout: 60000 });
    c = null;
  }
  if (!c) {
    const envFile = path.join(p.cfg, 'dbenv');
    const envLines = db.engine === 'postgres'
      ? [`POSTGRES_DB=${db.name}`, `POSTGRES_USER=${db.user}`, `POSTGRES_PASSWORD=${db.password}`, 'PGDATA=/var/lib/postgresql/data/pgdata']
      : [`MARIADB_DATABASE=${db.name}`, `MARIADB_USER=${db.user}`, `MARIADB_PASSWORD=${db.password}`, `MARIADB_ROOT_PASSWORD=${db.rootPassword}`, 'MARIADB_AUTO_UPGRADE=1'];
    fs.writeFileSync(envFile, `${envLines.join('\n')}\n`, { mode: 0o600 });
    const mem = `${db.memoryMb}m`;
    const args = [
      'create', '--name', name, '--hostname', name, '--network', p.network, '--network-alias', 'db',
      '--restart', 'unless-stopped', '--init',
      '--cap-drop', 'ALL', ...['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'].flatMap((x) => ['--cap-add', x]),
      '--security-opt', 'no-new-privileges:true', '--pids-limit', '512', '--memory', mem, '--memory-swap', mem,
      '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
      '--label', 'drimzo.managed=true', '--label', `drimzo.site=${spec.id}`, '--label', 'drimzo.db=1',
      '--label', `drimzo.dbengine=${db.engine}`, '--label', `drimzo.dbhash=${hash}`,
      '--env-file', envFile,
      '-v', `${path.join(p.dir, 'db')}:${db.engine === 'postgres' ? '/var/lib/postgresql/data' : '/var/lib/mysql'}`,
      '--health-interval', '10s', '--health-timeout', '5s', '--health-retries', '6', '--health-start-period', '40s',
      '--health-cmd', db.engine === 'postgres' ? 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q' : 'healthcheck.sh --connect --innodb_initialized',
      def.image,
    ];
    if (db.engine === 'mariadb') args.push('--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci', '--skip-name-resolve');
    await dockerOk(args);
    created = true;
    audit('db.create', { site: siteSlug(spec.id), engine: db.engine });
  }
  c = await inspect(spec.id);
  let started = false;
  if (!c.State.Running) {
    await dockerOk(['start', name]);
    started = true;
  }
  if (created || started) {
    if (!(await waitHealthy(spec.id, 120))) throw httpError(502, 'The database was started but is not ready after 2 minutes. Logs: docker logs ' + name);
  }
  const externalPortInUse = await ensureForwarder(spec, p);
  return { created, started, externalPort: externalPortInUse };
}

/**
 * nginx stream configuration of the allowlisted forwarder: only listed addresses may open a connection;
 * the target is resolved at connection time, so a re-created database container is found again.
 */
function renderForwarderConf(enginePort, allow) {
  const rules = allow.map((n) => `        allow ${n};`).join('\n');
  return `# Generated by WebManager (database access from outside). Do not edit.
worker_processes 1;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events { worker_connections 256; }
stream {
    resolver 127.0.0.11 valid=10s ipv6=off;
    server {
        listen 3306;
${rules}
        deny all;
        proxy_connect_timeout 5s;
        proxy_timeout 1h;
        set $target db:${enginePort};
        proxy_pass $target;
    }
}
`;
}

/** Image of the running reverse proxy (it ships the nginx stream module); reusing it needs no extra download. */
async function forwarderImage() {
  const r = await docker(['inspect', '-f', '{{.Config.Image}}', config.proxyContainer]);
  const ref = r.stdout.trim();
  if (r.code !== 0 || !/^[a-z0-9][a-z0-9._\/-]*:[A-Za-z0-9._-]+$/.test(ref)) throw httpError(502, 'The proxy image was not found');
  return ref;
}

function bindAddress() {
  const v = process.env.DB_BIND_ADDRESS || '0.0.0.0';
  return require('net').isIPv4(v) ? v : '0.0.0.0';
}

async function removeForwarder(id) {
  const r = await docker(['rm', '-f', fwdName(id)], { timeout: 60000 });
  return r.code === 0;
}

/** Starts the allowlisted forwarder that publishes the database on the server (opt-in); removes it when switched off. */
async function ensureForwarder(spec, p) {
  const ext = spec.database && spec.database.external;
  if (!ext) {
    if ((await docker(['inspect', fwdName(spec.id)])).code === 0) { await removeForwarder(spec.id); audit('db.external_off', { site: siteSlug(spec.id) }); }
    return null;
  }
  const def = engineDef(spec.database.engine);
  const port = externalPort(spec.id);
  const image = await forwarderImage();
  const conf = renderForwarderConf(def.port, ext.allow);
  const hash = crypto.createHash('sha256').update(JSON.stringify([conf, port, image, bindAddress()])).digest('hex').slice(0, 32);
  const existing = await docker(['inspect', fwdName(spec.id)]);
  if (existing.code === 0) {
    let c = null;
    try { c = JSON.parse(existing.stdout)[0]; } catch (_) { /* recreate */ }
    if (c && c.Config.Labels['drimzo.dbfwdhash'] === hash) {
      if (!c.State.Running) await dockerOk(['start', fwdName(spec.id)]);
      return port;
    }
    await removeForwarder(spec.id);
  }
  const confFile = path.join(p.cfg, 'dbfwd.conf');
  fs.writeFileSync(confFile, conf, { mode: 0o644 });
  await dockerOk([
    'run', '-d', '--name', fwdName(spec.id), '--network', p.network, '--user', '101:101', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,size=16m,mode=1777', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--memory', '64m', '--pids-limit', '64', '--restart', 'unless-stopped',
    '--log-driver', 'json-file', '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
    '--label', 'drimzo.managed=true', '--label', `drimzo.site=${spec.id}`, '--label', 'drimzo.dbfwd=1', '--label', `drimzo.dbfwdhash=${hash}`,
    '-p', `${bindAddress()}:${port}:3306`,
    '-v', `${confFile}:/etc/nginx/dbfwd.conf:ro`,
    '--entrypoint', 'nginx', image, '-e', 'stderr', '-c', '/etc/nginx/dbfwd.conf', '-g', 'daemon off;',
  ]);
  audit('db.external_on', { site: siteSlug(spec.id), port, allow: ext.allow.length });
  return port;
}

/** Stops and removes the container (data stays on disk). */
async function remove(id) {
  await removeForwarder(id);
  const r = await docker(['rm', '-f', containerName(id)], { timeout: 60000 });
  return r.code === 0;
}

async function removeIfPresent(id) {
  await removeForwarder(id);
  if (await inspect(id)) { await remove(id); audit('db.remove', { site: siteSlug(id) }); }
}

async function status(id) {
  const c = await inspect(id);
  if (!c) return { exists: false };
  return {
    exists: true, state: c.State.Status, running: c.State.Running, health: c.State.Health ? c.State.Health.Status : null,
    image: c.Config.Image, engine: c.Config.Labels['drimzo.dbengine'] || null, startedAt: c.State.StartedAt,
  };
}

// ---------------------------------------------------------------- dumps, restore, password
function dumpDir(siteDir) { return path.join(siteDir, 'dumps'); }

function listDumps(siteDir) {
  let names = [];
  try { names = fs.readdirSync(dumpDir(siteDir)); } catch (_) { return []; }
  return names.filter((n) => DUMP_RE.test(n)).sort().reverse().map((n) => {
    const st = fs.statSync(path.join(dumpDir(siteDir), n));
    return { name: n, size: st.size, createdAt: st.mtime.toISOString() };
  });
}

function dumpPath(siteDir, name) {
  if (!DUMP_RE.test(String(name))) throw httpError(422, 'Invalid dump name');
  const f = path.join(dumpDir(siteDir), name);
  if (!fs.existsSync(f)) throw httpError(404, 'Dump not found');
  return f;
}

function deleteDump(siteDir, name) {
  fs.rmSync(dumpPath(siteDir, name), { force: true });
  return { ok: true };
}

const DUMP_SCRIPT = {
  mariadb: 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb-dump -uroot --single-transaction --routines --triggers --events --hex-blob --default-character-set=utf8mb4 "$MARIADB_DATABASE"',
  postgres: 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists',
};
const RESTORE_SCRIPT = {
  mariadb: 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot --default-character-set=utf8mb4 "$MARIADB_DATABASE"',
  postgres: 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q',
};

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

/** Writes a gzip-compressed logical dump to <site dir>/dumps (mode 0600, never inside the web root). */
async function dump(id, siteDir, engine) {
  if (!DUMP_SCRIPT[engine]) throw httpError(422, 'Unknown database type');
  if (!(await status(id)).running) throw httpError(409, 'The database is not running.');
  fs.mkdirSync(dumpDir(siteDir), { recursive: true, mode: 0o700 });
  const file = path.join(dumpDir(siteDir), `db-${stamp()}.sql.gz`);
  const child = spawn('docker', ['exec', containerName(id), 'sh', '-c', DUMP_SCRIPT[engine]], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(httpError(502, `Dump failed: ${err.trim().slice(0, 300)}`))));
  });
  try {
    await Promise.all([pipeline(child.stdout, zlib.createGzip({ level: 6 }), fs.createWriteStream(file, { mode: 0o600 })), exited]);
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
  audit('db.dump', { site: siteSlug(id), file: path.basename(file) });
  return { name: path.basename(file), size: fs.statSync(file).size };
}

/** Imports a dump created by dump() into the running database (existing tables are replaced for PostgreSQL dumps). */
async function restore(id, siteDir, engine, name) {
  if (!RESTORE_SCRIPT[engine]) throw httpError(422, 'Unknown database type');
  if (!(await status(id)).running) throw httpError(409, 'The database is not running.');
  const file = dumpPath(siteDir, name);
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', containerName(id), 'sh', '-c', RESTORE_SCRIPT[engine]], { env: ENV, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(httpError(502, `Restore failed: ${err.trim().slice(0, 300)}`))));
    fs.createReadStream(file).pipe(zlib.createGunzip()).on('error', reject).pipe(child.stdin);
  });
  audit('db.restore', { site: siteSlug(id), file: name });
  return { ok: true };
}

/** Sets a new password for the application user. The value is handed over through the process environment, never through argv. */
async function setPassword(id, engine, newPassword) {
  if (!/^[A-Za-z0-9]{16,128}$/.test(newPassword)) throw httpError(422, 'Invalid password');
  if (!(await status(id)).running) throw httpError(409, 'The database is not running.');
  const script = engine === 'postgres'
    ? 'exec psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -q -c "ALTER USER \\"$POSTGRES_USER\\" PASSWORD \'$WM_NEWPW\'"'
    : 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot -e "ALTER USER \'$MARIADB_USER\'@\'%\' IDENTIFIED BY \'$WM_NEWPW\'; FLUSH PRIVILEGES;"';
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-e', 'WM_NEWPW', containerName(id), 'sh', '-c', script], { env: { ...ENV, WM_NEWPW: newPassword }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(httpError(502, `Password change failed: ${err.trim().slice(0, 300)}`))));
  });
  audit('db.password', { site: siteSlug(id) });
  return { ok: true };
}

/** Removes container and data directory for good. */
async function purge(id, siteDir) {
  await remove(id);
  fs.rmSync(path.join(siteDir, 'db'), { recursive: true, force: true });
  fs.rmSync(dumpDir(siteDir), { recursive: true, force: true });
  audit('db.purge', { site: siteSlug(id) });
  return { ok: true };
}

// ---------------------------------------------------------------- web administration (Adminer), started on demand
const ADMIN_MINUTES = 30;
const adminName = (id) => `wm-dbadmin-${siteSlug(id)}`;
const adminExpiry = new Map(); // site id -> epoch ms

function adminDef() {
  const d = loadRuntimes().dbadmin;
  if (!d || !/^[a-z0-9][a-z0-9._\/-]*:[A-Za-z0-9._-]+$/.test(d.image)) throw httpError(500, 'Database management is not approved');
  return d;
}

async function adminStatus(id) {
  const r = await docker(['inspect', '-f', '{{.State.Running}}', adminName(id)]);
  const running = r.code === 0 && r.stdout.trim() === 'true';
  return { running, expiresAt: running && adminExpiry.get(id) ? new Date(adminExpiry.get(id)).toISOString() : null };
}

/**
 * Starts Adminer for one website's database. It only lives on that website's private network, is reached through the
 * dashboard (signed-in operators only, see proxy.js) and shuts itself down after ADMIN_MINUTES.
 */
async function startAdmin(id, p) {
  if (!(await status(id)).running) throw httpError(409, 'The database is not running.');
  const def = adminDef();
  await ensureImage(def.image);
  await docker(['rm', '-f', adminName(id)], { timeout: 30000 });
  const ini = path.join(p.cfg, 'dbadmin.ini');
  fs.writeFileSync(ini, 'upload_max_filesize=128M\npost_max_size=130M\nmemory_limit=256M\nmax_execution_time=120\nexpose_php=Off\n', { mode: 0o644 });
  await dockerOk([
    'run', '-d', '--name', adminName(id), '--network', p.network, '--restart', 'no',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--memory-swap', '256m', '--pids-limit', '64',
    '--log-driver', 'json-file', '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
    '--label', 'drimzo.managed=true', '--label', `drimzo.site=${id}`, '--label', 'drimzo.dbadmin=1',
    '-e', 'ADMINER_DEFAULT_SERVER=db',
    '-v', `${ini}:/usr/local/etc/php/conf.d/zz-wm.ini:ro`,
    def.image, 'php', '-S', '0.0.0.0:8080', '-t', '/var/www/html',
  ]);
  adminExpiry.set(id, Date.now() + ADMIN_MINUTES * 60000);
  audit('db.admin_start', { site: siteSlug(id) });
  return { ok: true, minutes: ADMIN_MINUTES };
}

async function stopAdmin(id) {
  adminExpiry.delete(id);
  const r = await docker(['rm', '-f', adminName(id)], { timeout: 30000 });
  audit('db.admin_stop', { site: siteSlug(id) });
  return { ok: r.code === 0 };
}

/** Removes administration containers whose time is up (called every minute). */
async function sweepAdmin() {
  const now = Date.now();
  for (const [id, until] of adminExpiry) if (until <= now) await stopAdmin(id);
}

/** After an agent restart nobody remembers the expiry times, so leftovers are removed. */
async function cleanupAdminOnBoot() {
  const r = await docker(['ps', '-aq', '--filter', 'label=drimzo.dbadmin=1']);
  for (const c of r.stdout.split('\n').filter(Boolean)) await docker(['rm', '-f', c]);
}

module.exports = {
  startAdmin, stopAdmin, sweepAdmin, cleanupAdminOnBoot, adminStatus, adminName,
  renderForwarderConf, externalPort, bindAddress, containerName, envFor, ensure, remove, removeIfPresent, status, listDumps, dumpPath, deleteDump, dump, restore, setPassword, purge,
  dumpDir, DUMP_RE, dbHash,
};
