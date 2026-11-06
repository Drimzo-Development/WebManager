'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-backupctl-'));
process.env.DATA_DIR = path.join(base, 'data');
process.env.AUDIT_LOG = path.join(base, 'log', 'agent-audit.log');
process.env.AGENT_TOKEN_DASHBOARD = 'a'.repeat(40);
process.env.AGENT_TOKEN_WORKER = 'b'.repeat(40);
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.mkdirSync(path.dirname(process.env.AUDIT_LOG), { recursive: true });

const backupctl = require('../src/backupctl');
const dir = path.join(process.env.DATA_DIR, 'backup-ctl');

test('without helper: not installed, request is rejected', () => {
  assert.equal(backupctl.status().helperInstalled, false);
  assert.throws(() => backupctl.request({ action: 'backup' }), /not set up/);
});

test('requests: only known actions, atomic, not twice', () => {
  fs.mkdirSync(dir);
  for (const bad of ['', 'rm -rf /', 'backup; reboot', 'format']) assert.throws(() => backupctl.request({ action: bad }), /Unknown action/);
  backupctl.request({ action: 'verify-remote' });
  assert.equal(fs.readFileSync(path.join(dir, 'request'), 'utf8'), 'verify-remote\n');
  assert.throws(() => backupctl.request({ action: 'backup' }), /already pending/);
  assert.deepEqual(fs.readdirSync(dir), ['request']);
});

test('status summarises helper files and truncates/filters foreign values', () => {
  fs.rmSync(path.join(dir, 'request'));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ apply: true, configured: true, remote: 'hetzner:bk', encrypted: true, keep: { daily: 7, weekly: 4, monthly: 6 } }));
  fs.writeFileSync(path.join(dir, 'upload.json'), JSON.stringify({ ok: true, at: '2026-10-12T03:40:00Z', file: 'webmanager-backup-20261012-033000-v0.7.0.tar.gz.gpg', size: 1234, error: '' }));
  fs.writeFileSync(path.join(dir, 'verify.json'), JSON.stringify({ ok: false, at: '2026-10-12T05:00:00Z', scope: 'remote', detail: 'x'.repeat(1000), seconds: 12, extra: 'ignoriert' }));
  fs.writeFileSync(path.join(dir, 'remote.json'), '{"count":3,"bytes":4096,"at":"t"}');
  fs.writeFileSync(path.join(dir, 'state.json'), '{"state":"running","action":"backup","at":"t","log":"backup-request-20261012-100000.log"}');
  fs.writeFileSync(path.join(path.dirname(process.env.AUDIT_LOG), 'backup-request-20261012-100000.log'), '\x1b[32mLaeuft\x1b[0m\n');
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'backup-status.json'), '{"ok":true,"at":"2026-10-12T03:30:00Z","version":"0.7.0","kind":"full"}');
  fs.mkdirSync(path.join(process.env.DATA_DIR, 'backups'));
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'backups', 'webmanager-backup-20261012-033000-v0.7.0.tar.gz.gpg'), 'x');
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'backups', '../secret.tar.gz'), 'x');
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'backups', 'fremd.txt'), 'x');
  const s = backupctl.status();
  assert.equal(s.canApply, true);
  assert.equal(s.remote, 'hetzner:bk');
  assert.deepEqual(s.keep, { daily: 7, weekly: 4, monthly: 6 });
  assert.equal(s.remoteInfo.count, 3);
  assert.equal(s.lastUpload.ok, true);
  assert.equal(s.lastVerify.ok, false);
  assert.equal(s.lastVerify.detail.length, 300);
  assert.equal('extra' in s.lastVerify, false);
  assert.equal(s.state.state, 'running');
  assert.equal(s.logTail, 'Laeuft\n');
  assert.deepEqual(s.localFiles.map((f) => f.name), ['webmanager-backup-20261012-033000-v0.7.0.tar.gz.gpg']);
  assert.equal(s.localFiles[0].encrypted, true);
  assert.deepEqual(backupctl.summary(), { configured: true, upload: { ok: true, at: '2026-10-12T03:40:00Z' }, verify: { ok: false, at: '2026-10-12T05:00:00Z' } });
});

test('log name outside the pattern is never read', () => {
  fs.writeFileSync(path.join(dir, 'state.json'), '{"state":"ok","action":"backup","log":"../../etc/passwd"}');
  assert.equal(backupctl.status().logTail, '');
});
