import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCurrent, navFor } from './nav.ts';

const labels = (role: Parameters<typeof navFor>[0]) => navFor(role).flatMap((g) => g.items.map((i) => i.label));

test('admin sees the administration, viewer does not', () => {
  assert.ok(labels('admin').includes('Users'));
  assert.ok(labels('admin').includes('Audit log'));
  assert.ok(!labels('viewer').includes('Users'));
  assert.ok(!labels('operator').includes('System'));
});

test('viewer, operator and admin see API tokens', () => {
  for (const r of ['viewer', 'operator', 'admin'] as const) assert.ok(labels(r).includes('API-Tokens'), r);
});

test('maintenance windows are for operators and administrators', () => {
  assert.ok(!labels('viewer').includes('Maintenance'));
  for (const r of ['operator', 'admin'] as const) assert.ok(labels(r).includes('Maintenance'), r);
});

test('empty groups disappear', () => {
  assert.ok(!navFor('viewer').some((g) => g.label === 'Administration'));
});

test('isCurrent: sub pages mark their entry', () => {
  assert.ok(isCurrent('/', '/'));
  assert.ok(isCurrent('/', '/sites/3/ops/logs'));
  assert.ok(isCurrent('/', '/sites/new'));
  assert.ok(!isCurrent('/', '/jobs'));
  assert.ok(isCurrent('/jobs', '/jobs') && isCurrent('/jobs', '/jobs/7'));
  assert.ok(isCurrent('/system', '/system/backup'));
  assert.ok(!isCurrent('/users', '/usersX') && !isCurrent('/jobs', '/jobsmith'));
});
