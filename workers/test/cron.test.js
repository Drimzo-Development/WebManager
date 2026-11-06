'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TZ = 'UTC';
const { parse, next } = require('../src/cron');

const at = (s, from) => { const d = next(s, new Date(from)); return d ? d.toISOString() : null; };

test('standard expressions', () => {
  assert.equal(at('* * * * *', '2026-10-12T10:00:30Z'), '2026-10-12T10:01:00.000Z');
  assert.equal(at('*/15 * * * *', '2026-10-12T10:07:00Z'), '2026-10-12T10:15:00.000Z');
  assert.equal(at('0 3 * * *', '2026-10-12T03:00:00Z'), '2026-10-13T03:00:00.000Z', 'strictly after the point in time, not equal');
  assert.equal(at('30 2 * * 1', '2026-10-12T10:00:00Z'), '2026-10-19T02:30:00.000Z', 'Monday');
  assert.equal(at('0 0 1 * *', '2026-10-12T10:00:00Z'), '2026-11-01T00:00:00.000Z');
  assert.equal(at('5,35 8-10 * * *', '2026-10-12T08:10:00Z'), '2026-10-12T08:35:00.000Z');
  assert.equal(at('10-30/10 * * * *', '2026-10-12T10:11:00Z'), '2026-10-12T10:20:00.000Z');
});

test('aliases', () => {
  assert.equal(at('@hourly', '2026-10-12T10:20:00Z'), '2026-10-12T11:00:00.000Z');
  assert.equal(at('@daily', '2026-10-12T10:20:00Z'), '2026-10-13T00:00:00.000Z');
  assert.equal(at('@weekly', '2026-10-12T10:20:00Z'), '2026-10-18T00:00:00.000Z', 'Sunday');
  assert.equal(at('@monthly', '2026-12-31T23:59:00Z'), '2027-01-01T00:00:00.000Z');
});

test('Sunday as 0 or 7, day and weekday are combined with OR', () => {
  assert.equal(at('0 12 * * 7', '2026-10-12T00:00:00Z'), at('0 12 * * 0', '2026-10-12T00:00:00Z'));
  // on the 15th or on a Friday: the next match after Monday 12 Oct. is Friday 16 Oct.? No: 15 Oct. (Thursday) comes first
  assert.equal(at('0 9 15 * 5', '2026-10-12T00:00:00Z'), '2026-10-15T09:00:00.000Z');
});

test('new year, leap year, dates that never occur', () => {
  assert.equal(at('0 0 29 2 *', '2026-10-12T00:00:00Z'), '2028-02-29T00:00:00.000Z');
  assert.equal(at('0 0 31 2 *', '2026-10-12T00:00:00Z'), null);
});

test('invalid expressions are rejected', () => {
  for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', 'a b c d e', '5-1 * * * *', '@yearly', '1,,2 * * * *', '; rm -rf / * * * *']) {
    assert.throws(() => parse(bad), Error, bad);
  }
});

test('the time zone of the process is used', () => {
  // 03:00 server time; the run must hit the same local hour as Date#getHours
  const d = next('0 3 * * *', new Date('2026-10-12T10:00:00Z'));
  assert.equal(d.getHours(), 3);
  assert.equal(d.getMinutes(), 0);
});
