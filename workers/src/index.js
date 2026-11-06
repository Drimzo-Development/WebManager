'use strict';
const fs = require('fs');
const { pool, q } = require('./db');
const agent = require('./agent');
const { handlers } = require('./handlers');
const notify = require('./notify');
const cron = require('./cron');
const report = require('./report');
const uptime = require('./uptime');
const consoleTickets = require('./console');
const resources = require('./resources');
const maintenance = require('./maintenance');

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '3', 10);
const HEARTBEAT_FILE = '/tmp/worker-heartbeat';
const MAX_LOG_LINES = 20000;

const activeSites = new Set();
let activeGlobal = false;
let running = 0;
let stopping = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

function logger(jobId) {
  let buf = [];
  let count = 0;
  let truncated = false;
  let timer = null;
  const flush = async () => {
    timer = null;
    if (!buf.length) return;
    const rows = buf;
    buf = [];
    try {
      await pool.query('INSERT INTO job_logs (job_id, line) VALUES ?', [rows.map((l) => [jobId, l])]);
    } catch (e) {
      process.stderr.write(`[worker] log write failed: ${e.message}\n`);
    }
  };
  const log = (line) => {
    if (truncated) return;
    if (count >= MAX_LOG_LINES) {
      truncated = true;
      buf.push('[Output truncated: line limit reached]');
    } else {
      count++;
      buf.push(String(line).slice(0, 8000));
    }
    if (!timer) timer = setTimeout(flush, 300);
  };
  log.flush = async () => { if (timer) clearTimeout(timer); await flush(); };
  return log;
}

async function runJob(job) {
  const log = logger(job.id);
  const ac = new AbortController();
  let exitCode = null;
  const ctx = {
    job, signal: ac.signal, log,
    payload: typeof job.payload === 'string' ? JSON.parse(job.payload || '{}') : (job.payload || {}),
    setExit: (c) => { exitCode = c; },
  };
  // poll for cancellation requests from the dashboard
  const poll = setInterval(async () => {
    try {
      const [row] = await q('SELECT status FROM jobs WHERE id = ?', [job.id]);
      if (row && row.status === 'cancelling' && !ac.signal.aborted) {
        log('[Cancellation requested]');
        ac.abort();
        agent.call('POST', `/v1/jobs/${job.id}/kill`, {}, { timeoutMs: 15000 }).catch(() => {});
      }
    } catch (_) { /* ignore */ }
  }, 1500);

  let status = 'succeeded';
  let error = null;
  try {
    const handler = handlers[job.type];
    if (!handler) throw new Error(`Unknown task type: ${job.type}`);
    await handler(ctx);
    if (ac.signal.aborted) status = 'cancelled';
  } catch (e) {
    if (ac.signal.aborted || e.aborted) {
      status = 'cancelled';
    } else {
      status = 'failed';
      error = String(e.message || e).slice(0, 900);
      log(`ERROR: ${error}`);
    }
  } finally {
    clearInterval(poll);
    await log.flush();
  }
  await q('UPDATE jobs SET status = ?, error = ?, exit_code = ?, finished_at = ? WHERE id = ?',
    [status, error, exitCode, nowSql(), job.id]);
  if (status === 'failed' && (job.type === 'site.create' || job.type === 'site.clone')) {
    await q("UPDATE sites SET lifecycle = 'ready' WHERE id = ? AND lifecycle = 'creating'", [job.site_id]).catch(() => {});
  }
}

