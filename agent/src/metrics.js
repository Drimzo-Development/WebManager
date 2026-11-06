'use strict';
/**
 * History of resource usage and traffic per website, without tracking scripts:
 *  - CPU and memory come from `docker stats` (once a minute),
 *  - requests, status classes, traffic volume, top pages and firewall events come from the proxy access log.
 * Everything is stored in plain files below DATA_DIR/metrics/<site>/ (no IP addresses; visitors are only counted
 * through short-lived one-way identifiers that are deleted after two days).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');
const proxylog = require('./proxylog');
const sites = require('./sites');

const DIR = path.join(config.DATA_DIR, 'metrics');
const MINUTE = 60000;
const KEEP_DAYS = 35;
const MAX_KEYS = 3000;
const ASSET_RE = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|mp4|webm|mp3|json|xml|txt|pdf)$/i;
const RANGES = { '1h': [3600, 60], '24h': [86400, 300], '7d': [604800, 1800], '30d': [2592000, 7200] }; // [seconds, bucket seconds]

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const siteDir = (id) => path.join(DIR, `site-${String(id).padStart(3, '0')}`);

// ---------------------------------------------------------------- in-memory state
let hostMap = new Map(); // domain -> site id
const buckets = new Map(); // site id -> counters of the current minute
const daily = new Map(); // site id -> { day, pages, p404, waf, recentWaf, visitors:Set, salt }

function newBucket() { return { req: 0, s2: 0, s3: 0, s4: 0, s5: 0, bytes: 0, waf: 0 }; }

function loadDaily(id, d) {
  const dir = siteDir(id);
  let base = { day: d, pages: {}, p404: {}, waf: {}, recentWaf: [] };
  try { base = { ...base, ...JSON.parse(fs.readFileSync(path.join(dir, `d-${d}.json`), 'utf8')), day: d }; } catch (_) { /* first start today */ }
  let salt = crypto.randomBytes(8).toString('hex');
  const visitors = new Set();
  try {
    const lines = fs.readFileSync(path.join(dir, `v-${d}.txt`), 'utf8').split('\n').filter(Boolean);
    if (lines.length) { salt = lines[0]; for (const l of lines.slice(1)) visitors.add(l); }
  } catch (_) { /* none yet */ }
  return { ...base, visitors, salt, newVisitors: [], saltWritten: visitors.size > 0 };
}

function dailyFor(id, now) {
  const d = day(now);
  let st = daily.get(id);
  if (!st || st.day !== d) { st = loadDaily(id, d); daily.set(id, st); }
  return st;
}

function bump(map, key) {
  if (map[key] !== undefined) map[key]++;
  else if (Object.keys(map).length < MAX_KEYS) map[key] = 1;
}

/** Subscriber for new proxy log entries. */
function onEntries(entries) {
  const now = Date.now();
  for (const e of entries) {
    const id = hostMap.get(e.host);
    if (!id) continue;
    const st = dailyFor(id, now);
    if (e.waf) {
      bump(st.waf, e.waf);
      st.recentWaf.push({ t: now, ip: e.ip, cat: e.waf, request: e.request.slice(0, 200), status: e.status });
      if (st.recentWaf.length > 50) st.recentWaf.shift();
      const b = buckets.get(id) || newBucket();
      b.waf++;
      buckets.set(id, b);
      continue; // the same request also appears as a normal log line
    }
    const b = buckets.get(id) || newBucket();
    b.req++;
    b.bytes += e.bytes;
    if (e.status >= 500) b.s5++; else if (e.status >= 400) b.s4++; else if (e.status >= 300) b.s3++; else b.s2++;
    buckets.set(id, b);
    const p = e.path.slice(0, 120);
    if (e.status === 404) bump(st.p404, p);
    else if (e.status < 400 && (e.method === 'GET' || e.method === 'HEAD') && !ASSET_RE.test(p)) bump(st.pages, p);
    if (e.status < 400) {
      const h = crypto.createHash('sha256').update(`${st.salt}${e.ip}`).digest('hex').slice(0, 12);
      if (!st.visitors.has(h)) { st.visitors.add(h); st.newVisitors.push(h); }
    }
  }
}

// ---------------------------------------------------------------- persistence
function atomicWrite(file, content) {
  fs.writeFileSync(`${file}.tmp`, content, { mode: 0o640 });
  fs.renameSync(`${file}.tmp`, file);
}

