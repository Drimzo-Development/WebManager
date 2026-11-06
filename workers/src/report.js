'use strict';
// Weekly statistics report per website: collects the numbers from the agent and mails them to the website's own recipient list.
const { q } = require('./db');
const agent = require('./agent');
const notify = require('./notify');

const MIN_GAP_MS = 6 * 24 * 3600 * 1000; // never twice in the same week, whatever the schedule says
const RETRY_MS = 30 * 60 * 1000;
const tzOf = () => process.env.TZ || 'UTC';
const lastTry = new Map();

const fmtInt = (n) => Math.round(n).toLocaleString('en-GB');
const fmtRate = (n) => (n >= 10 ? n.toFixed(1) : n.toFixed(2));
const fmtPct = (n) => `${(n * 100).toFixed(n >= 0.1 ? 1 : 2)} %`;

function fmtBytes(b) {
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  return `${Math.round(b / 1024).toLocaleString('en-GB')} KB`;
}

/** "+12 %" / "−5 %" against the previous week; empty when there is nothing to compare with. */
function delta(cur, prev) {
  if (!prev) return '';
  const d = Math.round(((cur - prev) / prev) * 100);
  return d === 0 ? ' (unchanged from last week)' : ` (${d > 0 ? '+' : '−'}${Math.abs(d)} % vs. last week)`;
}

/** Local weekday (0 = Sunday) and hour of `date` in the time zone `tz`. */
function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')), hour: parseInt(get('hour'), 10) % 24 };
}

/** True when the report is due: on the chosen weekday, from the chosen hour on, and not sent within the last 6 days. */
function isDue(r, now = new Date(), tz = tzOf()) {
  if (!Number(r.enabled)) return false;
  const lp = localParts(now, tz);
  if (lp.weekday !== Number(r.weekday) || lp.hour < Number(r.hour)) return false;
  const last = r.last_sent_at ? Date.parse(`${String(r.last_sent_at).replace(' ', 'T')}Z`) : 0;
  return !last || now.getTime() - last >= MIN_GAP_MS;
}

/** Builds the mail content from the agent's report data. Pure. */
function build(site, domains, rep, tz = tzOf()) {
  const c = rep.current;
  const p = rep.previous;
  const fmtDay = (ms) => new Date(ms).toLocaleDateString('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' });
  const period = `${fmtDay(rep.from)} – ${fmtDay(rep.to)}`;
  const label = domains.length ? domains[0] : site.name;
  const visitorsTotal = (rep.visitors || []).reduce((a, v) => a + v.n, 0);
  const bestDay = (rep.visitors || []).reduce((m, v) => (v.n > (m ? m.n : -1) ? v : m), null);
  const serverErrors = c.req > 0 && c.s5 / c.req >= 0.01;
  const lines = [];
  if (!c.req) {
    lines.push(`No requests to this website were recorded in the period ${period}.`);
  } else {
    lines.push(`Here is the weekly summary for “${site.name}” (${period}).`);
    if (serverErrors) lines.push(`Attention: ${fmtInt(c.s5)} requests (${fmtPct(c.s5 / c.req)}) ended with a server error (5xx). Please check the logs.`);
    if (rep.topPages && rep.topPages.length) {
      lines.push(['Most visited pages:', ...rep.topPages.slice(0, 5).map((t) => `• ${t.path} – ${fmtInt(t.count)}×`)].join('\n'));
    }
    if (rep.top404 && rep.top404.length) {
      lines.push(['Most frequent not-found addresses (404):', ...rep.top404.slice(0, 3).map((t) => `• ${t.path} – ${fmtInt(t.count)}×`)].join('\n'));
    }
  }
  const peakAt = c.peakAt ? new Date(c.peakAt).toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const facts = [
    ['Website', label],
    ['Period', period],
    ['Total requests', `${fmtInt(c.req)}${delta(c.req, p.req)}`],
    ['Avg. requests per minute', fmtRate(c.avgPerMin)],
    ['Peak per minute', c.peakReq ? `${fmtInt(c.peakReq)} (${peakAt})` : ''],
    ['Visitors (sum of days)', visitorsTotal ? `${fmtInt(visitorsTotal)}${bestDay && bestDay.n ? `, busiest day ${fmtDay(Date.parse(bestDay.day))} with ${fmtInt(bestDay.n)}` : ''}` : ''],
    ['Traffic', c.bytes ? `${fmtBytes(c.bytes)}${delta(c.bytes, p.bytes)}` : ''],
    ['Error rate (4xx/5xx)', c.req ? `${fmtPct(c.errorRate)} (4xx: ${fmtInt(c.s4)}, 5xx: ${fmtInt(c.s5)})` : ''],
    ['Blocked by the firewall', c.waf ? fmtInt(c.waf) : ''],
    ['CPU avg. / peak', c.cpuAvg !== null && c.cpuAvg !== undefined ? `${c.cpuAvg.toFixed(1)} % / ${c.cpuMax.toFixed(1)} %` : ''],
    ['Memory peak', c.memMax ? `${fmtBytes(c.memMax)}${c.memLimit ? ` of ${fmtBytes(c.memLimit)}` : ''}` : ''],
  ];
  return { subject: `Weekly report “${site.name}” (${period})`, title: `Weekly report: ${label}`, text: lines.join('\n\n'), kind: serverErrors ? 'warn' : 'info', facts };
}

function addresses(raw) {
  return String(raw || '').split(/[\s,;]+/).filter((x) => /^[^@\s]+@[^@\s]+$/.test(x));
}

/** Collects the numbers and sends the report for one website. Throws with a readable message on failure. */
async function sendReport(siteId, s) {
  const [site] = await q('SELECT id, name FROM sites WHERE id = ?', [siteId]);
  if (!site) throw new Error('The website no longer exists.');
  const [cfg] = await q('SELECT recipients FROM site_reports WHERE site_id = ?', [siteId]);
  const to = addresses(cfg && cfg.recipients);
  if (!to.length) throw new Error('No recipients are set.');
  const domains = (await q('SELECT domain FROM site_domains WHERE site_id = ? ORDER BY id', [siteId])).map((r) => r.domain);
  const rep = await agent.call('GET', `/v1/sites/${siteId}/report`, undefined, { timeoutMs: 30000 });
  const m = build(site, domains, rep);
  await notify.sendMail(m.subject, m.text, { s: s || await notify.settings(), to, kind: m.kind, title: m.title, facts: m.facts });
  await q('UPDATE site_reports SET last_sent_at = UTC_TIMESTAMP() WHERE site_id = ?', [siteId]);
  return to;
}

/** One pass (every minute): sends the reports that are due. Never throws. */
async function tick(now = new Date()) {
  let rows;
  try {
    rows = await q("SELECT r.* FROM site_reports r JOIN sites s ON s.id = r.site_id WHERE r.enabled = 1 AND s.lifecycle = 'ready'");
  } catch (_) { return; }
  const due = rows.filter((r) => isDue(r, now));
  if (!due.length) return;
  let s;
  try { s = await notify.settings(); } catch (_) { return; }
  if (!s.smtp_host) return;
  for (const r of due) {
    if (now.getTime() - (lastTry.get(r.site_id) || 0) < RETRY_MS) continue;
    lastTry.set(r.site_id, now.getTime());
    try { await sendReport(r.site_id, s); } catch (e) { process.stderr.write(`[worker] report site ${r.site_id}: ${e.message}\n`); }
  }
}

module.exports = { isDue, build, localParts, sendReport, tick };
