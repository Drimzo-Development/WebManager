'use strict';
/**
 * Hand-over of console tickets (CONSOLE_TICKETS=worker): the dashboard writes a request into `console_requests`, the worker (the only
 * holder of the agent's admin token) asks the agent for the ticket and stores it for the signed-in administrator who asked.
 * The dashboard token alone can then no longer open a shell in a container.
 */
const { q } = require('./db');
const agent = require('./agent');

const KEEP_MS = 2 * 60 * 1000;
let busy = false;
const sqlUtc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

/** Why a request must be refused (null = fine). Pure, so it can be tested. */
function refusal(site) {
  if (!site) return 'Website not found.';
  if (site.lifecycle !== 'ready') return 'The website is not ready yet.';
  if (!Number(site.console_enabled)) return 'The console is switched off for this website.';
  return null;
}

async function handle(r) {
  const [site] = await q('SELECT id, lifecycle, console_enabled FROM sites WHERE id = ?', [r.site_id]);
  let ticket = null;
  let error = refusal(site);
  if (!error) {
    try {
      const res = await agent.call('POST', `/v1/sites/${r.site_id}/console`, { actor: r.actor, userId: r.user_id, cols: r.term_cols, rows: r.term_rows }, { timeoutMs: 20000 });
      ticket = /^[0-9a-f]{64}$/.test(String(res.ticket || '')) ? res.ticket : null;
      if (!ticket) error = 'The agent returned no ticket.';
    } catch (e) {
      error = String(e.message || 'The agent could not be reached.').slice(0, 280);
    }
  }
  await q('UPDATE console_requests SET ticket = ?, error = ? WHERE id = ?', [ticket, error, r.id]);
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    for (const r of await q('SELECT id, user_id, site_id, actor, term_cols, term_rows FROM console_requests WHERE ticket IS NULL AND error IS NULL ORDER BY created_at LIMIT 10')) await handle(r);
    await q('DELETE FROM console_requests WHERE created_at < ?', [sqlUtc(new Date(Date.now() - KEEP_MS))]);
  } catch (e) {
    process.stderr.write(`[worker] console: ${e.message}\n`);
  } finally {
    busy = false;
  }
}

/** Sessions whose account is not an active administrator any more (pure). `allowed` = ids of active administrators. */
function staleSessions(sessions, allowed) {
  const ok = new Set((allowed || []).map(Number));
  return (sessions || []).filter((s) => !s.userId || !ok.has(Number(s.userId)));
}

/**
 * Backstop for every way an account can lose its right to a shell (deactivated, demoted, deleted, changed in the database):
 * every 30 seconds the sessions that are still open are compared with the active administrators. Signing out and changing the
 * password end the sessions at once from the dashboard; this catches the rest.
 */
async function sweep() {
  try {
    const { sessions } = await agent.call('GET', '/v1/console/sessions', undefined, { timeoutMs: 10000 });
    if (!sessions || !sessions.length) return;
    const ids = [...new Set(sessions.map((s) => s.userId).filter(Boolean))];
    const allowed = ids.length ? (await q("SELECT id FROM users WHERE id IN (?) AND active = 1 AND role = 'admin'", [ids])).map((r) => r.id) : [];
    for (const s of staleSessions(sessions, allowed)) {
      await agent.call('POST', `/v1/console/sessions/${s.id}/kill`, { actor: 'system: the account is no longer an active administrator' }, { timeoutMs: 10000 });
    }
  } catch (e) {
    process.stderr.write(`[worker] console sweep: ${e.message}\n`);
  }
}

module.exports = { tick, sweep, refusal, staleSessions };
