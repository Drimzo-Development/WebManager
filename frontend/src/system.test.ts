import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diskInfo, nextAwaiting, parseSystemRoute, pollDelay, SYSTEM_SUBS, systemHref } from './system.ts';

test('parseSystemRoute: valid and invalid addresses', () => {
  assert.equal(parseSystemRoute('/system'), 'overview');
  assert.equal(parseSystemRoute('/system/backup'), 'backup');
  for (const s of SYSTEM_SUBS) assert.equal(parseSystemRoute(systemHref(s.key).slice(1)), s.key);
  for (const bad of ['/', '/system/', '/system/unknown', '/system/backup/x', '/sites/1', '//system', '/systems']) assert.equal(parseSystemRoute(bad), null, bad);
});

test('sections have unique keys and groups', () => {
  assert.equal(new Set(SYSTEM_SUBS.map((s) => s.key)).size, SYSTEM_SUBS.length);
  assert.ok(SYSTEM_SUBS.every((s) => s.group && s.label && s.icon));
});

test('diskInfo: thresholds 75 and 90 percent, broken values', () => {
  assert.deepEqual(diskInfo(100, 50), { used: 50, pct: 50, tone: 'ok' });
  assert.equal(diskInfo(100, 25).tone, 'warn');
  assert.equal(diskInfo(100, 24).tone, 'warn');
  assert.equal(diskInfo(100, 10).tone, 'err');
  assert.equal(diskInfo(100, 0).pct, 100);
  assert.equal(diskInfo(0, 0).tone, '');
  assert.equal(diskInfo(100, 150).used, 0);
});

test('pollDelay: fast when active, slow when idle', () => {
  assert.equal(pollDelay({ running: true, pending: false, awaiting: false, failed: false }), 4000);
  assert.equal(pollDelay({ running: false, pending: true, awaiting: false, failed: false }), 4000);
  assert.equal(pollDelay({ running: false, pending: false, awaiting: true, failed: false }), 4000);
  assert.equal(pollDelay({ running: false, pending: false, awaiting: false, failed: true }), 8000);
  assert.equal(pollDelay({ running: false, pending: false, awaiting: false, failed: false }), 30_000);
});

test('nextAwaiting: start seen, finished, timeout', () => {
  const w = { since: 1000, seenRunning: false };
  assert.deepEqual(nextAwaiting(null, { running: true, requestPending: false }, 5000), { awaiting: null, timedOut: false });
  assert.deepEqual(nextAwaiting(w, { running: true, requestPending: false }, 2000), { awaiting: { since: 1000, seenRunning: true }, timedOut: false });
  assert.deepEqual(nextAwaiting({ since: 1000, seenRunning: true }, { running: false, requestPending: false }, 2000), { awaiting: null, timedOut: false });
  assert.deepEqual(nextAwaiting(w, { running: false, requestPending: true }, 500_000), { awaiting: w, timedOut: false });
  assert.deepEqual(nextAwaiting(w, { running: false, requestPending: false }, 50_000), { awaiting: w, timedOut: false });
  assert.deepEqual(nextAwaiting(w, { running: false, requestPending: false }, 130_000), { awaiting: null, timedOut: true });
});
