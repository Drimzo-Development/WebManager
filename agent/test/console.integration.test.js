'use strict';
// The whole path browser -> agent -> Docker with a fake Docker daemon on a unix socket.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-console-'));
process.env.DATA_DIR = path.join(dir, 'data');
process.env.AGENT_TOKEN_DASHBOARD = 'a'.repeat(40);
process.env.AGENT_TOKEN_WORKER = 'b'.repeat(40);
process.env.AUDIT_LOG = path.join(dir, 'audit.log');
process.env.DOCKER_SOCKET = path.join(dir, 'docker.sock');

const { handleUpgrade, sessions } = require('../src/console');
const ws = require('../src/ws');

const calls = [];
let shellSocket = null;

const fakeDocker = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    calls.push(`${req.method} ${req.url}`);
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && req.url === '/containers/wm-site-001/exec') {
      const b = JSON.parse(body);
      assert.equal(b.Tty, true);
      assert.equal(b.AttachStdin, true);
      return json(201, { Id: 'exec1' });
    }
    if (req.method === 'POST' && req.url === '/containers/wm-site-404/exec') return json(409, { message: 'Container is not running' });
    if (req.method === 'POST' && req.url.startsWith('/exec/exec1/resize')) return json(200, {});
    if (req.method === 'GET' && req.url === '/exec/exec1/json') return json(200, { ExitCode: 3 });
    return json(404, { message: 'unknown' });
  });
});
fakeDocker.on('upgrade', (req, sock) => {
  calls.push(`UPGRADE ${req.url}`);
  shellSocket = sock;
  sock.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
  sock.write('$ ');
  sock.on('data', (d) => { if (d.toString() === 'exit\r') sock.end(); else sock.write(d.toString().toUpperCase()); });
});

const agent = http.createServer();
agent.on('upgrade', (req, socket, head) => { handleUpgrade(req, socket, head).catch(() => socket.destroy()); });

let port;
test.before(async () => {
  await new Promise((r) => fakeDocker.listen(process.env.DOCKER_SOCKET, r));
  await new Promise((r) => agent.listen(0, '127.0.0.1', r));
  port = agent.address().port;
});
test.after(() => { agent.close(); fakeDocker.close(); agent.closeAllConnections?.(); });

/** Browser side: handshake and framing by hand. */
function connect(ticket, opts = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    const client = { sock, status: 0, messages: [], waiters: [], parser: null, raw: Buffer.alloc(0) };
    let headerDone = false;
    sock.on('data', (d) => {
      client.raw = Buffer.concat([client.raw, d]);
      if (!headerDone) {
        const i = client.raw.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = client.raw.subarray(0, i).toString();
        client.status = parseInt(head.split(' ')[1], 10);
        client.accept = /Sec-WebSocket-Accept: (.+)/i.exec(head)?.[1]?.trim();
        client.protocol = /Sec-WebSocket-Protocol: (.+)/i.exec(head)?.[1]?.trim();
        client.expect = ws.acceptKey(key);
        client.raw = client.raw.subarray(i + 4);
        headerDone = true;
        resolve(client);
      }
      // server frames are unmasked
      while (headerDone && client.status === 101 && client.raw.length >= 2) {
        let len = client.raw[1] & 0x7f; let off = 2;
        if (len === 126) { if (client.raw.length < 4) break; len = client.raw.readUInt16BE(2); off = 4; }
        if (client.raw.length < off + len) break;
        const m = { opcode: client.raw[0] & 0x0f, payload: Buffer.from(client.raw.subarray(off, off + len)) };
        client.raw = client.raw.subarray(off + len);
        client.messages.push(m);
        client.waiters.splice(0).forEach((w) => w());
      }
    });
    sock.on('error', reject);
    sock.write(`GET ${opts.path || '/ws/console'} HTTP/1.1\r\nHost: agent\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: wm-console.${ticket}\r\nOrigin: http://panel.example.com\r\n\r\n`);
  });
}
const sendMasked = (c, opcode, payload) => {
  const body = Buffer.from(payload); const mask = crypto.randomBytes(4);
  const m = Buffer.from(body); for (let i = 0; i < m.length; i++) m[i] ^= mask[i & 3];
  c.sock.write(Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | body.length]), mask, m]));
};
const waitFor = async (c, pred, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = c.messages.find(pred);
    if (hit) return hit;
    await new Promise((r) => { c.waiters.push(r); setTimeout(r, 50); });
  }
  throw new Error(`timeout; messages: ${JSON.stringify(c.messages.map((m) => [m.opcode, m.payload.toString()]))}`);
};

