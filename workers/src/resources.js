'use strict';
/**
 * Resources per website: the worker samples the disk space of every website once a day (kept for 90 days); the notifications
 * (notify.js) warn about memory pressure, restarts after memory exhaustion (OOM kills) and websites that grow beyond a limit.
 */
const { q } = require('./db');
const agent = require('./agent');

const KEEP_DAYS = 90;
const SAMPLE_EVERY_MS = 23 * 3600 * 1000;
const dayUtc = (d) => d.toISOString().slice(0, 10);

/** Rows [siteId, day, bytes] from the agent's { sites: [{ site: 'site-001', bytes }] } for the websites that exist. */
function diskRows(usage, existingIds, day) {
  const known = new Set(existingIds.map(Number));
  const out = [];
  for (const u of usage || []) {
    const m = /^site-(\d{3,5})$/.exec(String(u.site || ''));
    const id = m ? parseInt(m[1], 10) : 0;
    if (!id || !known.has(id) || !Number.isFinite(u.bytes) || u.bytes < 0) continue;
    out.push([id, day, Math.round(u.bytes)]);
  }
  return out;
}

/** Called by the hourly scheduler; measures at most once a day (the measurement walks all files and takes a while). */
async function sampleDisk() {
  const [last] = await q("SELECT v FROM settings WHERE k = 'last_disk_sample'");
  if (last && Date.now() - Date.parse(last.v) < SAMPLE_EVERY_MS) return;
  const { sites: usage } = await agent.call('GET', '/v1/storage/sites', undefined, { timeoutMs: 20 * 60 * 1000 });
  const ids = (await q('SELECT id FROM sites')).map((r) => r.id);
  const rows = diskRows(usage, ids, dayUtc(new Date()));
  if (rows.length) await q('INSERT INTO site_disk (site_id, day, bytes) VALUES ? ON DUPLICATE KEY UPDATE bytes = VALUES(bytes)', [rows]);
  await q('REPLACE INTO settings (k, v) VALUES (?, ?)', ['last_disk_sample', new Date().toISOString()]);
  await q('DELETE FROM site_disk WHERE day < ?', [dayUtc(new Date(Date.now() - KEEP_DAYS * 86400000))]);
}

/**
 * State machine for "memory is high": the event 'high' is returned once after `need` consecutive high readings; a reading clearly below
 * the limit (5 points) resets it, so a value hovering around the limit does not repeat the message.
 */
function pressure(prev, percent, limit, need = 5) {
  const p = prev || { count: 0, notified: false };
  if (percent >= limit) {
    const count = p.count + 1;
    if (count >= need && !p.notified) return { state: { count, notified: true }, event: 'high' };
    return { state: { count, notified: p.notified }, event: null };
  }
  if (percent < limit - 5) return { state: { count: 0, notified: false }, event: null };
  return { state: p, event: null };
}

/** A restart since the last pass: { restarts, oom } or null (also null on the first pass, when there is nothing to compare). */
function restartEvent(prevCount, status) {
  if (prevCount === undefined || prevCount === null || !status || !Number.isInteger(status.restartCount)) return null;
  if (status.restartCount <= prevCount) return null;
  return { restarts: status.restartCount - prevCount, oom: !!status.oomKilled };
}

module.exports = { sampleDisk, diskRows, pressure, restartEvent, KEEP_DAYS };
