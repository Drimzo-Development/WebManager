import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CRON_PRESETS, cronLabel } from './cron.ts';

test('cronLabel: presets, shortcuts, custom expressions', () => {
  assert.equal(cronLabel('0 3 * * *'), 'Daily at 03:00');
  assert.equal(cronLabel('  */5 * * * * '), 'Every 5 minutes');
  assert.equal(cronLabel('@daily'), 'Daily at 00:00');
  assert.equal(cronLabel('@WEEKLY'), 'Weekly, Sunday 00:00');
  assert.equal(cronLabel('17 4 * * 2'), '');
  assert.equal(cronLabel(''), '');
});

test('every preset has a name and is unique', () => {
  assert.equal(new Set(CRON_PRESETS.map((p) => p[0])).size, CRON_PRESETS.length);
  for (const [expr, label] of CRON_PRESETS) {
    assert.equal(cronLabel(expr), label);
    assert.equal(expr.split(' ').length, 5);
  }
});
