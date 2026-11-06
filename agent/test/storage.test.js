'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-storage-'));
process.env.DATA_DIR = path.join(base, 'data');
process.env.AUDIT_LOG = path.join(base, 'log', 'agent-audit.log');
process.env.AGENT_TOKEN_DASHBOARD = 'a'.repeat(40);
process.env.AGENT_TOKEN_WORKER = 'b'.repeat(40);
process.env.WM_VERSION = '0.9.3';
for (const d of ['data/backups', 'data/database-backups', 'data/trash', 'data/sites', 'log']) fs.mkdirSync(path.join(base, d), { recursive: true });

const storage = require('../src/storage');
const NOW = Date.parse('2026-10-12T12:00:00Z');
storage._deps.now = () => NOW;

const age = (file, daysOld) => { const t = new Date(NOW - daysOld * 86400000); fs.utimesSync(file, t, t); };
const put = (rel, size, daysOld) => { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(size, 1)); age(f, daysOld); return f; };

// simulated docker: images, containers, system df; removed images are recorded
const removed = [];
const IMAGES = [
  'drimzo/agent:0.9.3', 'drimzo/webmanager:0.9.3', 'drimzo/agent:0.9.2', 'drimzo/webmanager:0.9.2',
  'drimzo/agent:0.9.1', 'drimzo/proxy:0.8.0', 'drimzo/proxy:0.9.4', 'drimzo/runtime-php:8.3', 'other/proxy:0.1.0', 'drimzo/agent:latest',
];
storage._deps.docker = async (args) => {
  const a = args.join(' ');
  if (a.startsWith('image ls --format')) return { code: 0, stdout: IMAGES.join('\n') + '\n', stderr: '' };
  if (a.startsWith('ps -a')) return { code: 0, stdout: 'drimzo/proxy:0.9.4\ndrimzo/agent:0.9.3\n', stderr: '' };
  if (a.startsWith('image inspect')) return { code: 0, stdout: '1000\n', stderr: '' };
  if (a.startsWith('image ls -f dangling')) return { code: 0, stdout: `sha256:${'a'.repeat(64)}\nsha256:${'b'.repeat(64)}\n`, stderr: '' };
  if (a.startsWith('system df')) return { code: 0, stdout: '{"Type":"Images","Size":"2GB"}\n{"Type":"Build Cache","Size":"1.5GB","Reclaimable":"1.2GB (80%)"}\n', stderr: '' };
  if (args[0] === 'rmi') { removed.push(args[1]); return { code: 0, stdout: '', stderr: '' }; }
  if (a.startsWith('builder prune')) { removed.push('builder-prune'); return { code: 0, stdout: '', stderr: '' }; }
  return { code: 0, stdout: '', stderr: '' };
};

test('sizes from Docker output', () => {
  assert.equal(storage.parseSize('1.5GB'), 1.5e9);
  assert.equal(storage.parseSize('512MB'), 512e6);
  assert.equal(storage.parseSize('12kB'), 12e3);
  assert.equal(storage.parseSize('0B'), 0);
  assert.equal(storage.parseSize('murks'), 0);
});

test('old images: running and previous version, images in use and foreign images stay', async () => {
  const p = await storage.plan();
  const images = p.categories.find((c) => c.id === 'images');
  assert.deepEqual(images.items.map((i) => i.name).sort(), ['drimzo/agent:0.9.1', 'drimzo/proxy:0.8.0']);
  assert.equal(images.cleanable, 2000);
});

test('program backups: the newest two stay', async () => {
  put('data/backups/app-tree-0.9.3-20261012-100000.tar.gz', 100, 0);
  put('data/backups/app-tree-0.9.2-20261005-100000.tar.gz', 200, 7);
  put('data/backups/app-tree-0.9.1-20260928-100000.tar.gz', 300, 14);
  put('data/backups/app-tree-0.9.0-20260920-100000.tar.gz', 400, 22);
  put('data/backups/webmanager-backup-20261012-033000-v0.9.3.tar.gz.gpg', 5000, 0);
  const p = await storage.plan();
  const c = p.categories.find((x) => x.id === 'appbackups');
  assert.deepEqual(c.items.map((i) => i.name), ['app-tree-0.9.1-20260928-100000.tar.gz', 'app-tree-0.9.0-20260920-100000.tar.gz']);
  assert.equal(c.cleanable, 700);
  assert.equal(p.info.localBackupCount, 1, 'full backups are only shown, never offered');
});