function saveDaily(id, st) {
  const dir = siteDir(id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  atomicWrite(path.join(dir, `d-${st.day}.json`), JSON.stringify({ pages: st.pages, p404: st.p404, waf: st.waf, recentWaf: st.recentWaf, visitors: st.visitors.size }));
  if (st.newVisitors.length || !st.saltWritten) {
    const lines = (st.saltWritten ? [] : [st.salt]).concat(st.newVisitors);
    fs.appendFileSync(path.join(dir, `v-${st.day}.txt`), `${lines.join('\n')}\n`, { mode: 0o600 });
    st.saltWritten = true;
    st.newVisitors = [];
  }
}

function cleanup(now) {
  let names = [];
  try { names = fs.readdirSync(DIR); } catch (_) { return; }
  const cutMetrics = day(now - KEEP_DAYS * 86400000);
  const cutVisitors = day(now - 2 * 86400000);
  for (const n of names) {
    const dir = path.join(DIR, n);
    let files = [];
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of files) {
      const m = /^([mdv])-(\d{4}-\d{2}-\d{2})\.(?:jsonl|json|txt)$/.exec(f);
      if (!m) continue;
      if ((m[1] === 'v' && m[2] < cutVisitors) || (m[1] !== 'v' && m[2] < cutMetrics)) fs.rmSync(path.join(dir, f), { force: true });
    }
  }
}

// ---------------------------------------------------------------- the minute tick
function refreshHosts() {
  const map = new Map();
  for (const id of sites.listSiteIds()) {
    const spec = sites.loadSpec(id);
    if (spec && Array.isArray(spec.domains)) for (const d of spec.domains) map.set(d.toLowerCase(), id);
  }
  hostMap = map;
}

async function tick() {
  const now = Date.now();
  refreshHosts();
  const ids = [...new Set(hostMap.values())];
  let stats = {};
  try { stats = await sites.stats(ids); } catch (_) { /* leave empty: the point is written without resource values */ }
  const t = Math.floor(now / MINUTE) * MINUTE;
  for (const id of ids) {
    const b = buckets.get(id) || newBucket();
    buckets.delete(id);
    const s = stats[id];
    const rec = { t, cpu: s ? Math.round(s.cpuPercent * 10) / 10 : null, mem: s ? s.memBytes : null, memLimit: s ? s.memLimitBytes : null, ...b };
    const dir = siteDir(id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    fs.appendFileSync(path.join(dir, `m-${day(t)}.jsonl`), `${JSON.stringify(rec)}\n`, { mode: 0o640 });
    saveDaily(id, dailyFor(id, now));
  }
  if (new Date(now).getUTCMinutes() === 7) cleanup(now);
}

let timer = null;
function start() {
  if (timer) return;
  refreshHosts();
  proxylog.subscribe(onEntries);
  timer = setInterval(() => { tick().catch((e) => process.stderr.write(`[agent] metrics: ${e.message}\n`)); }, MINUTE);
  timer.unref();
}

// ---------------------------------------------------------------- queries
function readMinutes(id, fromMs, toMs) {
  const out = [];
  for (let d = fromMs - (fromMs % 86400000); d <= toMs; d += 86400000) {
    let text = '';
    try { text = fs.readFileSync(path.join(siteDir(id), `m-${day(d)}.jsonl`), 'utf8'); } catch (_) { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r.t >= fromMs && r.t <= toMs) out.push(r);
      } catch (_) { /* partial line */ }
    }
  }
  return out;
}

/** Groups minute records into buckets: sums for counters, averages for CPU/memory. */
function downsample(rows, bucketSec, fromMs, toMs) {
  const size = bucketSec * 1000;
  const map = new Map();
  for (const r of rows) {
    const k = Math.floor(r.t / size) * size;
    let b = map.get(k);
    if (!b) { b = { t: k, req: 0, s2: 0, s3: 0, s4: 0, s5: 0, bytes: 0, waf: 0, cpuSum: 0, cpuN: 0, memSum: 0, memN: 0, memMax: 0, memLimit: 0 }; map.set(k, b); }
    for (const f of ['req', 's2', 's3', 's4', 's5', 'bytes', 'waf']) b[f] += r[f] || 0;
    if (r.cpu !== null && r.cpu !== undefined) { b.cpuSum += r.cpu; b.cpuN++; }
    if (r.mem !== null && r.mem !== undefined) { b.memSum += r.mem; b.memN++; b.memMax = Math.max(b.memMax, r.mem); }
    if (r.memLimit) b.memLimit = r.memLimit;
  }
  const points = [];
  for (let k = Math.floor(fromMs / size) * size; k <= toMs; k += size) {
    const b = map.get(k);
    points.push(b
      ? { t: k, req: b.req, s2: b.s2, s3: b.s3, s4: b.s4, s5: b.s5, bytes: b.bytes, waf: b.waf, cpu: b.cpuN ? Math.round((b.cpuSum / b.cpuN) * 10) / 10 : null, mem: b.memN ? Math.round(b.memSum / b.memN) : null, memLimit: b.memLimit || null }
      : { t: k, req: 0, s2: 0, s3: 0, s4: 0, s5: 0, bytes: 0, waf: 0, cpu: null, mem: null, memLimit: null });
  }
  return points;
}

function topOf(map, n) {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n).map(([p, c]) => ({ path: p, count: c }));
}

