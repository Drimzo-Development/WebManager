'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-protect-'));
process.env.AGENT_TOKEN_DASHBOARD = 'a'.repeat(40);
process.env.AGENT_TOKEN_WORKER = 'b'.repeat(40);
process.env.TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

const p = require('../src/protect');

test('access log lines of the proxy are parsed', () => {
  const line = '203.0.113.7 - [11/Oct/2026:09:43:34 +0000] "cdn.example.com" "GET /a?b=1 HTTP/1.1" 404 12 "Mozilla/5.0" rt=0.001';
  assert.deepEqual(p.parseAccessLine(line), { ip: '203.0.113.7', host: 'cdn.example.com', status: 404 });
  assert.equal(p.parseAccessLine('2026/10/11 09:43:27 [warn] 1#1: something'), null);
  assert.equal(p.parseAccessLine('::ffff:198.51.100.4 - [x] "h" "GET / HTTP/1.1" 200 1 "-" rt=0').ip, '198.51.100.4');
});

test('addresses and networks are matched for IPv4 and IPv6', () => {
  assert.equal(p.ipInNet('10.1.2.3', '10.0.0.0/8'), true);
  assert.equal(p.ipInNet('11.1.2.3', '10.0.0.0/8'), false);
  assert.equal(p.ipInNet('203.0.113.7', '203.0.113.7'), true);
  assert.equal(p.ipInNet('2001:db8::1', '2001:db8::/32'), true);
  assert.equal(p.ipInNet('2001:db9::1', '2001:db8::/32'), false);
  assert.equal(p.ipInNet('::1', '::1/128'), true);
  assert.equal(p.ipInNet('10.0.0.1', '2001:db8::/32'), false, 'families never match each other');
  assert.equal(p.ipInNet('fd00::5', 'fc00::/7'), true);
});

test('floods and error storms are detected inside the window only', () => {
  const t = new p.Tracker();
  const cfg = { maxRequests: 100, maxErrors: 30, windowSec: 60 };
  const t0 = 1_000_000_000;
  for (let i = 0; i < 99; i++) t.add('1.1.1.1', 200, t0 + i * 100);
  assert.equal(p.banReason(t.totals('1.1.1.1', 60, t0 + 20000), cfg), null);
  t.add('1.1.1.1', 200, t0 + 10000);
  assert.match(p.banReason(t.totals('1.1.1.1', 60, t0 + 20000), cfg), /100 requests/);
  // the same traffic 2 minutes later is out of the window
  assert.equal(p.banReason(t.totals('1.1.1.1', 60, t0 + 130000), cfg), null);

  for (let i = 0; i < 30; i++) t.add('2.2.2.2', i % 2 ? 404 : 401, t0 + i * 50);
  assert.match(p.banReason(t.totals('2.2.2.2', 60, t0 + 5000), cfg), /30 erroneous/);
  for (let i = 0; i < 29; i++) t.add('3.3.3.3', 304, t0 + i);
  assert.equal(p.banReason(t.totals('3.3.3.3', 60, t0 + 5000), cfg), null, '304 is not an error');
  assert.deepEqual(t.prune(60, t0 + 400000), []);
});

test('the ban map never contains local networks and has no duplicates', () => {
  const out = p.renderBanMap(['203.0.113.0/24', '10.0.0.0/8'], ['203.0.113.0/24', '198.51.100.9']);
  assert.equal(out.split('\n').filter((l) => l.endsWith(' 1;')).length, 2);
  assert.doesNotMatch(out, /10\.0\.0\.0/);
});

test('configuration is validated', () => {
  const ok = p.validateConfig({ autoBan: { enabled: true, maxRequests: 500, maxErrors: 100, windowSec: 60, banMinutes: 30 }, whitelist: ['203.0.113.7'], manual: ['198.51.100.0/24'] });
  assert.equal(ok.autoBan.enabled, true);
  assert.throws(() => p.validateConfig({ autoBan: { maxRequests: 5 } }));
  assert.throws(() => p.validateConfig({ whitelist: ['not-an-ip'] }));
  assert.throws(() => p.validateConfig({ manual: ['1.2.3.4; deny all'] }));
  assert.equal(p.validateConfig({}).autoBan.enabled, false);
});
