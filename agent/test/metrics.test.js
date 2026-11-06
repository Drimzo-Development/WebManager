'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-metrics-'));
process.env.AGENT_TOKEN_DASHBOARD = 'a'.repeat(40);
process.env.AGENT_TOKEN_WORKER = 'b'.repeat(40);
process.env.TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

const proxylog = require('../src/proxylog');
const metrics = require('../src/metrics');

test('access log lines carry method, path, status, size and firewall markers', () => {
  const e = proxylog.parseLine('203.0.113.7 - [11/Oct/2026:09:43:34 +0000] "Shop.Example.com" "GET /products/shoes?color=red HTTP/1.1" 200 5123 "Mozilla/5.0" rt=0.010');
  assert.deepEqual(e, { ip: '203.0.113.7', host: 'shop.example.com', method: 'GET', path: '/products/shoes', request: 'GET /products/shoes?color=red HTTP/1.1', status: 200, bytes: 5123, waf: null });
  const w = proxylog.parseLine('203.0.113.7 - [x] "a.example.com" "GET /?q=%3Cscript%3E HTTP/1.1" 403 150 "WAF:xss" rt=0.000');
  assert.equal(w.waf, 'xss');
  assert.equal(proxylog.parseLine('2026/10/11 09:43:27 [warn] 1#1: nothing'), null);
  assert.equal(proxylog.parseLine('1.2.3.4 - [x] "h" "GET / HTTP/1.1" 304 - "-" rt=0').bytes, 0);
});

test('minute records are summed or averaged into the requested bucket size', () => {
  const t0 = Date.parse('2026-10-11T10:00:00Z');
  const rows = [
    { t: t0, cpu: 10, mem: 100, memLimit: 500, req: 5, s2: 4, s3: 0, s4: 1, s5: 0, bytes: 1000, waf: 0 },
    { t: t0 + 60000, cpu: 30, mem: 300, memLimit: 500, req: 7, s2: 7, s3: 0, s4: 0, s5: 0, bytes: 500, waf: 2 },
    { t: t0 + 300000, cpu: null, mem: null, req: 1, s2: 0, s3: 0, s4: 0, s5: 1, bytes: 10, waf: 0 },
  ];
  const pts = metrics.downsample(rows, 300, t0, t0 + 600000);
  assert.equal(pts.length, 3);
  assert.deepEqual([pts[0].req, pts[0].s4, pts[0].bytes, pts[0].waf, pts[0].cpu, pts[0].mem], [12, 1, 1500, 2, 20, 200]);
  assert.deepEqual([pts[1].req, pts[1].s5, pts[1].cpu], [1, 1, null]);
  assert.deepEqual([pts[2].req, pts[2].cpu], [0, null], 'empty buckets stay in the series');
});

test('a stored history is returned with totals, top lists and firewall counts', () => {
  const dir = path.join(process.env.DATA_DIR, 'metrics', 'site-001');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const t = Math.floor(now / 60000) * 60000 - 120000;
  fs.writeFileSync(path.join(dir, `m-${today}.jsonl`), `${JSON.stringify({ t, cpu: 12.5, mem: 1000, memLimit: 4000, req: 10, s2: 8, s3: 1, s4: 1, s5: 0, bytes: 2048, waf: 1 })}\n{broken\n`);
  fs.writeFileSync(path.join(dir, `d-${today}.json`), JSON.stringify({ pages: { '/': 7, '/contact': 3 }, p404: { '/alt': 2 }, waf: { sqli: 1 }, recentWaf: [{ t, ip: '203.0.113.9', cat: 'sqli', request: 'GET /?id=1 union select HTTP/1.1', status: 403 }], visitors: 4 }));
  const r = metrics.query(1, '1h');
  assert.equal(r.totals.req, 10);
  assert.equal(r.totals.waf, 1);
  assert.deepEqual(r.topPages[0], { path: '/', count: 7 });
  assert.deepEqual(r.top404, [{ path: '/alt', count: 2 }]);
  assert.equal(r.waf.sqli, 1);
  assert.equal(r.visitors.at(-1).n, 4);
  assert.equal(r.recentWaf[0].cat, 'sqli');
  assert.equal(r.points.length >= 60, true);
  assert.throws(() => metrics.query(1, '5y'), /period/);
});

test('the weekly report gives the average and peak rate per minute and compares with the week before', () => {
  const dir = path.join(process.env.DATA_DIR, 'metrics', 'site-002');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.parse('2026-10-19T08:00:00Z');
  const rec = (t, req, s5 = 0) => `${JSON.stringify({ t, cpu: 10, mem: 100, memLimit: 400, req, s2: req - s5, s3: 0, s4: 0, s5, bytes: req * 100, waf: 0 })}\n`;
  const thisWeek = Date.parse('2026-10-15T10:00:00Z');
  const lastWeek = Date.parse('2026-10-08T10:00:00Z');
  fs.writeFileSync(path.join(dir, 'm-2026-10-15.jsonl'), rec(thisWeek, 30) + rec(thisWeek + 60000, 70, 7));
  fs.writeFileSync(path.join(dir, 'm-2026-10-08.jsonl'), rec(lastWeek, 50));
  fs.writeFileSync(path.join(dir, 'd-2026-10-15.json'), JSON.stringify({ pages: { '/': 9 }, p404: {}, waf: {}, visitors: 6 }));
  const r = metrics.report(2, 7, now);
  assert.equal(r.current.req, 100);
  assert.equal(r.current.peakReq, 70);
  assert.equal(r.current.peakAt, thisWeek + 60000);
  assert.equal(r.current.avgPerMin, 100 / (7 * 1440));
  assert.equal(r.current.s5, 7);
  assert.equal(r.current.cpuAvg, 10);
  assert.equal(r.previous.req, 50);
  assert.deepEqual(r.topPages, [{ path: '/', count: 9 }]);
  assert.deepEqual(r.visitors, [{ day: '2026-10-15', n: 6 }]);
});
