import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpuOfLimit, diskTrend, signedBytes } from './resources.ts';

test('cpuOfLimit: share of the own limit, capped', () => {
  assert.equal(cpuOfLimit(50, 1), 50);
  assert.equal(cpuOfLimit(100, 2), 50);
  assert.equal(cpuOfLimit(250, 1), 100);
  assert.equal(cpuOfLimit(10, 0), 0);
  assert.equal(cpuOfLimit(Number.NaN, 1), 0);
});

test('diskTrend: latest value and change against a week earlier', () => {
  assert.equal(diskTrend([]), null);
  assert.deepEqual(diskTrend([{ day: '2026-11-02', bytes: 500 }]), { latest: 500, delta: null });
  const rows = [{ day: '2026-10-20', bytes: 100 }, { day: '2026-10-26', bytes: 150 }, { day: '2026-10-27', bytes: 200 }, { day: '2026-11-02', bytes: 900 }];
  assert.deepEqual(diskTrend(rows), { latest: 900, delta: 750 }, 'compared with the newest value that is at least 7 days old (26 Oct)');
  assert.deepEqual(diskTrend(rows, 30), { latest: 900, delta: null });
});

test('signedBytes', () => {
  const f = (n: number) => `${n} B`;
  assert.equal(signedBytes(5, f), '+5 B');
  assert.equal(signedBytes(-5, f), '−5 B');
  assert.equal(signedBytes(0, f), '±0');
});
