'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.DATA_DIR = path.join(require('os').tmpdir(), 'wm-data-test');
process.env.AGENT_TOKEN_DASHBOARD = 'a'.repeat(40);
process.env.AGENT_TOKEN_WORKER = 'b'.repeat(40);

const { parseProbe, probeSites } = require('../src/probe');

test('2xx, 3xx and 4xx answers mean the website is up', () => {
  assert.deepEqual(parseProbe(0, 'Connecting to wm-site-001:8080\n  HTTP/1.1 200 OK\n  Server: nginx\n'), { state: 'up', status: 200, error: null });
  assert.equal(parseProbe(1, '  HTTP/1.1 403 Forbidden\nwget: server returned error: HTTP/1.1 403 Forbidden').state, 'up');
  assert.equal(parseProbe(1, '  HTTP/1.1 404 Not Found').state, 'up');
});

test('the last answer counts after redirects', () => {
  assert.equal(parseProbe(0, '  HTTP/1.1 301 Moved\n  Location: /x\n  HTTP/1.1 200 OK\n').status, 200);
  assert.equal(parseProbe(1, '  HTTP/1.1 302 Found\n  HTTP/1.1 502 Bad Gateway\n').state, 'down');
});

test('5xx answers, refused connections and timeouts mean down', () => {
  assert.deepEqual(parseProbe(1, '  HTTP/1.0 500 Internal Server Error'), { state: 'down', status: 500, error: 'HTTP 500' });
  assert.equal(parseProbe(1, "wget: can't connect to remote host (10.210.1.2): Connection refused").error, 'Connection refused');
  assert.equal(parseProbe(1, 'wget: download timed out').error, 'Timeout');
  assert.equal(parseProbe(124, '').error, 'Timeout');
  assert.equal(parseProbe(1, "wget: bad address 'wm-site-009'").state, 'down');
});

test('output that cannot be understood is never reported as an outage', () => {
  assert.equal(parseProbe(1, 'BusyBox v1.36 multi-call binary.\nUsage: wget [-cqS] ...').state, 'unknown');
  assert.equal(parseProbe(1, '').state, 'unknown');
});

test('unknown website ids are skipped without error', async () => {
  const r = await probeSites([999999, 999999, -3, 'x']);
  assert.deepEqual(Object.keys(r), ['999999']);
  assert.equal(r[999999].state, 'unknown');
});
