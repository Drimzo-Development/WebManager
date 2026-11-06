'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_KEY = 'a'.repeat(64);
const { refusal, staleSessions } = require('../src/console');

test('a console ticket is only handed out for a ready website with the console switched on', () => {
  assert.equal(refusal({ lifecycle: 'ready', console_enabled: 1 }), null);
  assert.equal(refusal({ lifecycle: 'ready', console_enabled: '1' }), null);
  assert.match(refusal(undefined), /not found/);
  assert.match(refusal({ lifecycle: 'creating', console_enabled: 1 }), /not ready/);
  assert.match(refusal({ lifecycle: 'ready', console_enabled: 0 }), /switched off/);
  assert.match(refusal({ lifecycle: 'ready', console_enabled: '0' }), /switched off/);
});

test('sessions of accounts that are not active administrators any more are stale', () => {
  const sessions = [{ id: 'a', userId: 1 }, { id: 'b', userId: 2 }, { id: 'c', userId: 0 }, { id: 'd' }, { id: 'e', userId: '1' }];
  assert.deepEqual(staleSessions(sessions, [1]).map((s) => s.id), ['b', 'c', 'd'], 'unknown owners are treated as stale');
  assert.deepEqual(staleSessions(sessions, []).map((s) => s.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(staleSessions([], [1]), []);
  assert.deepEqual(staleSessions(null, null), []);
});
