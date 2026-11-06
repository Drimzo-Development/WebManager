import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobSeconds, jobStatus } from './jobUtil.ts';

test('jobStatus: known and unknown statuses', () => {
  assert.deepEqual(jobStatus('succeeded'), { label: 'done', tone: 'ok' });
  assert.deepEqual(jobStatus('failed'), { label: 'failed', tone: 'err' });
  assert.deepEqual(jobStatus('running'), { label: 'running', tone: 'warn' });
  assert.deepEqual(jobStatus('odd'), { label: 'odd', tone: '' });
});

test('jobSeconds: duration from server times, null while unfinished', () => {
  assert.equal(jobSeconds({ started_at: '2026-10-23 12:00:00', finished_at: '2026-10-23 12:01:30' }), 90);
  assert.equal(jobSeconds({ started_at: '2026-10-23 12:00:00', finished_at: null }), null);
  assert.equal(jobSeconds({ started_at: null, finished_at: '2026-10-23 12:00:00' }), null);
  assert.equal(jobSeconds({ started_at: 'broken', finished_at: '2026-10-23 12:00:00' }), null);
  assert.equal(jobSeconds({ started_at: '2026-10-23 12:05:00', finished_at: '2026-10-23 12:00:00' }), 0);
});
