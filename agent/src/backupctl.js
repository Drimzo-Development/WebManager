'use strict';
// Bridge between the dashboard and the host-side backup helper (scripts/backup-remote.sh): reads the status files the helper
// writes into DATA_DIR/backup-ctl and drops a tiny request file ("backup", "upload", "verify", "verify-remote") that a systemd
// path unit on the host picks up. Credentials of the external target never leave the host; nothing here can change them.
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { ValidationError } = require('./validate');

const ACTIONS = ['backup', 'upload', 'verify', 'verify-remote'];
const LOG_RE = /^backup-request-[0-9]{8}-[0-9]{6}\.log$/;
const FILE_RE = /^webmanager-backup-[0-9]{8}-[0-9]{6}-v[0-9][0-9A-Za-z.-]*\.tar\.gz(\.gpg)?$/;
const MAX_FILE = 256 * 1024;

const dir = () => path.join(config.DATA_DIR, 'backup-ctl');
const logDir = () => path.dirname(config.AUDIT_LOG);

function readJson(file) {
  try {
    if (fs.statSync(file).size > MAX_FILE) return null;
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch (_) {
    return null;
  }
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

function result(j, extra = []) {
  if (!j) return null;
  const out = { ok: j.ok === true, at: str(j.at, 40) };
  for (const k of extra) out[k] = typeof j[k] === 'number' ? num(j[k]) : str(j[k], 300);
  return out;
}

function localFiles() {
  const base = path.join(config.DATA_DIR, 'backups');
  try {
    return fs.readdirSync(base).filter((n) => FILE_RE.test(n)).map((n) => {
      const st = fs.statSync(path.join(base, n));
      return { name: n, bytes: st.size, at: st.mtime.toISOString(), encrypted: n.endsWith('.gpg') };
    }).sort((a, b) => (a.name < b.name ? 1 : -1)).slice(0, 30);
  } catch (_) {
    return [];
  }
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

/** Short summary for /v1/system (alert checks of the worker). */
function summary() {
  const meta = readJson(path.join(dir(), 'meta.json')) || {};
  return {
    configured: meta.configured === true,
    upload: result(readJson(path.join(dir(), 'upload.json'))),
    verify: result(readJson(path.join(dir(), 'verify.json'))),
  };
}

function status() {
  const installed = fs.existsSync(dir());
  const meta = readJson(path.join(dir(), 'meta.json')) || {};
  const state = readJson(path.join(dir(), 'state.json'));
  const remote = readJson(path.join(dir(), 'remote.json'));
  const keep = meta.keep && typeof meta.keep === 'object' ? meta.keep : {};
  const local = readJson(path.join(config.DATA_DIR, 'backup-status.json'));
  return {
    helperInstalled: installed,
    canApply: installed && meta.apply === true,
    configured: meta.configured === true,
    remote: str(meta.remote, 120),
    encrypted: meta.encrypted === true,
    keep: { daily: num(keep.daily), weekly: num(keep.weekly), monthly: num(keep.monthly) },
    remoteInfo: remote ? { count: num(remote.count), bytes: num(remote.bytes), at: str(remote.at, 40) } : null,
    lastUpload: result(readJson(path.join(dir(), 'upload.json')), ['file', 'size', 'error']),
    lastVerify: result(readJson(path.join(dir(), 'verify.json')), ['file', 'scope', 'detail', 'seconds']),
    lastBackup: local ? { ok: local.ok === true, at: str(local.at, 40), kind: str(local.kind, 10), version: str(local.version, 30) } : null,
    localFiles: localFiles(),
    state: state ? { state: str(state.state, 20), action: str(state.action, 20), at: str(state.at, 40) } : null,
    requestPending: fs.existsSync(path.join(dir(), 'request')),
    logTail: logTail(state),
  };
}

function request(body) {
  const action = String(body.action || '');
  if (!ACTIONS.includes(action)) throw new ValidationError('Unknown action');
  if (!fs.existsSync(dir())) throw new ValidationError('The backup helper is not set up on the server. Please run update.sh once on the server.');
  const target = path.join(dir(), 'request');
  if (fs.existsSync(target)) throw new ValidationError('A request is already pending.');
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${action}\n`, { mode: 0o644 });
  fs.renameSync(tmp, target);
  return { requested: action };
}

module.exports = { status, summary, request, ACTIONS };
