import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatePercent, formatElapsed, IDLE, isStalled, progressText, STALL_AFTER_MS } from './progress.ts';

test('estimatePercent: range per phase, never above 95 before the end', () => {
  assert.equal(estimatePercent('request', 0), 0);
  assert.ok(estimatePercent('request', 10_000) < 20.0001 && estimatePercent('request', 10_000) > 19.9);
  assert.equal(estimatePercent('queued', 0), 20);
  assert.ok(estimatePercent('queued', 60_000) <= 35);
  assert.equal(estimatePercent('running', 0), 35);
  assert.ok(estimatePercent('running', 10 * 60_000) < 95.0001);
  assert.equal(estimatePercent('done', 0), 100);
});

test('estimatePercent: rises monotonically with time and phase', () => {
  for (const ph of ['request', 'queued', 'running'] as const) {
    let prev = -1;
    for (let t = 0; t <= 120_000; t += 3000) {
      const p = estimatePercent(ph, t);
      assert.ok(p >= prev, `${ph} drops at ${t}`);
      prev = p;
    }
  }
  assert.ok(estimatePercent('request', 99_999) <= estimatePercent('queued', 0));
  assert.ok(estimatePercent('queued', 99_999) <= estimatePercent('running', 0));
});

test('estimatePercent: time constant, negative times and tiny values', () => {
  assert.ok(estimatePercent('running', 5000, 5000) > estimatePercent('running', 5000, 50_000));
  assert.equal(estimatePercent('running', -1000), 35);
  assert.ok(Number.isFinite(estimatePercent('running', 3000, 0)));
});

test('formatElapsed', () => {
  assert.equal(formatElapsed(0), '0 s');
  assert.equal(formatElapsed(4999), '4 s');
  assert.equal(formatElapsed(59_999), '59 s');
  assert.equal(formatElapsed(65_000), '1:05 min');
  assert.equal(formatElapsed(12 * 60_000), '12:00 min');
  assert.equal(formatElapsed(-5), '0 s');
});

test('isStalled and progressText', () => {
  assert.equal(isStalled(1000 + STALL_AFTER_MS, 1000), false);
  assert.equal(isStalled(1001 + STALL_AFTER_MS, 1000), true);
  assert.equal(progressText({ percent: 36.6, elapsedMs: 12_400 }), '37 % · 12 s');
  assert.equal(IDLE.active, false);
});
