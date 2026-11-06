'use strict';
/**
 * HTTP availability checks: once a minute the agent asks every running website (through the proxy's network, see agent/src/probe.js)
 * and the result is stored in `site_checks`. The history is shown in the dashboard; the notifications read the latest result.
 */
const { q } = require('./db');
const agent = require('./agent');

const KEEP_DAYS = 14;
const FRESH_MS = 3 * 60 * 1000; // a result older than this says nothing about the present
let busy = false;

// Times are written and read as UTC by the worker itself: the dashboard reads the table in a UTC session, the worker's own
// database session follows the server time zone, so `NOW()` and column defaults must not be mixed with it.
const sqlUtc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const parseUtc = (str) => Date.parse(`${String(str).replace(' ', 'T')}Z`);

/** Rows to store from the agent's answer: only measured results (not "unknown"). */
function rowsFrom(results) {
  const out = [];
  for (const [id, r] of Object.entries(results || {})) {
    const siteId = parseInt(id, 10);
    if (!Number.isInteger(siteId) || !r || (r.state !== 'up' && r.state !== 'down')) continue;
    out.push([siteId, r.state === 'up' ? 1 : 0, Number.isInteger(r.status) ? r.status : null, Number.isInteger(r.ms) ? Math.min(r.ms, 4294967295) : null, r.error ? String(r.error).slice(0, 160) : null]);
  }
  return out;
}

/** Is the website down according to its latest check? `latest` = { ok, ageMs } or null (no recent result: not down). */
function probeDown(latest) {
  return !!latest && !latest.ok && latest.ageMs <= FRESH_MS;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const sites = await q("SELECT id FROM sites WHERE lifecycle = 'ready' AND desired_state = 'running'");
    if (!sites.length) return;
    const { results } = await agent.call('GET', `/v1/probe?ids=${sites.map((s) => s.id).join(',')}`, undefined, { timeoutMs: 120000 });
    const rows = rowsFrom(results);
    const at = sqlUtc(new Date());
    if (rows.length) await q('INSERT INTO site_checks (site_id, ok, status_code, ms, error, checked_at) VALUES ?', [rows.map((r) => [...r, at])]);
  } catch (e) {
    process.stderr.write(`[worker] uptime: ${e.message}\n`);
  } finally {
    busy = false;
  }
}

/** Latest check of a website as { ok, ageMs, error } (or null). */
async function latest(siteId) {
  const [r] = await q('SELECT ok, error, checked_at FROM site_checks WHERE site_id = ? ORDER BY id DESC LIMIT 1', [siteId]);
  return r ? { ok: !!r.ok, ageMs: Date.now() - parseUtc(r.checked_at), error: r.error || '' } : null;
}

async function prune() {
  await q('DELETE FROM site_checks WHERE checked_at < ?', [sqlUtc(new Date(Date.now() - KEEP_DAYS * 86400000))]);
}

module.exports = { rowsFrom, probeDown, tick, latest, prune, KEEP_DAYS };
