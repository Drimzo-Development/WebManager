'use strict';
/**
 * Application-layer flood protection for the reverse proxy: temporary automatic bans for addresses that send
 * far too many requests or mostly failing requests, plus manual bans. Bans are rendered into an nginx `geo` map
 * (value 1 = banned) which every proxied location checks; banned clients are dropped without an answer (444).
 *
 * This does NOT replace upstream DDoS protection: traffic that saturates the server's network link never
 * reaches nginx. It stops the common cases (scrapers, brute force, small floods, runaway clients).
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { audit } = require('./audit');
const proxy = require('./proxy');
const { netList, int, ValidationError } = require('./validate');
const geo = require('./geo');
const proxylog = require('./proxylog');

const CONFIG_FILE = path.join(config.DATA_DIR, 'runtime', 'protection.json');
const STATE_FILE = path.join(config.DATA_DIR, 'runtime', 'protection-bans.json');
const MAP_NAME = 'geo/banned-all.map';
const TICK_MS = 15000;
const MAX_BANS = 5000;
const ERROR_STATUS = new Set([400, 401, 403, 404, 405, 408, 413, 414, 429, 444, 499]);

const DEFAULTS = {
  autoBan: { enabled: false, maxRequests: 600, maxErrors: 150, windowSec: 60, banMinutes: 60 },
  whitelist: [],
  manual: [],
};

// ---------------------------------------------------------------- address helpers
function ipToBig(ip) {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) return { v: 4, n: v4.slice(1).reduce((a, o) => (a << 8n) + BigInt(o), 0n) };
  if (!/^[0-9a-fA-F:.]+$/.test(ip) || !ip.includes(':')) return null;
  let s = ip;
  const tail4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail4) {
    const o = tail4[2].split('.').map(Number);
    s = `${tail4[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && head.length !== 8) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return { v: 6, n: groups.reduce((a, g) => (a << 16n) + BigInt(`0x${g}`), 0n) };
}

function ipInNet(ip, net) {
  const a = ipToBig(ip);
  const [base, prefix] = net.split('/');
  const b = ipToBig(base);
  if (!a || !b || a.v !== b.v) return false;
  const bits = a.v === 4 ? 32n : 128n;
  const len = prefix === undefined ? bits : BigInt(prefix);
  const shift = bits - len;
  return (a.n >> shift) === (b.n >> shift);
}

const { normalizeIp } = proxylog;
const inAny = (ip, nets) => nets.some((n) => ipInNet(ip, n));

// ---------------------------------------------------------------- request counting
/** One log line -> { ip, host, status } or null (kept for the tests; parsing is shared in proxylog). */
function parseAccessLine(line) {
  const e = proxylog.parseLine(line);
  return e ? { ip: e.ip, host: e.host, status: e.status } : null;
}

/** Sliding window of per-address request counts in 5 second buckets. */
class Tracker {
  constructor() { this.buckets = new Map(); }

  add(ip, status, nowMs) {
    const t = Math.floor(nowMs / 5000);
    let list = this.buckets.get(ip);
    if (!list) { list = []; this.buckets.set(ip, list); }
    let b = list[list.length - 1];
    if (!b || b.t !== t) { b = { t, total: 0, err: 0 }; list.push(b); }
    b.total++;
    if (ERROR_STATUS.has(status)) b.err++;
  }

  totals(ip, windowSec, nowMs) {
    const min = Math.floor(nowMs / 5000) - Math.ceil(windowSec / 5);
    const list = this.buckets.get(ip) || [];
    let total = 0;
    let err = 0;
    for (const b of list) if (b.t > min) { total += b.total; err += b.err; }
    return { total, err };
  }

  /** Drops buckets that fell out of the window; returns the addresses still being tracked. */
  prune(windowSec, nowMs) {
    const min = Math.floor(nowMs / 5000) - Math.ceil(windowSec / 5);
    for (const [ip, list] of this.buckets) {
      const keep = list.filter((b) => b.t > min);
      if (keep.length) this.buckets.set(ip, keep); else this.buckets.delete(ip);
    }
    return [...this.buckets.keys()];
  }
}

/** Why an address should be banned, or null. */
function banReason(totals, cfg) {
  if (totals.total >= cfg.maxRequests) return `${totals.total} requests in ${cfg.windowSec} s`;
  if (totals.err >= cfg.maxErrors) return `${totals.err} erroneous requests in ${cfg.windowSec} s`;
  return null;
}

