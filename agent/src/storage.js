'use strict';
// Storage overview and cleanup. Every category has fixed rules (what is safe to remove); the cleanup recomputes the candidates itself
// and never trusts a list from the caller. Nothing here removes websites, live data, the newest backups or images that are in use.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { config } = require('./config');
const { docker } = require('./docker');
const { audit } = require('./audit');
const { ValidationError } = require('./validate');

const DAY = 24 * 3600 * 1000;
const RULES = {
  appBackupsKeep: 2,          // newest program backups of updates (used by "Roll back to the previous version")
  dumpsKeep: 3, dumpsMinAgeDays: 14,
  logsKeepPerKind: 5, logsMinAgeDays: 30,
  trashMinAgeDays: 30,
};
const IDS = ['images', 'dangling', 'buildcache', 'appbackups', 'dumps', 'logs', 'trash'];
const IMAGE_REPO_RE = /^(drimzo)\/(agent|worker|webmanager|proxy)$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

const deps = { docker, now: () => Date.now() };
const logDir = () => path.dirname(config.AUDIT_LOG);
const backupDir = () => path.join(config.DATA_DIR, 'backups');
const dumpDir = () => path.join(config.DATA_DIR, 'database-backups');

const cmpVer = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

/** "1.2GB" / "512MB" / "12kB" (Docker uses decimal units) -> bytes */
function parseSize(text) {
  const m = /^\s*([0-9.]+)\s*([kKMGTP]?)B?/i.exec(String(text || ''));
  if (!m) return 0;
  const f = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12, p: 1e15 }[m[2].toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * f);
}

function du(dir, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile('du', ['-sk', dir], { timeout: timeoutMs }, (err, stdout) => {
      const n = parseInt(String(stdout).split(/\s+/)[0], 10);
      resolve(err || !Number.isFinite(n) ? 0 : n * 1024);
    });
  });
}

function listFiles(dir, re) {
  try {
    return fs.readdirSync(dir).filter((n) => re.test(n)).map((n) => {
      const st = fs.statSync(path.join(dir, n));
      return { name: n, bytes: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs, dir: st.isDirectory() };
    });
  } catch (_) {
    return [];
  }
}

const newestFirst = (a, b) => b.mtime - a.mtime;
const days = (ms) => Math.floor((deps.now() - ms) / DAY);

// ------------------------------------------------------------------ candidates per category
async function imageSize(ref) {
  const r = await deps.docker(['image', 'inspect', '-f', '{{.Size}}', ref]);
  const n = parseInt(r.stdout.trim(), 10);
  return r.code === 0 && Number.isFinite(n) ? n : 0;
}

async function usedImages() {
  const r = await deps.docker(['ps', '-a', '--format', '{{.Image}}']);
  return new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
}

/** Old WebManager images: everything except the running version and the one before it (needed for "Roll back to the previous version"). */
async function candidatesImages() {
  const r = await deps.docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
  if (r.code !== 0) return [];
  const all = r.stdout.split('\n').map((l) => l.trim()).filter((l) => {
    const i = l.lastIndexOf(':');
    return i > 0 && IMAGE_REPO_RE.test(l.slice(0, i)) && VERSION_RE.test(l.slice(i + 1));
  });
  const current = config.version;
  const versions = [...new Set(all.map((l) => l.slice(l.lastIndexOf(':') + 1)))];
  const older = VERSION_RE.test(current) ? versions.filter((v) => cmpVer(v, current) < 0).sort(cmpVer) : [];
  const keep = new Set([current, older.length ? older[older.length - 1] : null]);
  const used = await usedImages();
  const out = [];
  for (const ref of all) {
    const v = ref.slice(ref.lastIndexOf(':') + 1);
    if (keep.has(v) || used.has(ref)) continue;
    out.push({ name: ref, bytes: await imageSize(ref), ref });
  }
  return out;
}

async function candidatesDangling() {
  const r = await deps.docker(['image', 'ls', '-f', 'dangling=true', '-q', '--no-trunc']);
  if (r.code !== 0) return [];
  const ids = [...new Set(r.stdout.split('\n').map((l) => l.trim()).filter((l) => /^sha256:[0-9a-f]{64}$/.test(l)))];
  const out = [];
  for (const id of ids.slice(0, 200)) out.push({ name: id.slice(7, 19), bytes: await imageSize(id), ref: id });
  return out;
}

