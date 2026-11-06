'use strict';
/**
 * Maintenance windows: while one is active, notifications about the website (or, for a window without a website, about everything)
 * are muted. Times are UTC. The same rule is in app/Support/Maintenance.php (the dashboard shows what the worker applies).
 */
const { q } = require('./db');

const PERIOD = { daily: 86400000, weekly: 604800000 };
const parseUtc = (str) => Date.parse(`${String(str).replace(' ', 'T')}Z`);

/** Start (ms) of the occurrence that contains `now`, or null. `w` = { starts, ends, repeat } in ms. */
function currentStart(w, now) {
  if (now < w.starts) return null;
  const len = w.ends - w.starts;
  const period = PERIOD[w.repeat];
  const start = period ? w.starts + Math.floor((now - w.starts) / period) * period : w.starts;
  return now < start + len ? start : null;
}

/** { global, sites:Set } for the rows { site_id, starts_at, ends_at, repeat_every } at the moment `now`. */
function muteSet(rows, now = Date.now()) {
  const out = { global: false, sites: new Set() };
  for (const r of rows || []) {
    const w = { starts: parseUtc(r.starts_at), ends: parseUtc(r.ends_at), repeat: r.repeat_every };
    if (Number.isNaN(w.starts) || Number.isNaN(w.ends) || w.ends <= w.starts || currentStart(w, now) === null) continue;
    if (r.site_id === null || r.site_id === undefined) out.global = true;
    else out.sites.add(Number(r.site_id));
  }
  return out;
}

/** Is a message about `siteId` (null = not about one website) muted? */
function isMuted(mute, siteId) {
  if (!mute) return false;
  return mute.global || (siteId !== null && siteId !== undefined && mute.sites.has(Number(siteId)));
}

async function load(now = Date.now()) {
  const rows = await q('SELECT site_id, starts_at, ends_at, repeat_every FROM maintenance_windows');
  return muteSet(rows, now);
}

/** One-off windows that ended more than 30 days ago are removed. */
async function prune() {
  await q("DELETE FROM maintenance_windows WHERE repeat_every = 'none' AND ends_at < ?", [new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 19).replace('T', ' ')]);
}

module.exports = { currentStart, muteSet, isMuted, load, prune };