// ---------------------------------------------------------------- configuration
function validateConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Configuration missing');
  const a = raw.autoBan || {};
  return {
    autoBan: {
      enabled: a.enabled === true,
      maxRequests: int(a.maxRequests ?? DEFAULTS.autoBan.maxRequests, 50, 100000, 'Requests per time window'),
      maxErrors: int(a.maxErrors ?? DEFAULTS.autoBan.maxErrors, 10, 100000, 'Erroneous requests per time window'),
      windowSec: int(a.windowSec ?? DEFAULTS.autoBan.windowSec, 10, 600, 'Time window'),
      banMinutes: int(a.banMinutes ?? DEFAULTS.autoBan.banMinutes, 1, 10080, 'Ban duration'),
    },
    whitelist: netList(raw.whitelist),
    manual: netList(raw.manual),
  };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

let cfg = (() => { try { return validateConfig(readJson(CONFIG_FILE, DEFAULTS)); } catch (_) { return validateConfig(DEFAULTS); } })();
let bans = readJson(STATE_FILE, { auto: {} });
if (!bans.auto || typeof bans.auto !== 'object') bans = { auto: {} };
const tracker = new Tracker();

function protectedNets() {
  return [...geo.ALWAYS_ALLOWED, ...cfg.whitelist, ...config.publicIps];
}

/** Content of the nginx map: manual bans and active automatic bans. */
function renderBanMap(manual, autoIps) {
  const seen = new Set();
  const lines = [];
  for (const n of [...manual, ...autoIps]) {
    if (geo.ALWAYS_ALLOWED.includes(n)) continue; // a ban on a local network would make nginx reject the map
    if (!seen.has(n)) { seen.add(n); lines.push(`${n} 1;`); }
  }
  return `# Generated by WebManager (bans)\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

async function applyBans() {
  const content = renderBanMap(cfg.manual, Object.keys(bans.auto));
  const r = await proxy.installVhost(MAP_NAME, content);
  return r;
}

async function setConfig(raw) {
  cfg = validateConfig(raw);
  writeJson(CONFIG_FILE, cfg);
  // whitelisting an address lifts its automatic ban
  for (const ip of Object.keys(bans.auto)) if (inAny(ip, cfg.whitelist)) delete bans.auto[ip];
  writeJson(STATE_FILE, bans);
  await applyBans();
  audit('protect.config', { autoBan: cfg.autoBan.enabled, whitelist: cfg.whitelist.length, manual: cfg.manual.length });
  return status();
}

async function unban(ip) {
  if (!ipToBig(normalizeIp(ip))) throw new ValidationError('Invalid IP address');
  delete bans.auto[normalizeIp(ip)];
  writeJson(STATE_FILE, bans);
  await applyBans();
  audit('protect.unban', { ip });
  return status();
}

function status() {
  const now = Date.now();
  return {
    config: cfg,
    bans: Object.entries(bans.auto)
      .map(([ip, b]) => ({ ip, until: new Date(b.until).toISOString(), reason: b.reason, since: b.since ? new Date(b.since).toISOString() : null }))
      .filter((b) => Date.parse(b.until) > now)
      .sort((a, b) => a.ip.localeCompare(b.ip)),
  };
}

// ---------------------------------------------------------------- the loop
/** Called with every batch of new proxy log entries (firewall duplicates of normal lines are skipped). */
function onEntries(entries) {
  if (!cfg.autoBan.enabled) return;
  const now = Date.now();
  for (const e of entries) if (!e.waf) tracker.add(e.ip, e.status, now);
}

async function tick() {
  const now = Date.now();
  let changed = false;
  for (const [ip, b] of Object.entries(bans.auto)) {
    if (b.until <= now) { delete bans.auto[ip]; changed = true; }
  }
  if (cfg.autoBan.enabled) {
    const nets = protectedNets();
    for (const ip of tracker.prune(cfg.autoBan.windowSec, now)) {
      if (bans.auto[ip] || inAny(ip, nets) || !ipToBig(ip)) continue;
      const why = banReason(tracker.totals(ip, cfg.autoBan.windowSec, now), cfg.autoBan);
      if (!why) continue;
      if (Object.keys(bans.auto).length >= MAX_BANS) break;
      bans.auto[ip] = { since: now, until: now + cfg.autoBan.banMinutes * 60000, reason: why };
      audit('protect.ban', { ip, reason: why, minutes: cfg.autoBan.banMinutes });
      changed = true;
    }
  }
  if (changed) {
    writeJson(STATE_FILE, bans);
    await applyBans();
  }
}

let timer = null;
function start() {
  if (timer) return;
  proxylog.subscribe(onEntries);
  timer = setInterval(() => { tick().catch((e) => process.stderr.write(`[agent] protect: ${e.message}\n`)); }, TICK_MS);
  timer.unref();
  applyBans().catch((e) => process.stderr.write(`[agent] protect: ${e.message}\n`));
}

module.exports = {
  start, status, setConfig, unban, validateConfig, parseAccessLine, Tracker, onEntries, banReason, renderBanMap, ipInNet, normalizeIp, DEFAULTS,
};
