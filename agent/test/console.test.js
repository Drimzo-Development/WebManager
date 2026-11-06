'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.DATA_DIR = path.join(require('os').tmpdir(), 'wm-data-test');
process.env.AGENT_TOKEN_DASHBOARD = 'a'.repeat(40);
process.env.AGENT_TOKEN_WORKER = 'b'.repeat(40);

const { Sessions, parseControl, clampInt, ticketFrom, TOTAL, PER_SITE } = require('../src/console');

test('a ticket works once and only for a short time', () => {
  const s = new Sessions();
  const t = s.issue(7, { actor: 'a@b.de' }, 1000);
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(s.redeem('0'.repeat(64), 1500), null, 'unknown ticket');
  assert.equal(s.redeem(t, 1500).siteId, 7);
  assert.equal(s.redeem(t, 1600), null, 'second use');
  const late = s.issue(7, {}, 1000);
  assert.equal(s.redeem(late, 1000 + 31_000), null, 'expired after 30 seconds');
});

test('tickets are random', () => {
  const s = new Sessions();
  assert.notEqual(s.issue(1, {}), s.issue(1, {}));
});

test('limits per website and in total, running sessions count', () => {
  const s = new Sessions();
  for (let i = 0; i < PER_SITE; i++) s.issue(1, {});
  assert.throws(() => s.issue(1, {}), (e) => e.status === 429 && /per website/.test(e.message));
  const s2 = new Sessions();
  for (let i = 0; i < TOTAL; i++) s2.issue(i + 1, {});
  assert.throws(() => s2.issue(99, {}), (e) => e.status === 429 && /same time/.test(e.message));
  const s3 = new Sessions();
  const id = s3.begin(5);
  for (let i = 0; i < PER_SITE - 1; i++) s3.issue(5, {});
  assert.throws(() => s3.issue(5, {}), /per website/);
  s3.end(id);
  assert.doesNotThrow(() => s3.issue(5, {}));
});

test('expired tickets free their place', () => {
  const s = new Sessions();
  for (let i = 0; i < PER_SITE; i++) s.issue(1, {}, 0);
  assert.doesNotThrow(() => s.issue(1, {}, 40_000));
});

test('control messages: only a valid resize is accepted', () => {
  const b = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o));
  assert.deepEqual(parseControl(b({ type: 'resize', cols: 120, rows: 30 })), { type: 'resize', cols: 120, rows: 30 });
  assert.equal(parseControl(b({ type: 'resize', cols: 0, rows: 30 })), null);
  assert.equal(parseControl(b({ type: 'resize', cols: 9999, rows: 30 })), null);
  assert.equal(parseControl(b({ type: 'resize', cols: '80', rows: 24 })).cols, 80);
  assert.equal(parseControl(b({ type: 'exec', cmd: 'rm -rf /' })), null);
  assert.equal(parseControl(b('not json')), null);
  assert.equal(parseControl(b('null')), null);
});

test('clampInt keeps sizes inside the limits', () => {
  assert.equal(clampInt(80, 1, 500, 24), 80);
  assert.equal(clampInt(0, 1, 500, 24), 24);
  assert.equal(clampInt('abc', 1, 500, 24), 24);
  assert.equal(clampInt(1.5, 1, 500, 24), 24);
});

test('the ticket is read from the offered subprotocols only', () => {
  const t = 'ab'.repeat(32);
  assert.deepEqual(ticketFrom(`wm-console.${t}`), { ticket: t, protocol: `wm-console.${t}` });
  assert.equal(ticketFrom(`chat, wm-console.${t}`).ticket, t);
  assert.equal(ticketFrom(`wm-console.${t.toUpperCase()}`), null, 'lower case hex only');
  assert.equal(ticketFrom('wm-console.abc'), null);
  assert.equal(ticketFrom(`x-wm-console.${t}`), null);
  assert.equal(ticketFrom(undefined), null);
});
