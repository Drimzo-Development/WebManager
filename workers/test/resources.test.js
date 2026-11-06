'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_KEY = 'a'.repeat(64);
const { diskRows, pressure, restartEvent } = require('../src/resources');

test('disk rows: only existing websites, valid sizes, ids from the directory name', () => {
  const usage = [{ site: 'site-001', bytes: 1000 }, { site: 'site-002', bytes: 5.6 }, { site: 'site-009', bytes: 1 }, { site: 'junk', bytes: 1 }, { site: 'site-003', bytes: -1 }, { site: 'site-004', bytes: NaN }];
  assert.deepEqual(diskRows(usage, [1, 2, 3, 4], '2026-11-02'), [[1, '2026-11-02', 1000], [2, '2026-11-02', 6]]);
  assert.deepEqual(diskRows(null, [1], 'x'), []);
});

test('memory pressure: reported once after five high readings, again only after a clear recovery', () => {
  let r = { state: undefined };
  const events = [];
  for (const pct of [95, 96, 97, 98, 99, 99, 99]) { r = pressure(r.state, pct, 90); events.push(r.event); }
  assert.deepEqual(events, [null, null, null, null, 'high', null, null]);
  r = pressure(r.state, 88, 90); // hovering just below the limit does not reset
  r = pressure(r.state, 92, 90);
  assert.equal(r.event, null);
  r = pressure(r.state, 50, 90); // clearly below: reset
  for (const pct of [95, 95, 95, 95]) r = pressure(r.state, pct, 90);
  assert.equal(r.event, null);
  r = pressure(r.state, 95, 90);
  assert.equal(r.event, 'high');
});

test('a short peak never produces a message', () => {
  let r = { state: undefined };
  for (const pct of [99, 99, 40, 99, 99, 40]) { r = pressure(r.state, pct, 90); assert.equal(r.event, null); }
});

test('restart event: nothing to compare on the first pass, then the increase and the OOM flag', () => {
  assert.equal(restartEvent(undefined, { restartCount: 3 }), null);
  assert.equal(restartEvent(3, { restartCount: 3 }), null);
  assert.equal(restartEvent(3, { restartCount: 2 }), null, 'counter reset after the container was re-created');
  assert.deepEqual(restartEvent(3, { restartCount: 5, oomKilled: true }), { restarts: 2, oom: true });
  assert.deepEqual(restartEvent(0, { restartCount: 1 }), { restarts: 1, oom: false });
  assert.equal(restartEvent(1, null), null);
  assert.equal(restartEvent(1, { restartCount: 'x' }), null);
});