async function buildCache() {
  const r = await deps.docker(['system', 'df', '--format', '{{json .}}']);
  for (const line of r.stdout.split('\n')) {
    try {
      const j = JSON.parse(line);
      if (j.Type === 'Build Cache') return { bytes: parseSize(j.Size), reclaimable: parseSize(String(j.Reclaimable || '').replace(/\s*\(.*$/, '')) };
    } catch (_) { /* not a JSON line */ }
  }
  return { bytes: 0, reclaimable: 0 };
}

function candidatesAppBackups() {
  const files = listFiles(backupDir(), /^app-tree-[0-9A-Za-z.-]+-[0-9]{8}-[0-9]{6}\.tar\.gz$/).sort(newestFirst);
  return files.slice(RULES.appBackupsKeep).map((f) => ({ ...f, path: path.join(backupDir(), f.name), detail: `${days(f.mtime)} days old` }));
}

function candidatesDumps() {
  const files = listFiles(dumpDir(), /^db-[0-9]{8}-[0-9]{6}(-v[0-9A-Za-z.-]+)?\.sql\.gz$/).sort(newestFirst);
  return files.slice(RULES.dumpsKeep).filter((f) => days(f.mtime) >= RULES.dumpsMinAgeDays).map((f) => ({ ...f, path: path.join(dumpDir(), f.name), detail: `${days(f.mtime)} days old` }));
}

function candidatesLogs() {
  const files = listFiles(logDir(), /^(update|update-request|backup|backup-request|restore|install)-[0-9]{8}-[0-9]{6}\.log$/);
  const byKind = {};
  for (const f of files) (byKind[f.name.replace(/-[0-9]{8}-[0-9]{6}\.log$/, '')] ||= []).push(f);
  const out = [];
  for (const list of Object.values(byKind)) {
    list.sort(newestFirst).slice(RULES.logsKeepPerKind).filter((f) => days(f.mtime) >= RULES.logsMinAgeDays).forEach((f) => out.push({ ...f, path: path.join(logDir(), f.name), detail: `${days(f.mtime)} days old` }));
  }
  return out;
}

/** Deleted websites that are older than 30 days (the age comes from the name: renaming into the trash keeps the old mtime). */
async function candidatesTrash() {
  const out = [];
  for (const f of listFiles(config.TRASH_DIR, /^site-[0-9]{3,5}-[0-9T:.Z-]+$/)) {
    const m = /^site-[0-9]{3,5}-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(f.name);
    const at = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : f.mtime;
    if (days(at) < RULES.trashMinAgeDays) continue;
    out.push({ name: f.name, path: path.join(config.TRASH_DIR, f.name), bytes: await du(path.join(config.TRASH_DIR, f.name)), detail: `deleted ${days(at)} days ago`, dir: true });
  }
  return out;
}

const sum = (items) => items.reduce((a, i) => a + (i.bytes || 0), 0);
const view = (items) => items.slice(0, 40).map((i) => ({ name: i.name, bytes: i.bytes || 0, detail: i.detail || '' }));

async function plan() {
  let disk = null;
  try { const s = fs.statfsSync(config.DATA_DIR); disk = { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize }; } catch (_) { /* unknown */ }
  const [images, dangling, cache] = await Promise.all([candidatesImages(), candidatesDangling(), buildCache()]);
  const appbackups = candidatesAppBackups();
  const dumps = candidatesDumps();
  const logs = candidatesLogs();
  const trash = await candidatesTrash();
  const fullBackups = listFiles(backupDir(), /^webmanager-backup-.*\.tar\.gz(\.gpg)?$/);
  const categories = [
    { id: 'images', label: 'Old WebManager images', description: 'Images of earlier versions. The running and the previous version are kept (for “Back to the previous version”); images in use are never removed.', items: images, cleanable: sum(images) },
    { id: 'dangling', label: 'Unnamed image layers', description: 'Leftovers from builds that no longer belong to any image.', items: dangling, cleanable: sum(dangling) },
    { id: 'buildcache', label: 'Build cache', description: 'Cache of the image builds. The next build is slower once afterwards.', items: [], cleanable: cache.reclaimable, bytes: cache.bytes },
    { id: 'appbackups', label: 'Program backups of earlier updates', description: `Archives of the program files before every update. The newest ${RULES.appBackupsKeep} are kept.`, items: appbackups, cleanable: sum(appbackups) },
    { id: 'dumps', label: 'Old database dumps', description: `Dumps before updates and backups. The newest ${RULES.dumpsKeep} are kept, plus everything younger than ${RULES.dumpsMinAgeDays} days.`, items: dumps, cleanable: sum(dumps) },
    { id: 'logs', label: 'Old logs', description: `Update, backup and installation logs older than ${RULES.logsMinAgeDays} days (the newest ${RULES.logsKeepPerKind} of each kind are kept).`, items: logs, cleanable: sum(logs) },
    { id: 'trash', label: 'Trash of deleted websites', description: `Deleted websites older than ${RULES.trashMinAgeDays} days. After that their files are gone for good.`, items: trash, cleanable: sum(trash), risk: 'Permanent' },
  ];
  const cats = categories.map((c) => ({ id: c.id, label: c.label, description: c.description, risk: c.risk || '', count: c.items.length || (c.cleanable > 0 ? 1 : 0), cleanable: c.cleanable, bytes: c.bytes ?? c.cleanable, items: view(c.items) }));
  return {
    disk,
    categories: cats,
    cleanableTotal: cats.reduce((a, c) => a + c.cleanable, 0),
    info: { localBackupBytes: sum(fullBackups), localBackupCount: fullBackups.length },
    rules: RULES,
  };
}

async function sitesUsage() {
  const dir = path.join(config.DATA_DIR, 'sites');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^site-[0-9]{3,5}$/.test(n)); } catch (_) { /* none */ }
  const out = [];
  for (const n of names) out.push({ site: n, bytes: await du(path.join(dir, n), 20000) });
  return { sites: out.sort((a, b) => b.bytes - a.bytes) };
}

