'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.APP_KEY = 'a'.repeat(64);
const apps = require('../src/apps');

test('wp-config.php reads the database from the environment and has fresh keys', () => {
  const a = apps.wpConfig();
  const b = apps.wpConfig();
  for (const v of ['DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD', 'DB_HOST']) assert.match(a, new RegExp(`getenv\\('${v}'\\)`));
  assert.match(a, /require_once ABSPATH \. 'wp-settings\.php';/);
  assert.match(a, /HTTP_X_FORWARDED_PROTO/);
  for (const k of apps.WP_SALTS) {
    const m = new RegExp(`define\\('${k}', '([^']{64})'\\);`).exec(a);
    assert.ok(m, `${k} has a 64 character key`);
    assert.ok(!/[\\$']/.test(m[1]));
    assert.notEqual(m[1], new RegExp(`define\\('${k}', '([^']{64})'\\);`).exec(b)[1], 'keys differ per website');
  }
  assert.doesNotMatch(a, /password\s*=\s*'[^']/i, 'no password is written into the file');
});

test('salt: requested length, only safe characters', () => {
  for (let i = 0; i < 50; i++) assert.match(apps.salt(64), /^[A-Za-z0-9\-_!@#%^&*()+=]{64}$/);
});

test('download script verifies the checksum before unpacking and only talks to wordpress.org', () => {
  const s = apps.WP_DOWNLOAD;
  assert.ok(s.indexOf('sha1sum -c') > 0 && s.indexOf('sha1sum -c') < s.indexOf('tar -xzf'));
  assert.ok(s.startsWith('set -e'), 'a failing step stops the script');
  assert.ok(s.length <= 1000, 'the agent accepts commands of at most 1000 characters');
  assert.deepEqual([...new Set(s.match(/https?:\/\/[^/\s]+/g))], ['https://wordpress.org']);
});

test('only templates with a recipe can be installed, unknown ids are refused', async () => {
  assert.equal(apps.has('wordpress'), true);
  assert.equal(apps.has('nextcloud'), true);
  assert.equal(apps.has('ghost'), false);
  assert.equal(apps.has('__proto__'), false);
  await assert.rejects(() => apps.install({ log() {} }, { id: 1 }, 'ghost', { fail: (m) => new Error(m) }), /Unknown application template/);
});

test('the recipe downloads first, then writes wp-config.php; a failed download stops everything', async () => {
  const calls = [];
  const deps = {
    runExec: async (ctx, id, body) => { calls.push(['exec', body.kind]); return 0; },
    agent: { putRaw: async (p, c) => { calls.push(['write', p, c.startsWith('<?php')]); } },
    fail: (m) => new Error(m),
  };
  await apps.install({ log() {} }, { id: 7 }, 'wordpress', deps);
  assert.deepEqual(calls, [['exec', 'shell'], ['write', '/v1/sites/7/fs/write?path=wp-config.php', true]]);
  calls.length = 0;
  deps.runExec = async () => 8;
  await assert.rejects(() => apps.install({ log() {} }, { id: 7 }, 'wordpress', deps), /exit code 8/);
  assert.deepEqual(calls, [], 'no wp-config.php after a failed download');
});

test('every template of the catalog has a recipe and a complete description', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'apps.json'), 'utf8'));
  for (const [id, a] of Object.entries(doc.apps)) {
    assert.equal(apps.has(id), true, `${id} has a recipe`);
    for (const k of ['label', 'description', 'type', 'memory_mb']) assert.ok(a[k], `${id}.${k}`);
    assert.ok(['mariadb', 'postgres', undefined].includes(a.database), `${id}.database`);
  }
  const rt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'runtimes.json'), 'utf8')).runtimes;
  for (const a of Object.values(doc.apps)) assert.ok(a.runtimePreference.some((k) => rt[k] && rt[k].types.includes(a.type)), 'a suitable runtime exists');
});

test('GitHub recipes check the digest of the release before unpacking and only talk to github.com', () => {
  for (const [id, cfg] of Object.entries(apps.GITHUB)) {
    const s = apps.githubRelease(cfg);
    assert.ok(s.startsWith('set -e'), id);
    assert.ok(s.indexOf('sha256sum -c') > 0, `${id} verifies`);
    assert.ok(s.indexOf('sha256sum -c') < s.search(/tar -xzf|unzip/), `${id} verifies before unpacking`);
    assert.ok(s.includes(`https://github.com/${cfg.repo}/releases/download/*`), `${id} pins the download address`);
    assert.deepEqual([...new Set(s.match(/https?:\/\/[^/\s]+/g))].sort(), ['https://api.github.com', 'https://github.com']);
  }
});

