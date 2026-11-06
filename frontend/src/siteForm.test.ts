import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveName, COMMAND_DEFAULTS, defaultRuntime, fieldsFor, fieldSummary, selectableRuntimes, siteBody, withoutErrors, type SiteInfo } from './siteForm.ts';

const site: SiteInfo = {
  id: 3, slug: 'site-003', name: 'Shop', description: 'Test', type: 'php', runtime: 'php-8.5', docroot: 'public', memory_mb: 512, cpus: 1, pids: 256,
  internal_port: 8080, start_command: '', install_command: '', build_command: '', git_url: '', git_branch: '', git_username: '', has_git_token: true,
  autostart: true, gate_enabled: false, maintenance_enabled: false, lifecycle: 'ready',
};

test('siteBody: complete, patch wins, no token without input', () => {
  const b = siteBody(site, { git_url: 'https://example.com/a.git', memory_mb: 1024 });
  assert.equal(b.name, 'Shop');
  assert.equal(b.type, 'php');
  assert.equal(b.git_url, 'https://example.com/a.git');
  assert.equal(b.memory_mb, 1024);
  assert.ok(!('git_token' in b), 'the stored token stays untouched');
  assert.ok(!('id' in b) && !('slug' in b) && !('lifecycle' in b), 'no fields the server does not set');
  assert.equal(Object.keys(siteBody(site)).length, 16);
});

test('fieldsFor: per type', () => {
  assert.deepEqual(fieldsFor('static'), { port: false, docroot: true, git: false, install: false, build: false, start: false });
  assert.deepEqual(fieldsFor('laravel'), { port: false, docroot: true, git: true, install: true, build: true, start: false });
  assert.deepEqual(fieldsFor('node'), { port: true, docroot: false, git: true, install: true, build: true, start: true });
  assert.deepEqual(fieldsFor('custom'), fieldsFor('next'));
});

test('defaults exist for every type', () => {
  for (const t of ['static', 'php', 'laravel', 'node', 'express', 'next', 'custom']) assert.equal(COMMAND_DEFAULTS[t]?.length, 3, t);
  assert.equal(COMMAND_DEFAULTS.next![1], 'npm run build');
});

test('archiveName: only .zip, .tar.gz, .tgz, safe name', () => {
  assert.equal(archiveName('Projekt.ZIP', 5), '.wm-upload-5.zip');
  assert.equal(archiveName('a.tar.gz', 5), '.wm-upload-5.tar.gz');
  assert.equal(archiveName('a.tgz', 5), '.wm-upload-5.tar.gz');
  for (const bad of ['a.rar', 'a.zip.exe', 'zip', '../../x.sh', 'a.tar']) assert.equal(archiveName(bad), null, bad);
  // the original name never ends up in the path
  assert.ok(!archiveName('evil; rm -rf.zip', 5)!.includes('rm'));
});

test('fieldSummary', () => {
  assert.equal(fieldSummary({ name: 'A.', cpus: 'B.' }), 'A. B.');
  assert.equal(fieldSummary({}), '');
});

test('defaultRuntime: the newest matching template', () => {
  const rts = [
    { key: 'static', label: 'S', types: ['static'], fixedPort: null, npm: false },
    { key: 'php-8.3', label: 'P3', types: ['php', 'laravel'], fixedPort: 8080, npm: true },
    { key: 'php-8.5', label: 'P5', types: ['php', 'laravel'], fixedPort: 8080, npm: true },
    { key: 'node-22', label: 'N', types: ['node'], fixedPort: null, npm: true },
  ];
  assert.equal(defaultRuntime(rts, 'php'), 'php-8.5');
  assert.equal(defaultRuntime(rts, 'laravel'), 'php-8.5');
  assert.equal(defaultRuntime(rts, 'static'), 'static');
  assert.equal(defaultRuntime(rts, 'express'), '');
  assert.equal(defaultRuntime([], 'php'), '');
});

test('withoutErrors removes only the edited fields', () => {
  assert.deepEqual(withoutErrors({ name: 'a', cpus: 'b' }, ['name']), { cpus: 'b' });
  assert.deepEqual(withoutErrors({ name: 'a' }, ['x']), { name: 'a' });
  assert.deepEqual(withoutErrors({}, ['name']), {});
});

test('runtimes that only an application template uses are not offered, except the one the website already has', () => {
  const rts = [
    { key: 'node-22', label: 'Node 22', types: ['node', 'custom'], fixedPort: null, npm: true },
    { key: 'python', label: 'Python', types: ['custom'], fixedPort: null, npm: false },
    { key: 'uptime-kuma', label: 'Uptime Kuma', types: ['custom'], fixedPort: null, npm: false, templateOnly: true },
  ];
  assert.deepEqual(selectableRuntimes(rts, 'custom').map((r) => r.key), ['node-22', 'python']);
  assert.deepEqual(selectableRuntimes(rts, 'custom', 'uptime-kuma').map((r) => r.key), ['node-22', 'python', 'uptime-kuma'], 'a website made from the template keeps its runtime in the list');
  assert.deepEqual(selectableRuntimes(rts, 'custom', 'python').map((r) => r.key), ['node-22', 'python']);
  assert.deepEqual(selectableRuntimes(rts, 'node').map((r) => r.key), ['node-22']);
  assert.equal(defaultRuntime(rts, 'custom'), 'python', 'the newest offered one, never the template-only runtime');
});
