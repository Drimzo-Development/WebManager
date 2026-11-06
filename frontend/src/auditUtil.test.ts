import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDetails } from './auditUtil.ts';

test('formatDetails: object, nested, empty, not JSON', () => {
  assert.equal(formatDetails('{"role":"admin","active":true}'), 'role: admin, active: true');
  assert.equal(formatDetails('{"sites":{"1":"edit"}}'), 'sites: {"1":"edit"}');
  assert.equal(formatDetails('{}'), '');
  assert.equal(formatDetails('not json'), 'not json');
  assert.equal(formatDetails('[1,2]'), '[1,2]');
});
