import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_FILTER, PRESETS, parseFilter, presetOf, toggle } from './statsFilter.ts';

test('presetOf recognises presets, any other selection is custom', () => {
  assert.equal(presetOf(DEFAULT_FILTER), 'all');
  assert.equal(presetOf(PRESETS.errors), 'errors');
  assert.equal(presetOf(PRESETS.server), 'server');
  assert.equal(presetOf({ status: ['s5'], sections: ['requests', 'waf'] }), null);
});

test('toggle: order stays, the last status class stays on', () => {
  const all = ['s2', 's3', 's4', 's5'] as const;
  assert.deepEqual(toggle(['s2', 's5'], [...all], 's4'), ['s2', 's4', 's5']);
  assert.deepEqual(toggle(['s2', 's4', 's5'], [...all], 's4'), ['s2', 's5']);
  assert.deepEqual(toggle(['s5'], [...all], 's5', true), ['s5']);
  assert.deepEqual(toggle(['requests'], ['requests', 'waf'], 'requests'), []);
});

test('parseFilter: broken or foreign values give the preset', () => {
  assert.deepEqual(parseFilter(null), DEFAULT_FILTER);
  assert.deepEqual(parseFilter('{kaputt'), DEFAULT_FILTER);
  assert.deepEqual(parseFilter(JSON.stringify({ status: ['x'], sections: ['requests', 'y'] })), { status: ['s2', 's3', 's4', 's5'], sections: ['requests'] });
  assert.deepEqual(parseFilter(JSON.stringify(PRESETS.errors)), PRESETS.errors);
});