async function claimJob() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const sites = [...activeSites];
    const [rows] = await conn.query(
      `SELECT * FROM jobs WHERE status = 'queued'
         AND ((site_id IS NOT NULL AND site_id NOT IN (?)) OR (site_id IS NULL AND ? = 0))
       ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [sites.length ? sites : [0], activeGlobal ? 1 : 0],
    );
    if (!rows.length) { await conn.rollback(); return null; }
    await conn.query("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?", [nowSql(), rows[0].id]);
    await conn.commit();
    return rows[0];
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

async function loop() {
  while (!stopping) {
    try {
      if (running < CONCURRENCY) {
        const job = await claimJob();
        if (job) {
          running++;
          if (job.site_id) activeSites.add(job.site_id); else activeGlobal = true;
          runJob(job)
            .catch((e) => process.stderr.write(`[worker] job ${job.id} crashed: ${e.stack}\n`))
            .finally(() => {
              running--;
              if (job.site_id) activeSites.delete(job.site_id); else activeGlobal = false;
            });
          continue;
        }
      }
    } catch (e) {
      process.stderr.write(`[worker] loop error: ${e.message}\n`);
      await sleep(3000);
    }
    await sleep(1000);
  }
}

async function enqueue(type, title, payload = {}) {
  const pending = await q("SELECT id FROM jobs WHERE type = ? AND status IN ('queued','running') LIMIT 1", [type]);
  if (pending.length) return;
  await q('INSERT INTO jobs (type, title, payload, status) VALUES (?, ?, ?, ?)', [type, title, JSON.stringify(payload), 'queued']);
}

async function scheduler() {
  // certificates are renewed daily (certbot itself only renews when due)
  const [row] = await q("SELECT v FROM settings WHERE k = 'last_cert_renewal'");
  const last = row ? Date.parse(row.v) : 0;
  if (!last || Date.now() - last > 24 * 3600 * 1000) {
    await enqueue('certs.renew', 'Check and renew certificates');
  }
  // country data is refreshed weekly once it exists or a website uses a country rule
  const [geoRow] = await q("SELECT v FROM settings WHERE k = 'last_geo_update'");
  const geoLast = geoRow ? Date.parse(geoRow.v) : 0;
  if (Date.now() - geoLast > 7 * 24 * 3600 * 1000) {
    const [{ n }] = await q("SELECT COUNT(*) AS n FROM sites WHERE geo_mode <> 'off'");
    if (Number(n) > 0 || geoLast) await enqueue('geo.update', 'Update country data (GeoIP)');
  }
  // housekeeping
  await q('DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL 7 DAY');
  await q("DELETE FROM jobs WHERE finished_at IS NOT NULL AND finished_at < NOW() - INTERVAL 60 DAY");
  await q('DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL 365 DAY');
  await uptime.prune();
  await maintenance.prune();
  await resources.sampleDisk().catch((e) => process.stderr.write(`[worker] disk sample: ${e.message}\n`));
}

const sqlUtc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

/**
 * Cron jobs: runs every 30 seconds. Missing next-run times are filled in, due jobs are queued as site jobs (so they never run in
 * parallel with other jobs of the same website) unless the previous run is still queued/running (no overlap).
 */
async function cronTick() {
  const now = new Date();
  for (const c of await q('SELECT id, schedule FROM site_cron WHERE enabled = 1 AND next_run_at IS NULL')) {
    let nxt = null;
    try { nxt = cron.next(c.schedule, now); } catch (_) { /* invalid: switched off below */ }
    if (nxt) await q('UPDATE site_cron SET next_run_at = ? WHERE id = ?', [sqlUtc(nxt), c.id]);
    else await q("UPDATE site_cron SET enabled = 0, last_status = 'failed' WHERE id = ?", [c.id]);
  }
  const due = await q('SELECT c.*, s.lifecycle, s.desired_state FROM site_cron c JOIN sites s ON s.id = c.site_id WHERE c.enabled = 1 AND c.next_run_at <= ? ORDER BY c.next_run_at LIMIT 50', [sqlUtc(now)]);
  for (const c of due) {
    let nxt = null;
    try { nxt = cron.next(c.schedule, now); } catch (_) { /* handled below */ }
    await q('UPDATE site_cron SET next_run_at = ? WHERE id = ?', [nxt ? sqlUtc(nxt) : null, c.id]);
    if (!nxt) { await q('UPDATE site_cron SET enabled = 0 WHERE id = ?', [c.id]); continue; }
    const [busy] = await q("SELECT id FROM jobs WHERE type = 'site.cron' AND status IN ('queued','running','cancelling') AND JSON_VALUE(payload, '$.cronId') = ? LIMIT 1", [String(c.id)]);
    if (busy || c.lifecycle !== 'ready' || c.desired_state !== 'running') {
      await q("UPDATE site_cron SET last_status = 'skipped', last_run_at = ? WHERE id = ?", [sqlUtc(now), c.id]);
      continue;
    }
    await q("INSERT INTO jobs (type, site_id, title, payload, status) VALUES ('site.cron', ?, ?, ?, 'queued')", [c.site_id, `Cron job: ${c.name}`.slice(0, 200), JSON.stringify({ cronId: c.id })]);
  }
}

async function heartbeat() {
  try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); } catch (_) { /* ignore */ }
  try { await q("REPLACE INTO settings (k, v) VALUES ('worker_heartbeat', ?)", [new Date().toISOString()]); } catch (_) { /* ignore */ }
}

async function waitForAgent() {
  for (let i = 0; i < 60 && !stopping; i++) {
    try { await agent.call('GET', '/v1/dashboard', undefined, { timeoutMs: 5000 }); return true; } catch (_) { await sleep(2000); }
  }
  return false;
}

async function main() {
  // jobs that were running when a previous worker died cannot be resumed safely
  const orphans = await q("UPDATE jobs SET status = 'failed', error = 'Worker was restarted', finished_at = ? WHERE status IN ('running','cancelling')", [nowSql()]);
  if (orphans.affectedRows) process.stdout.write(`[worker] ${orphans.affectedRows} orphaned job(s) marked failed\n`);
  await heartbeat();
  setInterval(heartbeat, 10000).unref();

  if (await waitForAgent()) {
    await enqueue('system.reconcile', 'Reconcile websites and proxy after start');
  } else {
    process.stderr.write('[worker] agent not reachable after 2 minutes; continuing anyway\n');
  }
  await scheduler().catch((e) => process.stderr.write(`[worker] scheduler: ${e.message}\n`));
  setInterval(() => scheduler().catch((e) => process.stderr.write(`[worker] scheduler: ${e.message}\n`)), 3600 * 1000).unref();

  setInterval(() => uptime.tick(), 60 * 1000).unref();
  // web console: tickets are handed over by the worker unless CONSOLE_TICKETS=dashboard; open sessions of accounts that lost the right are ended
  if (process.env.CONSOLE_TICKETS !== 'dashboard') setInterval(() => consoleTickets.tick(), 1000).unref();
  setInterval(() => consoleTickets.sweep(), 30 * 1000).unref();
  setInterval(() => notify.tick(), 60 * 1000).unref();
  setInterval(() => report.tick(), 60 * 1000).unref();
  const guardedCron = () => cronTick().catch((e) => process.stderr.write(`[worker] cron: ${e.message}\n`));
  guardedCron();
  setInterval(guardedCron, 30 * 1000).unref();

  process.stdout.write(`[worker] ready (concurrency ${CONCURRENCY})\n`);
  await loop();
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true;
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

main().catch((e) => {
  process.stderr.write(`[worker] fatal: ${e.stack}\n`);
  process.exit(1);
});
