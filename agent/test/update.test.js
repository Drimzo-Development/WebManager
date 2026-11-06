'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-update-'));
process.env.DATA_DIR = path.join(base, 'data');
process.env.AUDIT_LOG = path.join(base, 'log', 'agent-audit.log');
process.env.AGENT_TOKEN_DASHBOARD = 'a'.repeat(40);
process.env.AGENT_TOKEN_WORKER = 'b'.repeat(40);
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.mkdirSync(path.dirname(process.env.AUDIT_LOG), { recursive: true });

const update = require('../src/update');
const dir = path.join(process.env.DATA_DIR, 'update');

test('without helper: not installed, request is rejected', () => {
  assert.equal(update.status().helperInstalled, false);
  assert.throws(() => update.request({ action: 'check' }), /not set up/);
});

test('releases are filtered and truncated', () => {
  const list = update.releases([
    { tag_name: 'v0.6.0', name: '0.6.0', body: 'x'.repeat(20000), html_url: 'https://git.example/r/0.6.0' },
    { tag_name: '0.5.9', draft: true },
    { tag_name: '0.5.8', prerelease: true },
    { tag_name: 'nightly' },
    { tag_name: '0.5.3', body: 'Note', html_url: 'javascript:alert(1)' },
  ]);
  assert.deepEqual(list.map((r) => r.version), ['0.6.0', '0.5.3']);
  assert.equal(list[0].notes.length, 8000);
  assert.equal(list[1].url, '');
});

test('request is validated and written atomically', () => {
  fs.mkdirSync(dir);
  assert.throws(() => update.request({ action: 'update', version: '1.0; rm -rf /' }), /version number/);
  assert.throws(() => update.request({ action: 'format' }), /action/);
  update.request({ action: 'update', version: '0.6.0' });
  assert.equal(fs.readFileSync(path.join(dir, 'request'), 'utf8'), 'update 0.6.0\n');
  assert.equal(update.status().requestPending, true);
  assert.throws(() => update.request({ action: 'check' }), /already pending/);
  assert.deepEqual(fs.readdirSync(dir), ['request']);
});

test('status reads helper files and the log only with a valid name', () => {
  fs.rmSync(path.join(dir, 'request'));
  fs.writeFileSync(path.join(dir, 'meta.json'), '{"apply":true,"checkedAt":"2026-10-12T10:00:00Z"}');
  fs.writeFileSync(path.join(dir, 'latest.json'), '[{"tag_name":"0.6.0","body":"New"}]');
  fs.writeFileSync(path.join(dir, 'state.json'), '{"state":"running","version":"0.6.0","at":"t","log":"update-request-20261012-100000.log"}');
  fs.writeFileSync(path.join(path.dirname(process.env.AUDIT_LOG), 'update-request-20261012-100000.log'), '\x1b[32mDone\x1b[0m\n');
  const s = update.status();
  assert.equal(s.canApply, true);
  assert.equal(s.releases[0].version, '0.6.0');
  assert.equal(s.state.state, 'running');
  assert.equal(s.logTail, 'Done\n');
  fs.writeFileSync(path.join(dir, 'state.json'), '{"state":"ok","log":"../../etc/passwd"}');
  assert.equal(update.status().logTail, '');
});

test('auto update: setting is validated, saved atomically and lifts a pause', () => {
  assert.deepEqual(update.status().auto, { mode: 'off', from: 2, to: 5 });
  for (const bad of [{ mode: 'major', from: 2, to: 5 }, { mode: 'patch', from: 24, to: 5 }, { mode: 'patch', from: 2, to: -1 }, { mode: 'patch', from: 'a', to: 5 }, { mode: 'patch', from: 2.5, to: 5 }]) {
    assert.throws(() => update.setAuto(bad), /mode|hours/);
  }
  fs.writeFileSync(path.join(dir, 'auto-state.json'), '{"version":"0.6.1","state":"failed","at":"t"}');
  assert.equal(update.status().autoState.state, 'failed');
  update.setAuto({ mode: 'patch', from: 1, to: 4 });
  assert.deepEqual(update.status().auto, { mode: 'patch', from: 1, to: 4 });
  assert.equal(update.status().autoState, null, 'a new setting lifts the pause after a failure');
  assert.equal(fs.existsSync(path.join(dir, 'auto.json.tmp')), false);
  assert.equal(typeof update.status().version, 'string');
});

