import assert from 'node:assert/strict';
import { test } from 'node:test';
import { certInfo, daysUntil, formatBytes, needsAttention, parseServerDate, relativeTime, stateInfo } from './format.ts';

const NOW = Date.parse('2026-10-23T12:00:00Z');

test('formatBytes: B, KB, MB, GB', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(Number.NaN), '0 B');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(1), '1 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(20 * 1024), '20 KB');
  assert.equal(formatBytes(5.5 * 1024 ** 2), '5.5 MB');
  assert.equal(formatBytes(212 * 1024 ** 2), '212 MB');
  assert.equal(formatBytes(3.4 * 1024 ** 3), '3.4 GB');
});

test('server time is read as UTC (with and without zone)', () => {
  assert.equal(parseServerDate('2026-10-23 12:00:00'), NOW);
  assert.equal(parseServerDate('2026-10-23T12:00:00Z'), NOW);
  assert.equal(parseServerDate('2026-10-23T14:00:00+02:00'), NOW);
});

test('relativeTime', () => {
  assert.equal(relativeTime('2026-10-23 11:59:50', NOW), 'just now');
  assert.equal(relativeTime('2026-10-23 11:48:00', NOW), '12 min ago');
  assert.equal(relativeTime('2026-10-23 09:00:00', NOW), '3 h ago');
  assert.equal(relativeTime('2026-10-22 11:00:00', NOW), 'yesterday');
  assert.equal(relativeTime('2026-10-20 12:00:00', NOW), '3 days ago');
  assert.equal(relativeTime('broken', NOW), '');
});

test('daysUntil', () => {
  assert.equal(daysUntil(null, NOW), null);
  assert.equal(daysUntil('2026-11-01 12:00:00', NOW), 9);
  assert.equal(daysUntil('2026-10-22 12:00:00', NOW), -1);
});

test('stateInfo: known and unknown states', () => {
  assert.deepEqual(stateInfo('running'), { tone: 'ok', label: 'Running' });
  assert.deepEqual(stateInfo('crashed'), { tone: 'err', label: 'Crashed' });
  assert.deepEqual(stateInfo('exotic'), { tone: '', label: 'exotic' });
});

test('certInfo: thresholds 14 and 3 days, error, no HTTPS', () => {
  assert.equal(certInfo('active', '2026-12-30 00:00:00', NOW).tone, 'ok');
  assert.equal(certInfo('active', '2026-11-01 12:00:00', NOW).tone, 'warn');
  assert.equal(certInfo('active', '2026-10-25 12:00:00', NOW).tone, 'err');
  assert.equal(certInfo('active', '2026-10-01 12:00:00', NOW).label, 'Expired');
  assert.equal(certInfo('failed', null, NOW).tone, 'err');
  assert.deepEqual(certInfo('none', null, NOW), { tone: '', label: 'No HTTPS' });
});

test('needsAttention: a failed HTTP check of a running website needs attention', () => {
  assert.equal(needsAttention('running', 'active', '2026-12-30 00:00:00', NOW, true), 'err');
  assert.equal(needsAttention('running', 'active', '2026-12-30 00:00:00', NOW, false), null);
});

test('needsAttention', () => {
  assert.equal(needsAttention('running', 'active', '2026-12-30 00:00:00', NOW), null);
  assert.equal(needsAttention('crashed', 'active', '2026-12-30 00:00:00', NOW), 'err');
  assert.equal(needsAttention('running', 'active', '2026-11-01 12:00:00', NOW), 'warn');
  assert.equal(needsAttention('stopped', 'none', null, NOW), null);
});
