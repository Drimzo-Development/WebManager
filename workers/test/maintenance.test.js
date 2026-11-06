'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_KEY = 'a'.repeat(64);
const m = require('../src/maintenance');

const T = (s) => Date.parse(`${s}Z`);
const row = (over) => ({ site_id: 5, starts_at: '2026-11-10 22:00:00', ends_at: '2026-11-11 02:00:00', repeat_every: 'none', ...over });

test('a one-off window is active from its start until (excluding) its end', () => {
  const w = { starts: T('2026-11-10T22:00:00'), ends: T('2026-11-11T02:00:00'), repeat: 'none' };
  assert.equal(m.currentStart(w, T('2026-11-10T21:59:59')), null);
  assert.equal(m.currentStart(w, T('2026-11-10T22:00:00')), w.starts);
  assert.equal(m.currentStart(w, T('2026-11-11T01:59:59')), w.starts);
  assert.equal(m.currentStart(w, T('2026-11-11T02:00:00')), null);
  assert.equal(m.currentStart(w, T('2027-01-01T00:00:00')), null);
});

test('a daily window recurs with the same length, never before its first start', () => {
  const w = { starts: T('2026-11-10T22:00:00'), ends: T('2026-11-11T02:00:00'), repeat: 'daily' };
  assert.equal(m.currentStart(w, T('2026-11-09T23:00:00')), null);
  assert.equal(m.currentStart(w, T('2026-11-12T23:00:00')), T('2026-11-12T22:00:00'));
  assert.equal(m.currentStart(w, T('2026-11-13T01:00:00')), T('2026-11-12T22:00:00'));
  assert.equal(m.currentStart(w, T('2026-11-13T12:00:00')), null);
});

test('a weekly window recurs only on its weekday', () => {
  const w = { starts: T('2026-11-10T03:00:00'), ends: T('2026-11-10T04:00:00'), repeat: 'weekly' };
  assert.equal(m.currentStart(w, T('2026-11-17T03:30:00')), T('2026-11-17T03:00:00'));
  assert.equal(m.currentStart(w, T('2026-11-18T03:30:00')), null);
});

test('muteSet: windows of a website mute that website, a window without website mutes everything', () => {
  const now = T('2026-11-10T23:00:00');
  const one = m.muteSet([row()], now);
  assert.equal(m.isMuted(one, 5), true);
  assert.equal(m.isMuted(one, 6), false);
  assert.equal(m.isMuted(one, null), false, 'a message that is not about a website stays');
  const all = m.muteSet([row({ site_id: null })], now);
  assert.equal(m.isMuted(all, 6), true);
  assert.equal(m.isMuted(all, null), true);
  const later = m.muteSet([row()], T('2026-11-11T03:00:00'));
  assert.equal(m.isMuted(later, 5), false);
});

test('broken rows and a missing set mute nothing', () => {
  const now = T('2026-11-10T23:00:00');
  assert.equal(m.isMuted(m.muteSet([row({ starts_at: 'junk' }), row({ ends_at: '2026-11-10 21:00:00' })], now), 5), false);
  assert.equal(m.isMuted(null, 5), false);
  assert.equal(m.isMuted(m.muteSet(null, now), 5), false);
});
