'use strict';
/**
 * HTTP availability check of the websites. The agent is not attached to the website networks, the proxy is: the request is made
 * with the busybox `wget` of the proxy container (`docker exec`) against the website container, exactly the way the proxy
 * reaches it. Only the answer is looked at (nothing is stored), the request does not pass the proxy's firewall rules.
 */
const { docker } = require('./docker');
const { config } = require('./config');
const sites = require('./sites');

const TIMEOUT_SEC = 8;
const PARALLEL = 4;

/**
 * Turns the result of `wget --spider -S` into { state: 'up'|'down'|'unknown', status, error }.
 * 'unknown' means "could not be measured" (proxy not running, wget differs): this never counts as an outage.
 */
function parseProbe(code, output) {
  const text = String(output || '');
  const codes = [...text.matchAll(/HTTP\/\d(?:\.\d)?\s+(\d{3})/g)].map((m) => parseInt(m[1], 10));
  if (codes.length) {
    const status = codes[codes.length - 1]; // after redirects the last answer counts
    return status >= 500
      ? { state: 'down', status, error: `HTTP ${status}` }
      : { state: 'up', status, error: null };
  }
  if (code === 124) return { state: 'down', status: null, error: 'Timeout' };
  if (/timed out|timeout/i.test(text)) return { state: 'down', status: null, error: 'Timeout' };
  if (/connection refused/i.test(text)) return { state: 'down', status: null, error: 'Connection refused' };
  if (/bad address|can't connect|unreachable|no route|reset by peer|connection closed/i.test(text)) {
    const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'No connection';
    return { state: 'down', status: null, error: line.replace(/^wget:\s*/, '').slice(0, 120) };
  }
  return { state: 'unknown', status: null, error: null };
}

async function probeOne(id) {
  const spec = sites.loadSpec(id);
  if (!spec || !spec.internalPort) return { state: 'unknown', status: null, error: null, ms: null };
  const n = sites.names(id);
  const url = `http://${n.container}:${spec.internalPort}/`;
  const started = Date.now();
  const r = await docker(['exec', config.proxyContainer, 'wget', '--spider', '-S', '-T', String(TIMEOUT_SEC), '-U', 'WebManager-Uptime', url], { timeout: (TIMEOUT_SEC + 6) * 1000 });
  const ms = Date.now() - started;
  // the proxy container is not running / docker is not reachable: not a statement about the website
  if (r.code === 127 || /No such container|is not running|is restarting|Cannot connect to the Docker daemon/i.test(r.stderr)) {
    return { state: 'unknown', status: null, error: null, ms: null };
  }
  return { ...parseProbe(r.code, `${r.stderr}\n${r.stdout}`), ms };
}

/** Checks the given website ids (a few at a time). Returns { [id]: { state, status, error, ms } }. */
async function probeSites(ids) {
  const list = [...new Set(ids)].filter((i) => Number.isInteger(i) && i > 0).slice(0, 500);
  const out = {};
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const id = list[next++];
      try { out[id] = await probeOne(id); } catch (_) { out[id] = { state: 'unknown', status: null, error: null, ms: null }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, list.length) }, worker));
  return out;
}

module.exports = { parseProbe, probeSites };