test('ticket -> handshake -> shell: input, output, resize and exit with code', async () => {
  const ticket = sessions.issue(1, { actor: 'admin@example.com', cols: 100, rows: 30 });
  const c = await connect(ticket);
  assert.equal(c.status, 101);
  assert.equal(c.accept, c.expect);
  assert.equal(c.protocol, `wm-console.${ticket}`, 'the offered subprotocol is echoed, as browsers require');
  await waitFor(c, (m) => m.opcode === ws.OP.TEXT && m.payload.toString().includes('"ready"'));
  const prompt = await waitFor(c, (m) => m.opcode === ws.OP.BINARY);
  assert.equal(prompt.payload.toString(), '$ ');

  sendMasked(c, ws.OP.BINARY, 'ls\r');
  await waitFor(c, (m) => m.opcode === ws.OP.BINARY && m.payload.toString() === 'LS\r');

  sendMasked(c, ws.OP.TEXT, JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  const end = Date.now() + 2000;
  while (!calls.some((x) => x === 'POST /exec/exec1/resize?h=40&w=120') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.includes('POST /exec/exec1/resize?h=30&w=100'), 'size from the ticket is applied first');
  assert.ok(calls.includes('POST /exec/exec1/resize?h=40&w=120'), 'resize message reaches Docker');

  sendMasked(c, ws.OP.BINARY, 'exit\r');
  const exit = await waitFor(c, (m) => m.opcode === ws.OP.TEXT && m.payload.toString().includes('"exit"'));
  const info = JSON.parse(exit.payload.toString());
  assert.equal(info.reason, 'shell-exited');
  assert.equal(info.code, 3);
  c.sock.destroy();
  assert.equal(sessions.running.size, 0, 'the session is released');

  const audit = fs.readFileSync(process.env.AUDIT_LOG, 'utf8');
  assert.match(audit, /"event":"console.open".*admin@example.com/);
  assert.match(audit, /"event":"console.close".*"reason":"shell-exited"/);
  assert.doesNotMatch(audit, /ls\\r|LS/, 'keystrokes are never logged');
});

test('a ticket cannot be used twice', async () => {
  const ticket = sessions.issue(1, { actor: 'a' });
  const first = await connect(ticket);
  assert.equal(first.status, 101);
  first.sock.destroy();
  const second = await connect(ticket);
  assert.equal(second.status, 403);
  second.sock.destroy();
});

test('unknown tickets and malformed requests are refused', async () => {
  assert.equal((await connect('f'.repeat(64))).status, 403);
  const bad = await connect('not-a-ticket');
  assert.equal(bad.status, 400);
  const ticket = sessions.issue(1, { actor: 'a' });
  assert.equal((await connect(ticket, { path: `/ws/console/${ticket}` })).status, 400, 'a ticket in the path is not accepted');
  assert.equal((await connect(ticket, { path: '/ws/other' })).status, 400, 'only the console path exists');
  const ok = await connect(ticket);
  assert.equal(ok.status, 101, 'the refused attempts did not use up the ticket');
  ok.sock.destroy();
});

test('Docker refusing the exec (container stopped) is reported to the browser', async () => {
  const ticket = sessions.issue(404, { actor: 'a' });
  const c = await connect(ticket);
  assert.equal(c.status, 101);
  const err = await waitFor(c, (m) => m.opcode === ws.OP.TEXT && m.payload.toString().includes('"error"'));
  assert.match(JSON.parse(err.payload.toString()).message, /not running/);
  c.sock.destroy();
  const end = Date.now() + 2000;
  while (sessions.running.size > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.equal(sessions.running.size, 0);
});

test('sessions are listed and an administrator can end one', async () => {
  const c = await connect(sessions.issue(1, { actor: 'admin@example.com', cols: 80, rows: 24 }));
  await waitFor(c, (m) => m.opcode === ws.OP.TEXT && m.payload.toString().includes('"ready"'));
  sendMasked(c, ws.OP.BINARY, 'ab');
  await waitFor(c, (m) => m.opcode === ws.OP.BINARY && m.payload.toString() === 'AB');
  const [s] = require('../src/console').listSessions();
  assert.equal(s.actor, 'admin@example.com');
  assert.equal(s.siteId, 1);
  assert.equal(s.bytesIn, 2);
  assert.ok(s.bytesOut >= 4);
  assert.match(s.id, /^[0-9a-f]{16}$/);
  assert.equal(require('../src/console').killSession('0'.repeat(16)), false, 'unknown session');
  assert.equal(require('../src/console').killSession(s.id), true);
  const exit = await waitFor(c, (m) => m.opcode === ws.OP.TEXT && m.payload.toString().includes('"exit"'));
  assert.equal(JSON.parse(exit.payload.toString()).reason, 'killed');
  c.sock.destroy();
  assert.deepEqual(require('../src/console').listSessions(), []);
});

test('sessions of an account or a website can be ended at once', async () => {
  const mod = require('../src/console');
  const a = await connect(sessions.issue(1, { actor: 'a@x.de', userId: 5, cols: 80, rows: 24 }));
  const b = await connect(sessions.issue(1, { actor: 'b@x.de', userId: 6, cols: 80, rows: 24 }));
  for (const c of [a, b]) await waitFor(c, (m) => m.opcode === ws.OP.TEXT && m.payload.toString().includes('"ready"'));
  assert.deepEqual(mod.listSessions().map((s) => s.userId).sort(), [5, 6]);
  assert.equal(mod.endUser(5), 1);
  await waitFor(a, (m) => m.opcode === ws.OP.TEXT && m.payload.toString().includes('"killed"'));
  assert.deepEqual(mod.listSessions().map((s) => s.userId), [6], 'only that account is affected');
  assert.equal(mod.endUser(999), 0);
  assert.equal(mod.endSite(1), 1);
  await waitFor(b, (m) => m.opcode === ws.OP.TEXT && m.payload.toString().includes('"killed"'));
  assert.deepEqual(mod.listSessions(), []);
  a.sock.destroy(); b.sock.destroy();
});
