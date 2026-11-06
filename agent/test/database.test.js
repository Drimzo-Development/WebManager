'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-db-'));
process.env.AGENT_TOKEN_DASHBOARD = 'a'.repeat(40);
process.env.AGENT_TOKEN_WORKER = 'b'.repeat(40);
process.env.TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

const { validateSpec } = require('../src/validate');
const database = require('../src/database');
const { loadRuntimes } = require('../src/config');

const doc = { runtimes: { static: { types: ['static'], kind: 'static', fixedPort: 8080 } }, databases: loadRuntimes().databases };
const base = { id: 7, type: 'static', runtime: 'static' };
const good = { engine: 'mariadb', name: 'app', user: 'app', password: 'A'.repeat(32), rootPassword: 'b'.repeat(32), memoryMb: 512 };

test('the allowlist offers pinned MariaDB and PostgreSQL images', () => {
  const dbs = loadRuntimes().databases;
  for (const [k, v] of Object.entries(dbs)) assert.match(v.image, /^[a-z]+:[0-9][0-9.]*(-alpine)?$/, `${k} must be pinned to a version`);
});

test('no database unless it is switched on', () => {
  assert.equal(validateSpec(base, doc).database, null);
  assert.equal(validateSpec({ ...base, database: null }, doc).database, null);
});

test('database credentials are validated before they reach docker', () => {
  assert.equal(validateSpec({ ...base, database: good }, doc).database.engine, 'mariadb');
  const pg = validateSpec({ ...base, database: { ...good, engine: 'postgres', rootPassword: undefined } }, doc).database;
  assert.equal(pg.engine, 'postgres');
  assert.equal(pg.rootPassword, '');
  for (const bad of [{ engine: 'mysql' }, { name: 'App' }, { name: 'a-b' }, { user: 'root; drop' }, { password: 'short' }, { password: 'a'.repeat(20) + '!$' }, { rootPassword: 'x' }, { memoryMb: 10 }]) {
    assert.throws(() => validateSpec({ ...base, database: { ...good, ...bad } }, doc), undefined, JSON.stringify(bad));
  }
});

test('the website receives connection settings for Laravel and a URL', () => {
  const env = database.envFor(good, 7);
  assert.equal(env.DB_CONNECTION, 'mysql');
  assert.equal(env.DB_HOST, 'wm-db-site-007');
  assert.equal(env.DB_PORT, '3306');
  assert.equal(env.DB_DATABASE, 'app');
  assert.equal(env.DATABASE_URL, `mysql://app:${'A'.repeat(32)}@wm-db-site-007:3306/app`);
  const pg = database.envFor({ ...good, engine: 'postgres' }, 7);
  assert.equal(pg.DB_CONNECTION, 'pgsql');
  assert.match(pg.DATABASE_URL, /^postgresql:\/\/app:/);
  assert.deepEqual(database.envFor(null, 7), {});
});

test('user variables still override the managed ones (spec.env is applied afterwards)', () => {
  const sites = require('../src/sites');
  const rt = { kind: 'php' };
  const env = sites.buildEnv({ id: 7, database: good, env: { DB_HOST: 'external.example.com' } }, rt);
  assert.equal(env.DB_HOST, 'external.example.com');
  assert.equal(env.DB_DATABASE, 'app');
});

test('the container is only recreated when engine, image, size or names change - not on password changes', () => {
  const def = { image: 'mariadb:11.4.13' };
  assert.equal(database.dbHash(good, def), database.dbHash({ ...good, password: 'C'.repeat(32) }, def));
  assert.notEqual(database.dbHash(good, def), database.dbHash({ ...good, memoryMb: 1024 }, def));
  assert.notEqual(database.dbHash(good, def), database.dbHash(good, { image: 'mariadb:11.4.14' }));
});

test('dumps are listed from the site directory and names are strictly validated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-dumps-'));
  fs.mkdirSync(path.join(dir, 'dumps'));
  fs.writeFileSync(path.join(dir, 'dumps', 'db-20261011-101500.sql.gz'), 'x');
  fs.writeFileSync(path.join(dir, 'dumps', 'db-20261012-101500.sql.gz'), 'xy');
  fs.writeFileSync(path.join(dir, 'dumps', 'notes.txt'), 'ignored');
  const list = database.listDumps(dir);
  assert.deepEqual(list.map((d) => d.name), ['db-20261012-101500.sql.gz', 'db-20261011-101500.sql.gz']);
  assert.equal(list[0].size, 2);
  assert.throws(() => database.dumpPath(dir, '../../etc/passwd'), /dump name/);
  assert.throws(() => database.dumpPath(dir, 'db-20261013-101500.sql.gz'), /not found/);
  assert.equal(database.deleteDump(dir, 'db-20261011-101500.sql.gz').ok, true);
  assert.equal(database.listDumps(dir).length, 1);
});

test('access from outside needs an allowlist and renders a deny-by-default forwarder', () => {
  const ok = validateSpec({ ...base, database: { ...good, external: { allow: ['192.168.178.20', '203.0.113.0/24'] } } }, doc).database;
  assert.deepEqual(ok.external.allow, ['192.168.178.20', '203.0.113.0/24']);
  assert.equal(validateSpec({ ...base, database: good }, doc).database.external, null);
  assert.throws(() => validateSpec({ ...base, database: { ...good, external: { allow: [] } } }, doc), /At least one/);
  assert.throws(() => validateSpec({ ...base, database: { ...good, external: { allow: ['1.2.3.4; allow all'] } } }, doc));
  const conf = database.renderForwarderConf(3306, ok.external.allow);
  assert.match(conf, /listen 3306;\s+allow 192\.168\.178\.20;\s+allow 203\.0\.113\.0\/24;\s+deny all;/);
  assert.match(conf, /set \$target db:3306;\s+proxy_pass \$target;/);
  assert.match(database.renderForwarderConf(5432, ['10.0.0.5']), /db:5432/);
  assert.equal(database.externalPort(4), 33004);
  assert.throws(() => database.externalPort(32001), /32000/);
});

test('the administration image is pinned and its container naming matches the proxy route', () => {
  const rt = loadRuntimes().dbadmin;
  assert.match(rt.image, /^adminer:\d+\.\d+\.\d+$/);
  assert.equal(database.adminName(4), 'wm-dbadmin-site-004');
  assert.match(database.adminName(12345), /^wm-dbadmin-site-12345$/);
});