function query(id, rangeKey) {
  const range = RANGES[rangeKey];
  if (!range) throw Object.assign(new Error('Unknown period'), { status: 422 });
  const now = Date.now();
  const from = now - range[0] * 1000;
  const rows = readMinutes(id, from, now);
  const points = downsample(rows, range[1], from, now);
  const totals = { req: 0, s2: 0, s3: 0, s4: 0, s5: 0, bytes: 0, waf: 0 };
  for (const r of rows) for (const k of Object.keys(totals)) totals[k] += r[k] || 0;

  const pages = {};
  const p404 = {};
  const waf = {};
  const visitors = [];
  let recent = [];
  for (let d = from - (from % 86400000); d <= now; d += 86400000) {
    let sum = null;
    const live = daily.get(id);
    if (live && live.day === day(d)) sum = { pages: live.pages, p404: live.p404, waf: live.waf, recentWaf: live.recentWaf, visitors: live.visitors.size };
    else { try { sum = JSON.parse(fs.readFileSync(path.join(siteDir(id), `d-${day(d)}.json`), 'utf8')); } catch (_) { continue; } }
    for (const [k, v] of Object.entries(sum.pages || {})) pages[k] = (pages[k] || 0) + v;
    for (const [k, v] of Object.entries(sum.p404 || {})) p404[k] = (p404[k] || 0) + v;
    for (const [k, v] of Object.entries(sum.waf || {})) waf[k] = (waf[k] || 0) + v;
    visitors.push({ day: day(d), n: sum.visitors || 0 });
    recent = recent.concat(sum.recentWaf || []);
  }
  recent.sort((a, b) => b.t - a.t);
  return { range: rangeKey, from, to: now, bucketSec: range[1], points, totals, topPages: topOf(pages, 15), top404: topOf(p404, 10), visitors, waf, recentWaf: recent.slice(0, 30) };
}

/** Sums and extremes of minute records for the weekly report. */
function summarize(rows) {
  const r = { req: 0, s2: 0, s3: 0, s4: 0, s5: 0, bytes: 0, waf: 0, peakReq: 0, peakAt: null, cpuSum: 0, cpuN: 0, cpuMax: 0, memMax: 0, memLimit: 0, minutes: rows.length };
  for (const m of rows) {
    for (const f of ['req', 's2', 's3', 's4', 's5', 'bytes', 'waf']) r[f] += m[f] || 0;
    if ((m.req || 0) > r.peakReq) { r.peakReq = m.req; r.peakAt = m.t; }
    if (m.cpu !== null && m.cpu !== undefined) { r.cpuSum += m.cpu; r.cpuN++; r.cpuMax = Math.max(r.cpuMax, m.cpu); }
    if (m.mem !== null && m.mem !== undefined) r.memMax = Math.max(r.memMax, m.mem);
    if (m.memLimit) r.memLimit = m.memLimit;
  }
  return r;
}

/**
 * Weekly report data: the last `days` days against the days before. The average rate is spread over the whole period
 * (not only the minutes that were recorded), so a quiet website shows a small number instead of an inflated one.
 */
function report(id, days = 7, now = Date.now()) {
  const span = days * 86400000;
  const cur = summarize(readMinutes(id, now - span, now));
  const prev = summarize(readMinutes(id, now - 2 * span, now - span - 1));
  const mins = days * 1440;
  const pages = {};
  const p404 = {};
  const waf = {};
  const visitors = [];
  for (let d = now - span - ((now - span) % 86400000); d <= now; d += 86400000) {
    let sum = null;
    const live = daily.get(id);
    if (live && live.day === day(d)) sum = { pages: live.pages, p404: live.p404, waf: live.waf, visitors: live.visitors.size };
    else { try { sum = JSON.parse(fs.readFileSync(path.join(siteDir(id), `d-${day(d)}.json`), 'utf8')); } catch (_) { continue; } }
    for (const [k, v] of Object.entries(sum.pages || {})) pages[k] = (pages[k] || 0) + v;
    for (const [k, v] of Object.entries(sum.p404 || {})) p404[k] = (p404[k] || 0) + v;
    for (const [k, v] of Object.entries(sum.waf || {})) waf[k] = (waf[k] || 0) + v;
    visitors.push({ day: day(d), n: sum.visitors || 0 });
  }
  return {
    days, from: now - span, to: now,
    current: { ...cur, avgPerMin: cur.req / mins, errorRate: cur.req ? (cur.s4 + cur.s5) / cur.req : 0, cpuAvg: cur.cpuN ? cur.cpuSum / cur.cpuN : null },
    previous: { ...prev, avgPerMin: prev.req / mins, errorRate: prev.req ? (prev.s4 + prev.s5) / prev.req : 0 },
    visitors, topPages: topOf(pages, 10), top404: topOf(p404, 5), waf,
  };
}

module.exports = { start, query, report, summarize, onEntries, downsample, RANGES };