function rmPath(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

async function cleanup(ids) {
  if (!Array.isArray(ids) || !ids.length || !ids.every((i) => IDS.includes(i))) throw new ValidationError('Unknown category');
  const result = { freed: 0, deleted: 0, errors: [], categories: {} };
  const note = (id, freed, n) => { result.freed += freed; result.deleted += n; result.categories[id] = { freed, deleted: n }; };
  for (const id of [...new Set(ids)]) {
    let freed = 0;
    let n = 0;
    try {
      if (id === 'images') {
        for (const i of await candidatesImages()) { const r = await deps.docker(['rmi', i.ref]); if (r.code === 0) { freed += i.bytes; n++; } else result.errors.push(`${i.name}: ${(r.stderr || '').trim().slice(0, 160)}`); }
      } else if (id === 'dangling') {
        for (const i of await candidatesDangling()) { const r = await deps.docker(['rmi', i.ref]); if (r.code === 0) { freed += i.bytes; n++; } }
      } else if (id === 'buildcache') {
        const before = await buildCache();
        const r = await deps.docker(['builder', 'prune', '-f'], { timeout: 300000 });
        if (r.code === 0) { freed += before.reclaimable; n = before.reclaimable > 0 ? 1 : 0; } else result.errors.push(`Build-Cache: ${(r.stderr || '').trim().slice(0, 160)}`);
      } else {
        const items = id === 'appbackups' ? candidatesAppBackups() : id === 'dumps' ? candidatesDumps() : id === 'logs' ? candidatesLogs() : await candidatesTrash();
        for (const i of items) { try { rmPath(i.path); freed += i.bytes; n++; } catch (e) { result.errors.push(`${i.name}: ${e.message}`); } }
      }
    } catch (e) {
      result.errors.push(`${id}: ${e.message}`);
    }
    note(id, freed, n);
  }
  audit('storage.cleanup', { categories: ids, freed: result.freed, deleted: result.deleted, errors: result.errors.length });
  return result;
}

module.exports = { plan, cleanup, sitesUsage, parseSize, RULES, IDS, _deps: deps };
