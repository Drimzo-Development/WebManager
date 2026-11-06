'use strict';
/**
 * Single reader for the reverse proxy's access log (stdout of the proxy container, see docker/proxy/nginx.conf).
 * Everything that needs request statistics (flood protection, metrics) subscribes here instead of reading logs itself.
 */
const { config } = require('./config');
const { docker } = require('./docker');

const POLL_MS = 15000;
// $remote_addr - [$time_local] "$host" "$request" $status $body_bytes_sent "$http_user_agent" rt=...
// (the WAF writes the same line shape with the user agent replaced by "WAF:<category>")
const LINE_RE = /^(\S+) - \[[^\]]+\] "([^"]*)" "([^"]*)" (\d{3}) (\d+|-) "([^"]*)"/;

/** Normalises "::ffff:1.2.3.4" to the IPv4 address. */
function normalizeIp(ip) {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m ? m[1] : ip.toLowerCase();
}

/** One log line -> { ip, host, method, path, query, request, status, bytes, waf } or null. waf is the category of a firewall event line. */
function parseLine(line) {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const parts = m[3].split(' ');
  const target = parts[1] || '';
  const q = target.indexOf('?');
  const ua = m[6];
  return {
    ip: normalizeIp(m[1]),
    host: m[2].toLowerCase(),
    method: parts[0] || '',
    path: q < 0 ? target : target.slice(0, q),
    request: m[3],
    status: Number(m[4]),
    bytes: m[5] === '-' ? 0 : Number(m[5]),
    waf: ua.startsWith('WAF:') ? ua.slice(4) : null,
  };
}

const subscribers = new Set();
let lastTs = null;
let timer = null;
let busy = false;

function subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

async function poll() {
  if (busy || !subscribers.size) return;
  busy = true;
  try {
    const args = ['logs', '--timestamps', '--since', lastTs || new Date(Date.now() - POLL_MS).toISOString(), config.proxyContainer];
    const r = await docker(args, { timeout: 20000 });
    if (r.code !== 0) return;
    const rows = [];
    for (const raw of `${r.stdout}\n${r.stderr}`.split('\n')) {
      const sp = raw.indexOf(' ');
      if (sp < 20) continue;
      const ts = raw.slice(0, sp);
      if (lastTs && ts <= lastTs) continue;
      rows.push({ ts, line: raw.slice(sp + 1) });
    }
    rows.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    if (rows.length) lastTs = rows[rows.length - 1].ts;
    const entries = [];
    for (const { line } of rows) {
      const e = parseLine(line);
      if (e) entries.push(e);
    }
    if (entries.length) for (const fn of subscribers) { try { fn(entries); } catch (err) { process.stderr.write(`[agent] proxylog subscriber: ${err.message}\n`); } }
  } finally {
    busy = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => { poll().catch((e) => process.stderr.write(`[agent] proxylog: ${e.message}\n`)); }, POLL_MS);
  timer.unref();
}

module.exports = { start, subscribe, parseLine, normalizeIp, poll };
