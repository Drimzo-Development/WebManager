'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_KEY = 'a'.repeat(64);
const { isDue, build, localParts } = require('../src/report');

const rule = { enabled: 1, weekday: 1, hour: 8, last_sent_at: null };

test('local weekday and hour follow the time zone', () => {
  // Sunday 23:30 UTC is already Monday 01:30 in Berlin (CEST)
  const d = new Date('2026-10-18T23:30:00Z');
  assert.deepEqual(localParts(d, 'UTC'), { weekday: 0, hour: 23 });
  assert.deepEqual(localParts(d, 'Europe/Berlin'), { weekday: 1, hour: 1 });
  assert.equal(localParts(new Date('2026-10-19T00:05:00Z'), 'UTC').hour, 0);
});

test('a report is due on the chosen weekday from the chosen hour on', () => {
  assert.equal(isDue(rule, new Date('2026-10-19T07:59:00Z'), 'UTC'), false, 'too early');
  assert.equal(isDue(rule, new Date('2026-10-19T08:00:00Z'), 'UTC'), true);
  assert.equal(isDue(rule, new Date('2026-10-19T17:00:00Z'), 'UTC'), true, 'still due later that day if it was missed');
  assert.equal(isDue(rule, new Date('2026-10-20T09:00:00Z'), 'UTC'), false, 'wrong weekday');
  assert.equal(isDue({ ...rule, enabled: 0 }, new Date('2026-10-19T09:00:00Z'), 'UTC'), false);
});

test('a report that was already sent this week is not sent again', () => {
  const now = new Date('2026-10-19T09:00:00Z');
  assert.equal(isDue({ ...rule, last_sent_at: '2026-10-19 08:01:00' }, now, 'UTC'), false);
  assert.equal(isDue({ ...rule, last_sent_at: '2026-10-12 08:01:00' }, now, 'UTC'), true, 'last week\'s report does not block this one');
});

const rep = (over = {}) => ({
  from: Date.parse('2026-10-12T08:00:00Z'), to: Date.parse('2026-10-19T08:00:00Z'),
  current: { req: 100800, s2: 90000, s3: 5000, s4: 5000, s5: 800, bytes: 5 * 1048576, waf: 3, peakReq: 42, peakAt: Date.parse('2026-10-14T12:30:00Z'), avgPerMin: 10, errorRate: 0.0575, cpuAvg: 12.5, cpuMax: 80, memMax: 200 * 1048576, memLimit: 512 * 1048576 },
  previous: { req: 50400, bytes: 5 * 1048576 },
  visitors: [{ day: '2026-10-12', n: 10 }, { day: '2026-10-13', n: 30 }],
  topPages: [{ path: '/', count: 500 }], top404: [{ path: '/alt', count: 4 }], waf: {},
  ...over,
});

test('the mail names the rates per minute and compares with the previous week', () => {
  const m = build({ id: 1, name: 'Shop' }, ['shop.example.com'], rep(), 'UTC');
  const f = Object.fromEntries(m.facts);
  assert.match(f['Total requests'], /100,800.*\+100 % vs\. last week/);
  assert.equal(f['Avg. requests per minute'], '10.0');
  assert.match(f['Peak per minute'], /^42 /);
  assert.match(f['Visitors (sum of days)'], /^40,/);
  assert.match(f['Traffic'], /5\.0 MB \(unchanged/);
  assert.equal(f['Website'], 'shop.example.com');
  assert.match(m.text, /• \/ – 500×/);
  assert.equal(m.kind, 'info', '0.8 % server errors stay below the warning threshold');
});

test('many server errors turn the mail into a warning; a quiet week is reported plainly', () => {
  const bad = rep({ current: { ...rep().current, s5: 5000 } });
  assert.equal(build({ id: 1, name: 'Shop' }, [], bad, 'UTC').kind, 'warn');
  const quiet = rep({ current: { req: 0, s2: 0, s3: 0, s4: 0, s5: 0, bytes: 0, waf: 0, peakReq: 0, peakAt: null, avgPerMin: 0, errorRate: 0, cpuAvg: null, cpuMax: 0, memMax: 0, memLimit: 0 }, previous: { req: 0, bytes: 0 }, visitors: [], topPages: [], top404: [] });
  const m = build({ id: 1, name: 'Shop' }, [], quiet, 'UTC');
  assert.match(m.text, /No requests/);
  const f = Object.fromEntries(m.facts);
  assert.equal(f['Peak per minute'], '');
  assert.equal(f['Total requests'], '0');
});
