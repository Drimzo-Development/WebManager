import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localToIso, nextFullHour, stateOf, toLocalInput } from './maintenance.ts';
import type { MaintenanceWindow } from './types.ts';

const win = (o: Partial<MaintenanceWindow>): MaintenanceWindow => ({ id: 1, site_id: null, site_name: null, title: 't', starts_at: '', ends_at: '', repeat: 'none', active: false, current_end: null, next_start: null, ...o });

test('toLocalInput and localToIso agree', () => {
  const d = new Date(2026, 10, 10, 22, 5);
  assert.equal(toLocalInput(d), '2026-11-10T22:05');
  assert.equal(localToIso('2026-11-10T22:05'), d.toISOString());
});

test('localToIso refuses anything that is not a date and time', () => {
  for (const v of ['', 'tomorrow', '2026-11-10', '2026-13-40T10:00', '2026-11-10T10:00:00']) assert.equal(localToIso(v), null, v);
});

test('nextFullHour is in the future and on the hour', () => {
  const d = nextFullHour(new Date(2026, 10, 10, 22, 5, 30));
  assert.equal(toLocalInput(d), '2026-11-10T23:00');
  assert.equal(toLocalInput(nextFullHour(new Date(2026, 10, 10, 23, 0, 0))), '2026-11-11T00:00');
});

test('stateOf', () => {
  assert.equal(stateOf(win({ active: true })), 'active');
  assert.equal(stateOf(win({ next_start: '2026-11-11T00:00:00Z' })), 'upcoming');
  assert.equal(stateOf(win({})), 'over');
});