test('support: installed version against the minimum of the update server', () => {
  const cfg = require('../src/config').config;
  const before = cfg.version;
  try {
    cfg.version = '0.2.1';
    assert.deepEqual(update.supportInfo({}), { minSupported: '', supported: true }, 'no minimum: everything is supported');
    assert.deepEqual(update.supportInfo({ minSupported: '0.2.1' }), { minSupported: '0.2.1', supported: true }, 'equal is still supported');
    assert.deepEqual(update.supportInfo({ minSupported: '0.2.2' }), { minSupported: '0.2.2', supported: false });
    assert.equal(update.supportInfo({ minSupported: '0.10.0' }).supported, false, 'numeric, not alphabetic comparison');
    cfg.version = '0.10.0';
    assert.equal(update.supportInfo({ minSupported: '0.9.9' }).supported, true);
    cfg.version = '0.3.0-test';
    assert.equal(update.supportInfo({ minSupported: '0.3.0' }).supported, true, 'a pre-release suffix is ignored');
    for (const bad of ['x', '1.2', '1.2.3; rm -rf', 5, null]) assert.deepEqual(update.supportInfo({ minSupported: bad }), { minSupported: '', supported: true }, 'invalid values are ignored');
    cfg.version = '0.2.1';
    fs.writeFileSync(path.join(dir, 'meta.json'), '{"apply":true,"checkedAt":"t","minSupported":"0.2.2"}');
    const s = update.status();
    assert.equal(s.supported, false);
    assert.equal(s.minSupported, '0.2.2');
  } finally { cfg.version = before; }
});

test('roll back: the matching backup is chosen as in scripts/rollback.sh', () => {
  process.env.WM_VERSION = process.env.WM_VERSION || '';
  const cfg = require('../src/config').config;
  cfg.version = '0.11.0';
  const backups = path.join(process.env.DATA_DIR, 'backups');
  const dumps = path.join(process.env.DATA_DIR, 'database-backups');
  fs.mkdirSync(backups, { recursive: true }); fs.mkdirSync(dumps, { recursive: true });
  assert.equal(update.status().rollback.available, false, 'nothing to offer without a backup');
  fs.writeFileSync(path.join(backups, 'app-tree-0.10.0-20261012-100000.tar.gz'), 'x');
  assert.equal(update.status().rollback.available, false, 'not possible without a dump');
  assert.match(update.status().rollback.reason, /database dump/);
  fs.writeFileSync(path.join(dumps, 'db-20261012-110000-v0.10.0.sql.gz'), 'x');   // after the update: not the right one
  fs.writeFileSync(path.join(dumps, 'db-20261001-100000-v0.10.0.sql.gz'), 'x');   // too old, but the only candidate before the update
  fs.writeFileSync(path.join(dumps, 'db-20261012-095950-v0.10.0.sql.gz'), 'x');
  fs.writeFileSync(path.join(dumps, 'db-20261012-095955-v0.9.0.sql.gz'), 'x');
  const r = update.status().rollback;
  assert.equal(r.available, true);
  assert.equal(r.version, '0.10.0');
  cfg.version = '0.10.0';
  assert.equal(update.status().rollback.available, false, 'same version: nothing to roll back');
  cfg.version = '0.11.0';
  assert.deepEqual(update.request({ action: 'rollback' }), { requested: 'rollback' });
  assert.equal(fs.readFileSync(path.join(dir, 'request'), 'utf8'), 'rollback\n');
  fs.rmSync(path.join(dir, 'request'));
  fs.rmSync(path.join(backups, 'app-tree-0.10.0-20261012-100000.tar.gz'));
  assert.throws(() => update.request({ action: 'rollback' }), /not possible/);
});

test('notes and dates come from releases.json of the update server', () => {
  const list = [{ version: '0.6.1', name: '', notes: '', url: '', publishedAt: '' }, { version: '0.6.0', name: '', notes: 'kept', url: '', publishedAt: '' }, { version: '0.5.9', name: '', notes: '', url: '', publishedAt: '' }];
  const raw = { releases: [
    { version: '0.6.1', notes: ' Fixed things. ', published: '2026-11-05T18:58:47Z' },
    { version: '0.6.0', notes: 'ignored', published: 'x' },
    { version: 'not-a-version', notes: 'bad' },
    { version: '0.5.8', notes: 'other', published: 'y' },
  ] };
  const out = update.withNotes(list, raw);
  assert.equal(out[0].notes, 'Fixed things.');
  assert.equal(out[0].publishedAt, '2026-11-05T18:58:47Z');
  assert.equal(out[1].notes, 'kept', 'notes of the list are not replaced');
  assert.equal(out[2].notes, '', 'a version the server does not know stays without notes');
  assert.equal(update.withNotes(list, null)[0].notes, '', 'an unreadable file changes nothing');
  assert.equal(update.withNotes(list, { releases: 'x' })[0].notes, '');
  assert.equal(update.withNotes([{ version: '0.6.1', notes: '', publishedAt: '' }], { releases: [{ version: '0.6.1', notes: 'x'.repeat(20000) }] })[0].notes.length, 8000);
});

test('status shows the notes of the update server for the version the helper found', () => {
  fs.writeFileSync(path.join(dir, 'latest.json'), '[{"tag_name":"0.6.2"}]');
  fs.writeFileSync(path.join(dir, 'releases.json'), '{"releases":[{"version":"0.6.2","notes":"Maintenance release.","published":"2026-11-05T18:58:47Z"}]}');
  const r = update.status().releases[0];
  assert.equal(r.version, '0.6.2');
  assert.equal(r.notes, 'Maintenance release.');
  fs.writeFileSync(path.join(dir, 'releases.json'), 'not json');
  assert.equal(update.status().releases[0].notes, '');
});
