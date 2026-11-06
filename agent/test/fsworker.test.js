'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const worker = path.join(__dirname, '..', 'src', 'fsworker.js');
const isWin = process.platform === 'win32';

function run(req, input) {
  const r = spawnSync(process.execPath, [worker, JSON.stringify(req)], { input, encoding: 'utf8' });
  return JSON.parse(r.stdout);
}

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-fs-'));
  const root = path.join(base, 'files');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'top secret');
  return { base, root };
}

test('list/read/write/mkdir/rename/delete inside root', () => {
  const { root } = sandbox();
  assert.ok(run({ op: 'list', root, rel: '' }).entries.some((e) => e.name === 'a.txt'));
  assert.equal(run({ op: 'read', root, rel: 'a.txt' }).content, 'hello');
  assert.ok(run({ op: 'write', root, rel: 'sub/b.txt' }, 'data').ok);
  assert.equal(fs.readFileSync(path.join(root, 'sub', 'b.txt'), 'utf8'), 'data');
  assert.ok(run({ op: 'mkdir', root, rel: 'newdir' }).ok);
  assert.ok(run({ op: 'rename', root, rel: 'sub/b.txt', to: 'newdir/c.txt' }).ok);
  assert.ok(run({ op: 'delete', root, rel: 'newdir' }).ok);
  assert.ok(!fs.existsSync(path.join(root, 'newdir')));
});

test('copy duplicates files and folders recursively and refuses unsafe targets', () => {
  const { root } = sandbox();
  fs.mkdirSync(path.join(root, 'd', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(root, 'd', 'inner', 'f.txt'), 'x');
  assert.ok(run({ op: 'copy', root, rel: 'd', to: 'd2' }).ok);
  assert.equal(fs.readFileSync(path.join(root, 'd2', 'inner', 'f.txt'), 'utf8'), 'x');
  assert.ok(fs.existsSync(path.join(root, 'd', 'inner', 'f.txt')), 'original must stay');
  assert.equal(run({ op: 'copy', root, rel: 'd', to: 'd2' }).ok, false, 'existing target');
  assert.equal(run({ op: 'copy', root, rel: 'd', to: 'd/inner/x' }).ok, false, 'into itself');
  assert.equal(run({ op: 'copy', root, rel: 'd', to: '../out' }).ok, false, 'outside root');
  assert.ok(run({ op: 'copy', root, rel: 'a.txt', to: 'b.txt' }).ok);
});

test('path traversal is refused', () => {
  const { root } = sandbox();
  for (const rel of ['../secret.txt', 'sub/../../secret.txt', '/etc/passwd', 'a\0b']) {
    assert.equal(run({ op: 'read', root, rel }).ok, false, rel);
  }
  assert.equal(run({ op: 'delete', root, rel: '' }).ok, false);
  assert.equal(run({ op: 'delete', root, rel: '.' }).ok, false);
});

test('symbolic links are refused', { skip: isWin && 'symlinks need elevated rights on Windows' }, () => {
  const { base, root } = sandbox();
  fs.symlinkSync(path.join(base, 'secret.txt'), path.join(root, 'link.txt'));
  fs.symlinkSync(base, path.join(root, 'linkdir'));
  assert.equal(run({ op: 'read', root, rel: 'link.txt' }).ok, false);
  assert.equal(run({ op: 'read', root, rel: 'linkdir/secret.txt' }).ok, false);
  assert.equal(run({ op: 'write', root, rel: 'link.txt' }, 'x').ok, false);
  assert.equal(fs.readFileSync(path.join(base, 'secret.txt'), 'utf8'), 'top secret');
});

// ---------------------------------------------------------------- ZIP archives
const { crc32 } = require('../src/zipwriter');
const hasUnzip = spawnSync('unzip', ['-v']).status === 0;

function zipSandbox() {
  const { base, root } = sandbox();
  fs.mkdirSync(path.join(root, 'site', 'img'), { recursive: true });
  fs.writeFileSync(path.join(root, 'site', 'index.html'), '<h1>hi</h1>\n'.repeat(2000));
  fs.writeFileSync(path.join(root, 'site', 'img', 'empty.bin'), '');
  fs.writeFileSync(path.join(root, 'site', 'ünï.txt'), 'umlauts');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'x'.repeat(100000));
  return { base, root };
}

