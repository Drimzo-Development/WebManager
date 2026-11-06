'use strict';
/**
 * Web console: an interactive shell inside the running container of a website (docker exec with a pseudo terminal).
 *
 * Flow: the dashboard (administrators only) asks for a ticket (POST /v1/sites/:id/console); the browser then opens a WebSocket
 * to /ws/console (through the reverse proxy, which first asks the dashboard whether the session is an administrator's) and sends the
 * ticket as WebSocket subprotocol `wm-console.<ticket>`, so it never appears in a URL or an access log.
 * The ticket is random (256 bit), valid for 30 seconds and works exactly once. Keystrokes are never logged; the agent audit log
 * records who opened a console for which website, from where, for how long and how much data was transferred.
 *
 * The Docker API is used directly over the socket (no CLI): `exec create` + `exec start` with Tty gives a raw byte stream that is
 * passed through unchanged; terminal size changes use `exec resize`.
 */
const http = require('http');
const crypto = require('crypto');
const { config } = require('./config');
const sites = require('./sites');
const { audit } = require('./audit');
const ws = require('./ws');

const TICKET_TTL_MS = 30 * 1000;
const IDLE_MS = 15 * 60 * 1000; // no input at all
const MAX_MS = 2 * 3600 * 1000;
const PING_MS = 30 * 1000;
const PER_SITE = 3;
const TOTAL = 6;
const CHUNK = 16 * 1024;
const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
// bash when the image has it, otherwise the image's sh; a login shell so that profile files (PATH of the runtime) apply
const SHELL = ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi'];
const ENVIRONMENT = ['TERM=xterm-256color', 'COLORTERM=truecolor', 'LANG=C.UTF-8'];

const clampInt = (v, min, max, fallback) => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? parseInt(v, 10) : v;
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/** Text frames from the browser: { type: 'resize', cols, rows }. Anything else is ignored. */
function parseControl(payload) {
  try {
    const m = JSON.parse(Buffer.from(payload).toString('utf8'));
    if (m && m.type === 'resize') {
      const cols = clampInt(m.cols, 1, 500, 0);
      const rows = clampInt(m.rows, 1, 300, 0);
      if (cols && rows) return { type: 'resize', cols, rows };
    }
  } catch (_) { /* not JSON */ }
  return null;
}

/** Tickets (waiting for the browser) and running sessions; keeps the limits per website and in total. */
class Sessions {
  constructor() {
    this.tickets = new Map(); // ticket -> { siteId, meta, exp }
    this.running = new Map(); // id -> { siteId, actor, ip, startedAt, lastInput, bytesIn, bytesOut, kill }
  }

  prune(now) {
    for (const [t, v] of this.tickets) if (v.exp <= now) this.tickets.delete(t);
  }

  countFor(siteId) {
    let n = 0;
    for (const v of this.tickets.values()) if (v.siteId === siteId) n++;
    for (const s of this.running.values()) if (s.siteId === siteId) n++;
    return n;
  }

  /** Returns the ticket or throws an Error with `status` 429. */
  issue(siteId, meta, now = Date.now()) {
    this.prune(now);
    if (this.tickets.size + this.running.size >= TOTAL) throw Object.assign(new Error(`At most ${TOTAL} consoles can be open at the same time.`), { status: 429 });
    if (this.countFor(siteId) >= PER_SITE) throw Object.assign(new Error(`At most ${PER_SITE} consoles per website.`), { status: 429 });
    const ticket = crypto.randomBytes(32).toString('hex');
    this.tickets.set(ticket, { siteId, meta, exp: now + TICKET_TTL_MS });
    return ticket;
  }

  /** One use only: the ticket is gone after the first call, valid or not. */
  redeem(ticket, now = Date.now()) {
    this.prune(now);
    const t = this.tickets.get(ticket);
    if (!t) return null;
    this.tickets.delete(ticket);
    return t;
  }

  begin(siteId, info = {}) {
    const id = crypto.randomBytes(8).toString('hex');
    // the caller keeps working on this very object (counters, last input), so it is stored as it is
    this.running.set(id, Object.assign(info, { siteId, startedAt: Date.now(), lastInput: Date.now(), bytesIn: 0, bytesOut: 0, kill: null }));
    return id;
  }

  end(id) { this.running.delete(id); }