test('dumps: the newest three and everything younger than 14 days stay', async () => {
  put('data/database-backups/db-20261012-100000-v0.9.3.sql.gz', 10, 0);
  put('data/database-backups/db-20261010-100000.sql.gz', 20, 2);
  put('data/database-backups/db-20261008-100000.sql.gz', 30, 4);
  put('data/database-backups/db-20261001-100000.sql.gz', 40, 11);
  put('data/database-backups/db-20260920-100000.sql.gz', 50, 22);
  const c = (await storage.plan()).categories.find((x) => x.id === 'dumps');
  assert.deepEqual(c.items.map((i) => i.name), ['db-20260920-100000.sql.gz']);
});

test('logs: the newest five of each kind and everything younger than 30 days stay, the audit log never', async () => {
  for (let i = 0; i < 8; i++) put(`log/update-2026${String(9 - 0).padStart(2, '0')}${String(10 + i).padStart(2, '0')}-100000.log`, 10, 40 + i);
  put('log/agent-audit.log', 999, 90);
  put('log/backup-20260801-100000.log', 10, 70);
  const c = (await storage.plan()).categories.find((x) => x.id === 'logs');
  assert.equal(c.items.filter((i) => i.name.startsWith('update-')).length, 3);
  assert.equal(c.items.some((i) => i.name === 'agent-audit.log'), false);
  assert.equal(c.items.some((i) => i.name === 'backup-20260801-100000.log'), false, 'the only log of its kind stays');
});

test('trash: only websites deleted more than 30 days ago', async () => {
  put('data/trash/site-007-2026-08-01T10-00-00-000Z/index.html', 100, 0);
  put('data/trash/site-008-2026-10-05T10-00-00-000Z/index.html', 100, 0);
  put('data/trash/foreign/file', 100, 100);
  const c = (await storage.plan()).categories.find((x) => x.id === 'trash');
  assert.deepEqual(c.items.map((i) => i.name), ['site-007-2026-08-01T10-00-00-000Z']);
  assert.equal(c.risk, 'Permanent');
});

test('build cache is read from docker system df', async () => {
  const c = (await storage.plan()).categories.find((x) => x.id === 'buildcache');
  assert.equal(c.cleanable, 1.2e9);
  assert.equal(c.bytes, 1.5e9);
});

test('cleaning up: only known categories, candidates are recalculated, nothing else disappears', async () => {
  await assert.rejects(() => storage.cleanup(['../etc']), /Unknown category/);
  await assert.rejects(() => storage.cleanup([]), /Unknown category/);
  const r = await storage.cleanup(['images', 'appbackups', 'dumps', 'logs', 'trash', 'buildcache', 'dangling']);
  assert.deepEqual(removed.filter((x) => x.startsWith('drimzo')).sort(), ['drimzo/agent:0.9.1', 'drimzo/proxy:0.8.0']);
  assert.ok(removed.includes('builder-prune'));
  assert.equal(r.errors.length, 0);
  assert.equal(fs.existsSync(path.join(base, 'data/backups/app-tree-0.9.3-20261012-100000.tar.gz')), true);
  assert.equal(fs.existsSync(path.join(base, 'data/backups/app-tree-0.9.2-20261005-100000.tar.gz')), true);
  assert.equal(fs.existsSync(path.join(base, 'data/backups/app-tree-0.9.1-20260928-100000.tar.gz')), false);
  assert.equal(fs.existsSync(path.join(base, 'data/backups/webmanager-backup-20261012-033000-v0.9.3.tar.gz.gpg')), true, 'full backups stay');
  assert.equal(fs.existsSync(path.join(base, 'data/database-backups/db-20261012-100000-v0.9.3.sql.gz')), true);
  assert.equal(fs.existsSync(path.join(base, 'data/database-backups/db-20260920-100000.sql.gz')), false);
  assert.equal(fs.existsSync(path.join(base, 'log/agent-audit.log')), true);
  assert.equal(fs.existsSync(path.join(base, 'data/trash/site-007-2026-08-01T10-00-00-000Z')), false);
  assert.equal(fs.existsSync(path.join(base, 'data/trash/site-008-2026-10-05T10-00-00-000Z')), true, 'young trash entries stay');
  assert.equal(fs.existsSync(path.join(base, 'data/trash/foreign/file')), true, 'foreign files are never touched');
  assert.ok(r.freed > 700);
  assert.deepEqual((await storage.plan()).categories.find((c) => c.id === 'appbackups').items, []);
});
