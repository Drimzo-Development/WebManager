'use strict';
// Bridge between the dashboard and the host-side update helper (scripts/update-helper.sh).
// The agent never runs the update itself: it only reads the status files the helper writes into
// DATA_DIR/update and drops a tiny request file the host's systemd path unit picks up.
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { ValidationError } = require('./validate');

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?$/;
const LOG_RE = /^update-request-[0-9]{8}-[0-9]{6}\.log$/;
const MAX_FILE = 1024 * 1024;
const MAX_NOTES = 8000;

const dir = () => path.join(config.DATA_DIR, 'update');
const logDir = () => path.dirname(config.AUDIT_LOG);

function readJson(name) {
  try {
    const file = path.join(dir(), name);
    if (fs.statSync(file).size > MAX_FILE) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** Reduces the (untrusted) release list to the few fields the dashboard shows. */
function releases(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw.slice(0, 30)) {
    if (!r || typeof r !== 'object' || r.draft || r.prerelease) continue;
    const version = str(r.tag_name, 40).replace(/^v/, '');
    if (!VERSION_RE.test(version)) continue;
    const url = str(r.html_url, 500);
    out.push({
      version,
      name: str(r.name, 120),
      notes: str(r.body, MAX_NOTES),
      url: url.startsWith('https://') ? url : '',
      publishedAt: str(r.published_at || r.created_at, 40),
    });
  }
  return out;
}

/**
 * Release notes and publication dates from releases.json of the update server (written by the host helper), by version.
 * The file is untrusted: only these two strings per version are used, truncated.
 */
function serverNotes(raw) {
  const out = new Map();
  const list = raw && typeof raw === 'object' && Array.isArray(raw.releases) ? raw.releases : [];
  for (const r of list.slice(0, 100)) {
    if (!r || typeof r !== 'object') continue;
    const version = str(r.version, 40).replace(/^v/, '');
    if (!VERSION_RE.test(version)) continue;
    out.set(version, { notes: str(r.notes, MAX_NOTES).trim(), publishedAt: str(r.published, 40) });
  }
  return out;
}

/** The releases of the helper's list, completed with the notes and dates of the update server where the list has none. */
function withNotes(list, raw) {
  const info = serverNotes(raw);
  return list.map((r) => {
    const s = info.get(r.version);
    return s ? { ...r, notes: r.notes || s.notes, publishedAt: r.publishedAt || s.publishedAt } : r;
  });
}

function logTail(state) {
  const name = state && typeof state.log === 'string' ? state.log : '';
  if (!LOG_RE.test(name)) return '';
  try {
    const buf = fs.readFileSync(path.join(logDir(), name));
    return buf.subarray(Math.max(0, buf.length - 6000)).toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
  } catch (_) {
    return '';
  }
}

/** Compares the numeric part (major.minor.patch) of two versions; pre-release suffixes are ignored. Returns null if one is not a version. */
function compareVersions(a, b) {
  const parse = (v) => { const m = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(String(v)); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The oldest version the project still supports (from the update server) and whether the installed one is at least that. */
function supportInfo(meta) {
  const raw = str(meta && meta.minSupported, 40);
  const minSupported = /^[0-9]+\.[0-9]+\.[0-9]+$/.test(raw) ? raw : '';
  const cmp = minSupported ? compareVersions(config.version, minSupported) : null;
  return { minSupported, supported: cmp === null || cmp >= 0 };
}

const cmpVer = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

/**
 * What "Roll back to the previous version" would restore (same selection as scripts/rollback.sh): the newest program backup of an OLDER
 * version and the newest database dump of that version taken before it. Names carry a YYYYMMDD-HHMMSS stamp.
 */
function rollbackInfo() {
  const read = (d) => { try { return fs.readdirSync(d); } catch (_) { return []; } };
  const backups = path.join(config.DATA_DIR, 'backups');
  const dumpDir = path.join(config.DATA_DIR, 'database-backups');
  const trees = read(backups).map((n) => { const m = /^app-tree-([0-9]+\.[0-9]+\.[0-9]+)-([0-9]{8}-[0-9]{6})\.tar\.gz$/.exec(n); return m ? { n, ver: m[1], stamp: m[2] } : null; }).filter(Boolean).sort((x, y) => (x.stamp < y.stamp ? 1 : -1));
  const dumps = read(dumpDir).map((n) => { const m = /^db-([0-9]{8}-[0-9]{6})-v([0-9]+\.[0-9]+\.[0-9]+)\.sql\.gz$/.exec(n); return m ? { n, stamp: m[1], ver: m[2] } : null; }).filter(Boolean).sort((x, y) => (x.stamp < y.stamp ? 1 : -1));
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(config.version))) return { available: false };
  for (const t of trees) {
    if (t.ver === config.version || cmpVer(t.ver, config.version) > 0) continue;
    const d = dumps.find((x) => x.ver === t.ver && x.stamp <= t.stamp);
    if (!d) return { available: false, version: t.ver, reason: 'The matching database dump from before the update is missing.' };
    const at = (file) => { try { return fs.statSync(file).mtime.toISOString(); } catch (_) { return ''; } };
    return { available: true, version: t.ver, treeAt: at(path.join(backups, t.n)), dumpAt: at(path.join(dumpDir, d.n)) };
  }
  return { available: false };
}

/** Automatic update settings (written by setAuto, read by the host helper): mode "off" | "patch", window from/to as full hours (server time). */
function autoConfig() {
  const j = readJson('auto.json') || {};
  const hour = (v, d) => (Number.isInteger(v) && v >= 0 && v <= 23 ? v : d);
  return { mode: j.mode === 'patch' ? 'patch' : 'off', from: hour(j.from, 2), to: hour(j.to, 5) };
}

function status() {
  const installed = fs.existsSync(dir());
  const meta = readJson('meta.json') || {};
  const state = readJson('state.json');
  const autoState = readJson('auto-state.json');
  return {
    version: config.version,
    auto: autoConfig(),
    rollback: rollbackInfo(),
    autoState: autoState ? { version: str(autoState.version, 40), state: str(autoState.state, 20), at: str(autoState.at, 40) } : null,
    helperInstalled: installed,
    canApply: installed && meta.apply === true,
    checkedAt: str(meta.checkedAt, 40),
    checkError: str(meta.error, 300),
    ...supportInfo(meta),
    releases: withNotes(releases(readJson('latest.json')), readJson('releases.json')),
    state: state ? { state: str(state.state, 20), version: str(state.version, 40), at: str(state.at, 40), log: str(state.log, 80), auto: state.auto === true, kind: state.kind === 'rollback' ? 'rollback' : 'update' } : null,
    requestPending: fs.existsSync(path.join(dir(), 'request')),
    logTail: logTail(state),
  };
}

/** action: 'check' | 'update' (+ version). Written atomically; the host helper validates it again. */
function request(body) {
  const action = String(body.action || '');
  if (action !== 'check' && action !== 'update' && action !== 'rollback') throw new ValidationError('Unknown action');
  let line = 'check';
  if (action === 'rollback') {
    if (!rollbackInfo().available) throw new ValidationError('Rolling back is not possible: there is no matching backup of the state before the last update.');
    line = 'rollback';
  }
  if (action === 'update') {
    const version = String(body.version || '');
    if (!VERSION_RE.test(version)) throw new ValidationError('Invalid version number');
    line = `update ${version}`;
  }
  if (!fs.existsSync(dir())) throw new ValidationError('The update helper is not set up on the server. Please run update.sh once on the server.');
  const target = path.join(dir(), 'request');
  if (fs.existsSync(target)) throw new ValidationError('A request is already pending.');
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${line}\n`, { mode: 0o644 });
  fs.renameSync(tmp, target);
  return { requested: line };
}

/**
 * Switches automatic updates of patch versions (same major.minor) on or off. Saving also lifts a pause after a failed automatic attempt.
 * The host helper still validates everything again and only ever installs releases of the configured source.
 */
function setAuto(body) {
  const mode = String(body.mode || '');
  if (mode !== 'off' && mode !== 'patch') throw new ValidationError('Unknown mode');
  const from = Number(body.from);
  const to = Number(body.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > 23 || to < 0 || to > 23) throw new ValidationError('The times must be full hours between 0 and 23');
  if (!fs.existsSync(dir())) throw new ValidationError('The update helper is not set up on the server. Please run update.sh once on the server.');
  const target = path.join(dir(), 'auto.json');
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ mode, from, to })}\n`, { mode: 0o644 });
  fs.renameSync(tmp, target);
  fs.rmSync(path.join(dir(), 'auto-state.json'), { force: true });
  return { mode, from, to };
}

module.exports = { status, request, setAuto, releases, withNotes, supportInfo, compareVersions, VERSION_RE };