  /** Running sessions without internals, oldest first. */
  list(now = Date.now()) {
    return [...this.running.entries()].map(([id, s]) => ({
      id, siteId: s.siteId, userId: s.userId || 0, actor: s.actor, ip: s.ip,
      startedAt: new Date(s.startedAt).toISOString(), idleSec: Math.round((now - s.lastInput) / 1000), bytesIn: s.bytesIn, bytesOut: s.bytesOut,
    })).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** Ends every running session for which `match(session)` is true; returns how many. */
  killWhere(match) {
    let n = 0;
    for (const s of [...this.running.values()]) {
      if (s.kill && match(s)) { s.kill(); n++; }
    }
    return n;
  }

  /** Ends a session (an administrator pressed "End"); false when it is already gone. */
  kill(id) {
    const s = this.running.get(id);
    if (!s || !s.kill) return false;
    s.kill();
    return true;
  }
}

const sessions = new Sessions();

// ---------------------------------------------------------------- Docker API over the socket
function dockerJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      socketPath: SOCKET, method, path, timeout: 15000,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { if (buf.length < 100000) buf += d; });
      res.on('end', () => {
        let json = {};
        try { json = buf ? JSON.parse(buf) : {}; } catch (_) { /* empty or text */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('The Docker daemon did not answer.')));
    req.on('error', reject);
    req.end(data);
  });
}

