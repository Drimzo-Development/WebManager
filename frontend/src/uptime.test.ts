import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBars, formatPct, uptimeTone } from './uptime.ts';

test('formatPct: no rounding up to 100, whole numbers without decimals', () => {
  assert.equal(formatPct(null), '–');
  assert.equal(formatPct(100), '100 %');
  assert.equal(formatPct(99.996), '99.99 %');
  assert.equal(formatPct(99.5), '99.5 %');
  assert.equal(formatPct(99), '99 %');
  assert.equal(formatPct(0), '0 %');
  assert.equal(formatPct(Number.NaN), '–');
});

test('uptimeTone: thresholds 99.9 and 99', () => {
  assert.equal(uptimeTone(null), '');
  assert.equal(uptimeTone(100), 'ok');
  assert.equal(uptimeTone(99.9), 'ok');
  assert.equal(uptimeTone(99.5), 'warn');
  assert.equal(uptimeTone(98.9), 'err');
});

test('buildBars: fills gaps, the newest bar contains "now", colours by failures', () => {
  const bars = buildBars([
    { t: 6_000, n: 10, up: 10, ms: 40 },
    { t: 4_200, n: 30, up: 0, ms: null },
    { t: 4_800, n: 30, up: 29, ms: 55 },
  ], 600, 4, 6_100);
  assert.deepEqual(bars.map((b) => b.t), [4_200, 4_800, 5_400, 6_000]);
  assert.deepEqual(bars.map((b) => b.state), ['err', 'warn', 'none', 'ok']);
});

test('buildBars: all failed is red, some failed is orange', () => {
  const bars = buildBars([{ t: 600, n: 5, up: 0, ms: null }, { t: 1200, n: 5, up: 4, ms: 10 }], 600, 2, 1300);
  assert.deepEqual(bars.map((b) => b.state), ['err', 'warn']);
});
