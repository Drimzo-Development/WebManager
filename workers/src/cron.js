'use strict';
// Minimal cron expressions: "min hour day-of-month month day-of-week" with *, lists (1,2), ranges (1-5), steps (*/5, 10-30/5)
// and the aliases @hourly @daily @weekly @monthly. Evaluated in the time zone of the process (TZ). Like classic cron, when both
// day-of-month and day-of-week are restricted a day matches if EITHER matches.
const ALIASES = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *' };
const FIELDS = [
  { name: 'Minute', min: 0, max: 59 },
  { name: 'Hour', min: 0, max: 23 },
  { name: 'Day', min: 1, max: 31 },
  { name: 'Month', min: 1, max: 12 },
  { name: 'Weekday', min: 0, max: 7 },
];

function parseField(text, f) {
  const values = new Set();
  for (const part of text.split(',')) {
    const m = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) throw new Error(`${f.name}: invalid expression “${part}”`);
    let from; let to;
    if (m[1] === '*') { from = f.min; to = f.max === 7 ? 6 : f.max; } else if (m[1].includes('-')) { [from, to] = m[1].split('-').map(Number); } else { from = Number(m[1]); to = m[2] ? f.max : from; }
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`${f.name}: step must be at least 1`);
    if (from < f.min || to > f.max || from > to) throw new Error(`${f.name}: value outside ${f.min}–${f.max}`);
    for (let v = from; v <= to; v += step) values.add(f.max === 7 && v === 7 ? 0 : v);
  }
  return values;
}

function parse(expr) {
  const text = ALIASES[String(expr).trim().toLowerCase()] || String(expr).trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error('Expected five fields: minute hour day month weekday');
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]));
  return { min: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4], domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

function dayMatches(c, d) {
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dow;
  if (c.dowAny) return dom;
  return dom || dow;
}

/** Next run strictly after `from`, or null when none exists within about 5 years (e.g. 31 February). */
function next(expr, from = new Date()) {
  const c = typeof expr === 'string' ? parse(expr) : expr;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = d.getTime() + 5 * 366 * 24 * 3600 * 1000;
  while (d.getTime() < limit) {
    if (!c.month.has(d.getMonth() + 1) || !dayMatches(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d;
  }
  return null;
}

module.exports = { parse, next };