/** Starts the exec instance with a TTY; resolves with the raw duplex stream (the connection is "hijacked"). */
function startExec(execId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ Detach: false, Tty: true });
    const req = http.request({
      socketPath: SOCKET, method: 'POST', path: `/exec/${execId}/start`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'Upgrade', Upgrade: 'tcp' },
    });
    req.on('upgrade', (res, sock, head) => resolve({ sock, head }));
    req.on('response', (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => reject(new Error(`Docker: ${buf.slice(0, 200) || res.statusCode}`)));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function openShell(siteId, cols, rows) {
  const name = sites.names(siteId).container;
  const created = await dockerJson('POST', `/containers/${encodeURIComponent(name)}/exec`, {
    AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: SHELL, Env: ENVIRONMENT,
  });
  if (created.status !== 201 || !created.json.Id) throw new Error(String(created.json.message || `Docker answered with HTTP ${created.status}`).slice(0, 200));
  const execId = created.json.Id;
  const { sock, head } = await startExec(execId);
  const resize = (c, r) => dockerJson('POST', `/exec/${execId}/resize?h=${r}&w=${c}`).catch(() => {});
  await resize(cols, rows);
  return { sock, head, execId, resize };
}

// ---------------------------------------------------------------- ticket for the browser
async function issue(siteId, body = {}) {
  if (!config.consoleEnabled) throw sites.httpError(403, 'The web console is switched off (CONSOLE=off in .env).');
  const st = await sites.siteStatus(siteId);
  if (!st.exists || !st.running) throw sites.httpError(409, 'The website is not running.');
  const actor = String(body.actor || '').slice(0, 120);
  const ticket = sessions.issue(siteId, { actor, userId: clampInt(body.userId, 1, 2147483647, 0), cols: clampInt(body.cols, 1, 500, 80), rows: clampInt(body.rows, 1, 300, 24) });
  audit('console.ticket', { site: sites.names(siteId).site, actor });
  return { ticket, ttl: TICKET_TTL_MS / 1000 };
}

// ---------------------------------------------------------------- WebSocket
const failures = new Map();
function tooManyFailures(ip) {
  const now = Date.now();
  const rec = (failures.get(ip) || []).filter((t) => now - t < 60000);
  failures.set(ip, rec);
  return rec.length >= 20;
}

function refuse(socket, status, text) {
  try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch (_) { socket.destroy(); }
}

/** The ticket from the offered subprotocols (`wm-console.<64 hex>`), or null. */
function ticketFrom(header) {
  for (const part of String(header || '').split(',')) {
    const m = /^wm-console\.([0-9a-f]{64})$/.exec(part.trim());
    if (m) return { ticket: m[1], protocol: part.trim() };
  }
  return null;
}

async function handleUpgrade(req, socket, head) {
  socket.setNoDelay(true);
  const ip = String(req.headers['x-real-ip'] || socket.remoteAddress || '?').slice(0, 64);
  const url = new URL(req.url, 'http://agent');
  const offered = ticketFrom(req.headers['sec-websocket-protocol']);
  const key = String(req.headers['sec-websocket-key'] || '');
  if (!config.consoleEnabled || url.pathname !== '/ws/console' || !offered || req.method !== 'GET' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket'
    || req.headers['sec-websocket-version'] !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return refuse(socket, 400, 'Bad Request');
  if (tooManyFailures(ip)) return refuse(socket, 429, 'Too Many Requests');
  const t = sessions.redeem(offered.ticket);
  if (!t) { failures.get(ip).push(Date.now()); audit('console.refused', { ip }); return refuse(socket, 403, 'Forbidden'); }

  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${ws.acceptKey(key)}\r\nSec-WebSocket-Protocol: ${offered.protocol}\r\n\r\n`);
  const info = { actor: t.meta.actor, userId: t.meta.userId || 0, ip };
  const sid = sessions.begin(t.siteId, info);
  const siteName = sites.names(t.siteId).site;
  const startedAt = info.startedAt = Date.now();
  let shell = null;
  let done = false;
  let lastPong = Date.now();
  const send = (opcode, payload) => { if (!socket.destroyed && socket.writable) return socket.write(ws.encodeFrame(opcode, payload)); return true; };
  const sendJson = (o) => send(ws.OP.TEXT, JSON.stringify(o));

  const finish = (reason, extra = {}) => {
    if (done) return;
    done = true;
    clearInterval(timer);
    sessions.end(sid);
    if (shell) { try { shell.sock.destroy(); } catch (_) { /* gone */ } }
    if (!socket.destroyed) {
      sendJson({ type: 'exit', reason, ...extra });
      try { socket.end(ws.closeFrame(1000, reason)); } catch (_) { socket.destroy(); }
    }
    audit('console.close', { site: siteName, actor: t.meta.actor, ip, seconds: Math.round((Date.now() - startedAt) / 1000), bytesIn: info.bytesIn, bytesOut: info.bytesOut, reason });
  };

  const timer = setInterval(() => {
    const now = Date.now();
    if (now - startedAt > MAX_MS) return finish('time-limit');
    if (now - info.lastInput > IDLE_MS) return finish('idle');
    if (now - lastPong > 3 * PING_MS) return finish('no-answer');
    return send(ws.OP.PING);
  }, PING_MS);
  timer.unref();

  info.kill = () => finish('killed');
  audit('console.open', { site: siteName, actor: t.meta.actor, ip });
  socket.pause();
  const parser = new ws.FrameParser();
  const onData = (chunk) => {
    let messages;
    try { messages = parser.push(chunk); } catch (e) {
      try { socket.end(ws.closeFrame(e.code || 1002, e.message)); } catch (_) { /* closed */ }
      return finish('protocol-error');
    }
    for (const msg of messages) {
      if (msg.opcode === ws.OP.CLOSE) return finish('closed');
      if (msg.opcode === ws.OP.PING) { send(ws.OP.PONG, msg.payload); continue; }
      if (msg.opcode === ws.OP.PONG) { lastPong = Date.now(); continue; }
      info.lastInput = Date.now();
      if (msg.opcode === ws.OP.BINARY) { info.bytesIn += msg.payload.length; shell.sock.write(msg.payload); } else {
        const c = parseControl(msg.payload);
        if (c) shell.resize(c.cols, c.rows);
      }
    }
    return undefined;
  };
  socket.on('error', () => finish('connection-error'));
  socket.on('close', () => finish('closed'));
  socket.on('drain', () => { if (shell) shell.sock.resume(); });

  try {
    shell = await openShell(t.siteId, t.meta.cols, t.meta.rows);
  } catch (e) {
    sendJson({ type: 'error', message: e.message });
    return finish('error');
  }
  if (done) { shell.sock.destroy(); return undefined; }
  const out = (data) => {
    for (let i = 0; i < data.length; i += CHUNK) {
      const piece = data.subarray(i, i + CHUNK);
      info.bytesOut += piece.length;
      if (!send(ws.OP.BINARY, piece)) shell.sock.pause();
    }
  };
  if (shell.head && shell.head.length) out(shell.head);
  shell.sock.on('data', out);
  shell.sock.on('error', () => finish('error'));
  shell.sock.on('close', async () => {
    let code = null;
    try { code = (await dockerJson('GET', `/exec/${shell.execId}/json`)).json.ExitCode ?? null; } catch (_) { /* unknown */ }
    finish('shell-exited', { code });
  });
  sendJson({ type: 'ready' });
  socket.on('data', onData);
  if (head && head.length) onData(head);
  socket.resume();
  return undefined;
}

const listSessions = () => sessions.list();
/** Ends all sessions of one account (signed out, role changed, deactivated, password changed). */
const endUser = (userId) => sessions.killWhere((s) => s.userId === Number(userId));
/** Ends all sessions of one website (the console was switched off for it). */
const endSite = (siteId) => sessions.killWhere((s) => s.siteId === Number(siteId));
const killSession = (id) => sessions.kill(String(id));

module.exports = { issue, handleUpgrade, listSessions, killSession, endUser, endSite, ticketFrom, sessions, Sessions, parseControl, clampInt, SHELL, TICKET_TTL_MS, PER_SITE, TOTAL };