test('crc32 matches the standard check value and can be continued', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('6789'), crc32(Buffer.from('12345'))), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('zip into the project: result, content and permissions; the archive is no part of itself', { skip: !hasUnzip && 'unzip is not installed' }, () => {
  const { root } = zipSandbox();
  const r = run({ op: 'zip', root, rel: '', names: ['site', 'notes.txt'], to: 'out.zip' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.count, 6); // site/, site/img/, index.html, empty.bin, ünï.txt, notes.txt
  assert.ok(fs.statSync(path.join(root, 'out.zip')).size === r.size);
  const t = spawnSync('unzip', ['-t', path.join(root, 'out.zip')], { encoding: 'utf8' });
  assert.equal(t.status, 0, t.stdout + t.stderr);
  const names = spawnSync('unzip', ['-Z1', path.join(root, 'out.zip')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
  assert.deepEqual(names, ['notes.txt', 'site/', 'site/img/', 'site/img/empty.bin', 'site/index.html', 'site/ünï.txt']);
  const back = spawnSync('unzip', ['-p', path.join(root, 'out.zip'), 'site/index.html']).stdout;
  assert.ok(back.equals(fs.readFileSync(path.join(root, 'site', 'index.html'))));
});

test('zip of a subfolder uses names relative to it', { skip: !hasUnzip && 'unzip is not installed' }, () => {
  const { root } = zipSandbox();
  const r = run({ op: 'zip', root, rel: 'site', names: ['img', 'index.html'], to: 'site/pack.zip' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const names = spawnSync('unzip', ['-Z1', path.join(root, 'site', 'pack.zip')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
  assert.deepEqual(names, ['img/', 'img/empty.bin', 'index.html']);
});

test('zip refuses an existing target, a wrong extension, bad names and paths outside the project', () => {
  const { root } = zipSandbox();
  assert.equal(run({ op: 'zip', root, rel: '', names: ['notes.txt'], to: 'notes.txt.zip' }).ok, true);
  assert.match(run({ op: 'zip', root, rel: '', names: ['notes.txt'], to: 'notes.txt.zip' }).error, /already exists/);
  assert.match(run({ op: 'zip', root, rel: '', names: ['notes.txt'], to: 'x.tar' }).error, /must end with \.zip/);
  for (const bad of ['../secret.txt', 'a/b', '..', '', '.']) assert.equal(run({ op: 'zip', root, rel: '', names: [bad], to: 'z.zip' }).ok, false, bad);
  assert.equal(run({ op: 'zip', root, rel: '../', names: ['files'], to: 'z.zip' }).ok, false);
  assert.equal(run({ op: 'zip', root, rel: '', names: [], to: 'z.zip' }).ok, false);
  assert.equal(run({ op: 'zip', root, rel: '', names: ['missing.txt'], to: 'z.zip' }).ok, false);
  assert.equal(fs.existsSync(path.join(root, 'z.zip')), false, 'no half-written archive is left');
});

test('zip leaves symbolic links out and counts them', { skip: (isWin && 'symlinks need elevated rights on Windows') || (!hasUnzip && 'unzip is not installed') }, () => {
  const { base, root } = zipSandbox();
  fs.symlinkSync(path.join(base, 'secret.txt'), path.join(root, 'site', 'link.txt'));
  const r = run({ op: 'zip', root, rel: '', names: ['site'], to: 'links.zip' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.skipped, 1);
  const names = spawnSync('unzip', ['-Z1', path.join(root, 'links.zip')], { encoding: 'utf8' }).stdout;
  assert.ok(!names.includes('link.txt'));
  // a selected link itself is refused
  assert.equal(run({ op: 'zip', root, rel: 'site', names: ['link.txt'], to: 'site/l.zip' }).ok, false);
});

test('zip without a target streams the archive to stdout', { skip: !hasUnzip && 'unzip is not installed' }, () => {
  const { root } = zipSandbox();
  const r = spawnSync(process.execPath, [worker, JSON.stringify({ op: 'zip', root, rel: '', names: ['site'] })], { maxBuffer: 50 * 1024 * 1024 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.subarray(0, 2).toString(), 'PK');
  const tmp = path.join(os.tmpdir(), `wm-stream-${process.pid}.zip`);
  fs.writeFileSync(tmp, r.stdout);
  const t2 = spawnSync('unzip', ['-t', tmp], { encoding: 'utf8' });
  fs.unlinkSync(tmp);
  assert.equal(t2.status, 0, t2.stdout + t2.stderr);
  // an error before the first byte is JSON, which the agent turns into an HTTP error
  const bad = spawnSync(process.execPath, [worker, JSON.stringify({ op: 'zip', root, rel: '', names: ['nope'] })], { encoding: 'utf8' });
  assert.equal(JSON.parse(bad.stdout).ok, false);
});