test('recipe values with shell or quote characters are refused', () => {
  assert.throws(() => apps.githubRelease({ repo: "a/b'; rm -rf /", pattern: 'x', format: 'tar' }), /unsafe/);
  assert.throws(() => apps.githubRelease({ repo: 'a/b', pattern: 'x', format: 'tar', dest: '/app; id' }), /unsafe/);
});

test('Nextcloud: checksum from the vendor, database from the environment, no password in the files', () => {
  const s = apps.NEXTCLOUD_DOWNLOAD;
  assert.ok(s.indexOf('sha256sum -c') < s.indexOf('tar -xjf'));
  assert.deepEqual([...new Set(s.match(/https?:\/\/[^/\s]+/g))], ['https://download.nextcloud.com']);
  for (const f of [apps.NEXTCLOUD_AUTOCONFIG, apps.NEXTCLOUD_ENVCONFIG]) {
    assert.match(f, /getenv\('DB_PASSWORD'\)/);
    assert.doesNotMatch(f, /pass(word)?'\s*=>\s*'[^']/i);
  }
  assert.match(apps.NEXTCLOUD_AUTOCONFIG, /'directory' => '\/var\/www\/site\/data'/);
});

test('the install script is uploaded, run and removed; commands stay below the agent limit', async () => {
  assert.ok(apps.RUN_SCRIPT.length <= 1000);
  const calls = [];
  const deps = {
    runExec: async (ctx, id, body) => { calls.push(['exec', body.command]); return 0; },
    agent: { putRaw: async (p) => { calls.push(['write', p]); } },
    fail: (m) => new Error(m),
  };
  await apps.install({ log() {} }, { id: 3 }, 'nextcloud', deps);
  assert.deepEqual(calls.map((c) => c[0]), ['write', 'exec', 'write', 'write']);
  assert.match(calls[0][1], /path=\.wm-install\.sh$/);
  assert.match(calls[2][1], /nextcloud\/config\/autoconfig\.php$/);
  calls.length = 0;
  deps.runExec = async () => 5;
  await assert.rejects(() => apps.install({ log() {} }, { id: 3 }, 'joomla', deps), /exit code 5/);
});

test('the private directories of the applications are blocked in the web server rules', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'apps.json'), 'utf8'));
  const rules = (id) => (doc.apps[id].nginxRules || []).join('\n');
  assert.ok(rules('grav').includes('^/user/') && rules('grav').includes('yaml'));
  assert.match(rules('matomo'), /config\|tmp\|core\|lang/);
  assert.match(rules('nextcloud'), /config\|lib\|3rdparty/);
  assert.equal(doc.apps.nextcloud.docroot, 'nextcloud', 'the data directory lies outside the document root');
});

test('Uptime Kuma ships in its pinned image: no download, no file written', async () => {
  assert.equal(apps.has('uptime-kuma'), true);
  const calls = [];
  const deps = { runExec: async () => { calls.push('exec'); return 0; }, agent: { putRaw: async () => { calls.push('write'); } }, fail: (m) => new Error(m) };
  await apps.install({ log() {} }, { id: 4 }, 'uptime-kuma', deps);
  assert.deepEqual(calls, []);
});

test('templates that run from their own image: runtime pinned and hidden from the form, port, start command and environment complete', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'apps.json'), 'utf8')).apps;
  const rts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'runtimes.json'), 'utf8')).runtimes;
  const own = Object.entries(doc).filter(([, a]) => a.startCommand);
  assert.ok(own.some(([id]) => id === 'uptime-kuma'));
  for (const [id, a] of own) {
    assert.ok(a.internalPort >= 1024 && a.internalPort <= 65535, `${id} port`);
    for (const k of Object.keys(a.env || {})) assert.match(k, /^[A-Z][A-Z0-9_]{0,60}$/, `${id} env ${k}`);
    assert.equal(a.env.UPTIME_KUMA_PORT, String(a.internalPort), 'the application listens on the port the proxy expects');
    for (const r of a.runtimePreference) {
      assert.ok(rts[r], `${id} runtime ${r}`);
      assert.equal(rts[r].templateOnly, true, `${r} is only for the template`);
      assert.match(rts[r].image, /:[0-9][\w.-]*$/, `${r} is pinned to a version, not latest`);
      assert.ok(!/:latest$/.test(rts[r].image));
    }
  }
});
