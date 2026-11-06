'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateSpec, validateExec, containerHash, parseSiteId, ValidationError } = require('../src/validate');

const runtimes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'runtimes.json'), 'utf8'));
const base = { id: 1, type: 'node', runtime: 'node-22', internalPort: 3000, domains: ['App1.Example.com'] };

test('valid node spec is normalised', () => {
  const s = validateSpec(base, runtimes);
  assert.equal(s.internalPort, 3000);
  assert.deepEqual(s.domains, ['app1.example.com']);
  assert.equal(s.memoryMb, 512);
});

test('two sites may use the same internal port', () => {
  const a = validateSpec({ ...base, id: 1 }, runtimes);
  const b = validateSpec({ ...base, id: 2 }, runtimes);
  assert.equal(a.internalPort, b.internalPort);
  assert.notEqual(containerHash(a, runtimes), containerHash(b, runtimes));
});

test('runtime outside the allowlist is rejected', () => {
  assert.throws(() => validateSpec({ ...base, runtime: 'evil/image:latest' }, runtimes), ValidationError);
  assert.throws(() => validateSpec({ ...base, runtime: '__proto__' }, runtimes), ValidationError);
  assert.throws(() => validateSpec({ ...base, runtime: 'php-8.3' }, runtimes), ValidationError, 'type/runtime mismatch');
});

test('php and static ignore the requested port', () => {
  assert.equal(validateSpec({ id: 3, type: 'php', runtime: 'php-8.3', internalPort: 9999 }, runtimes).internalPort, 8080);
  assert.equal(validateSpec({ id: 4, type: 'static', runtime: 'static' }, runtimes).internalPort, 8080);
});

test('invalid inputs are rejected', () => {
  const bad = [
    { id: 0 }, { id: 99999 }, { internalPort: 80 }, { internalPort: 70000 }, { memoryMb: 1 }, { memoryMb: 999999 },
    { cpus: 0 }, { cpus: 'x' }, { domains: ['not a domain'] }, { domains: ['*.*.example.com'] }, { domains: ['*example.com'] }, { domains: ['*.'] }, { domains: ['a;b.example.com'] },
    { docroot: '../etc' }, { docroot: '/abs' }, { env: { 'A B': '1' } }, { env: { LD_PRELOAD: '/x' } }, { env: { PORT: '1' } },
    { env: { A: 'multi\nline' } }, { env: [] }, { startCommand: 'x'.repeat(1001) },
  ];
  for (const b of bad) assert.throws(() => validateSpec({ ...base, ...b }, runtimes), ValidationError, JSON.stringify(b));
});

test('exec validation restricts commands', () => {
  assert.deepEqual(validateExec({ kind: 'npm', sub: 'ci', jobId: 5 }).argv.slice(0, 2), ['npm', 'ci']);
  assert.deepEqual(validateExec({ kind: 'npm', sub: 'run', script: 'build', jobId: 5 }).argv, ['npm', 'run', 'build']);
  assert.throws(() => validateExec({ kind: 'npm', sub: 'run', script: 'build; rm -rf /', jobId: 5 }), ValidationError);
  assert.throws(() => validateExec({ kind: 'npm', sub: 'exec', jobId: 5 }), ValidationError);
  assert.throws(() => validateExec({ kind: 'docker', jobId: 5 }), ValidationError);
  assert.throws(() => validateExec({ kind: 'gitsync', url: 'file:///etc', jobId: 5 }), ValidationError);
  assert.throws(() => validateExec({ kind: 'gitsync', url: 'https://x.test/r.git', branch: '--upload-pack=x', jobId: 5 }), ValidationError);
  const g = validateExec({ kind: 'gitsync', url: 'https://example.com/a/b.git', branch: 'main', username: 'bob', token: 'tok123', jobId: 5 });
  assert.equal(g.env.GIT_URL, 'https://example.com/a/b.git');
  assert.equal(Buffer.from(g.env.GIT_AUTH, 'base64').toString(), 'bob:tok123');
  assert.ok(!g.argv.join(' ').includes('tok123') && !g.label.includes('tok123'), 'token must not appear in argv/label');
  assert.throws(() => validateExec({ kind: 'gitsync', url: 'https://x.test/r.git', token: 'a b', jobId: 5 }), ValidationError);
  assert.equal(validateExec({ kind: 'extract', archive: 'site.zip', jobId: 5 }).env.ARCH, 'site.zip');
  assert.throws(() => validateExec({ kind: 'extract', archive: '../x.zip', jobId: 5 }), ValidationError);
  assert.throws(() => validateExec({ kind: 'extract', archive: 'a;rm.zip', jobId: 5 }), ValidationError);
});

test('laravel runs on the php runtime', () => {
  const s = validateSpec({ id: 9, type: 'laravel', runtime: 'php-8.3', docroot: 'public' }, runtimes);
  assert.equal(s.internalPort, 8080);
  assert.equal(s.docroot, 'public');
  assert.throws(() => validateSpec({ id: 9, type: 'laravel', runtime: 'node-22' }, runtimes), ValidationError);
});

test('site ids', () => {
  assert.equal(parseSiteId('site-007'), 7);
  assert.equal(parseSiteId('12'), 12);
  assert.throws(() => parseSiteId('../x'), ValidationError);
});

test('access control fields are validated', () => {
  const { validateSpec } = require('../src/validate');
  const rt = { runtimes: { static: { types: ['static'], kind: 'static', fixedPort: 8080 } } };
  const base = { id: 1, type: 'static', runtime: 'static' };
  const ok = validateSpec({ ...base, gate: true, gateBypass: ['/api/', '/health'], maintenance: true, maintenanceAllow: ['203.0.113.7', '2001:db8::1'] }, rt);
  assert.deepEqual(ok.gateBypass, ['/api/', '/health']);
  assert.equal(ok.maintenance, true);
  assert.throws(() => validateSpec({ ...base, gateBypass: ['/a b'] }, rt));
  assert.throws(() => validateSpec({ ...base, gateBypass: ['/../etc'] }, rt));
  assert.throws(() => validateSpec({ ...base, gateBypass: ['api'] }, rt));
  assert.throws(() => validateSpec({ ...base, maintenanceAllow: ['1.2.3.4; deny all'] }, rt));
  assert.equal(validateSpec(base, rt).gate, false);
});

test('ip rules accept addresses and networks only', () => {
  const { validateSpec } = require('../src/validate');
  const rt = { runtimes: { static: { types: ['static'], kind: 'static', fixedPort: 8080 } } };
  const base = { id: 1, type: 'static', runtime: 'static' };
  const ok = validateSpec({ ...base, ipAllow: ['10.0.0.0/8', '2001:db8::/32', '203.0.113.7'], ipDeny: ['198.51.100.1'], rateRps: 5, rateBurst: 20 }, rt);
  assert.deepEqual(ok.ipAllow, ['10.0.0.0/8', '2001:db8::/32', '203.0.113.7']);
  assert.equal(ok.rateRps, 5);
  for (const bad of ['10.0.0.0/33', '2001:db8::/129', 'example.com', '1.2.3.4; deny all', '1.2.3.4/8/8', '10.0.0.0/']) {
    assert.throws(() => validateSpec({ ...base, ipAllow: [bad] }, rt), undefined, bad);
  }
  assert.throws(() => validateSpec({ ...base, rateRps: 5000 }, rt));
  assert.equal(validateSpec(base, rt).rateRps, 0);
});

test('country rule needs valid codes and at least one country', () => {
  const { validateSpec } = require('../src/validate');
  const rt = { runtimes: { static: { types: ['static'], kind: 'static', fixedPort: 8080 } } };
  const base = { id: 1, type: 'static', runtime: 'static' };
  const ok = validateSpec({ ...base, geoMode: 'block', geoCountries: ['RU', 'CN', 'RU'] }, rt);
  assert.deepEqual(ok.geoCountries, ['CN', 'RU']);
  assert.throws(() => validateSpec({ ...base, geoMode: 'allow', geoCountries: [] }, rt));
  assert.throws(() => validateSpec({ ...base, geoMode: 'block', geoCountries: ['ru'] }, rt));
  assert.throws(() => validateSpec({ ...base, geoMode: 'block', geoCountries: ['DE; return 200'] }, rt));
  assert.equal(validateSpec({ ...base, geoMode: 'weird' }, rt).geoMode, 'off');
});

test('security headers and firewall settings are validated', () => {
  const { validateSpec } = require('../src/validate');
  const rt = { runtimes: { static: { types: ['static'], kind: 'static', fixedPort: 8080 } } };
  const base = { id: 1, type: 'static', runtime: 'static' };
  const ok = validateSpec({ ...base, secHeaders: { hsts: true, xfo: 'deny', csp: "default-src 'self'" }, wafMode: 'block', wafCategories: ['sqli', 'nope', 'sqli', 'xss'], wafExempt: ['/admin/'] }, rt);
  assert.equal(ok.secHeaders.xfo, 'deny');
  assert.deepEqual(ok.wafCategories, ['sqli', 'xss']);
  assert.equal(ok.wafMode, 'block');
  assert.equal(validateSpec({ ...base, secHeaders: { xfo: 'bogus', referrer: 'bogus' } }, rt).secHeaders, null, 'all-off collapses to null');
  for (const bad of ['default-src "self"', 'default-src $x', 'default-src a\\b', "a\nb"]) {
    assert.throws(() => validateSpec({ ...base, secHeaders: { csp: bad } }, rt), undefined, bad);
  }
  assert.throws(() => validateSpec({ ...base, wafExempt: ['/a b'] }, rt));
  assert.equal(validateSpec(base, rt).wafMode, 'off');
});

test('IP lists refuse IPv6 zone IDs, which nginx cannot parse', () => {
  const v = require('../src/validate');
  assert.deepEqual(v.netList(['::1/128', '10.0.0.0/8']), ['::1/128', '10.0.0.0/8']);
  assert.throws(() => v.netList(['fe80::1%eth0']), /Invalid IP/);
  assert.throws(() => v.netList(['fe80::1%eth0/64']), /Invalid IP/);
});

test('external database access refuses networks that cover (half of) the internet', () => {
  const base = { id: 1, type: 'static', runtime: Object.keys(runtimes.runtimes).find((k) => runtimes.runtimes[k].types.includes('static')) };
  const db = (allow) => ({ ...base, database: { engine: 'mariadb', name: 'app', user: 'app', password: 'a'.repeat(20), rootPassword: 'b'.repeat(20), external: { allow } } });
  for (const bad of ['0.0.0.0/0', '10.0.0.0/0', '0.0.0.0/1', '128.0.0.0/7', '::/0', '2000::/15']) {
    assert.throws(() => validateSpec(db([bad]), runtimes), /too large/, bad);
  }
  for (const good of ['203.0.113.7', '203.0.113.0/24', '10.0.0.0/8', '2001:db8::/32']) {
    assert.doesNotThrow(() => validateSpec(db([good]), runtimes), good);
  }
});

test('a wildcard domain is accepted for websites, only as the first label', () => {
  const { domain, isWildcard } = require('../src/validate');
  assert.deepEqual(validateSpec({ ...base, domains: ['*.Example.com', 'example.com'] }, runtimes).domains, ['*.example.com', 'example.com']);
  assert.equal(domain('*.example.com', true), '*.example.com');
  assert.throws(() => domain('*.example.com'), /Invalid domain/, 'the default refuses wildcards (dashboard domain)');
  assert.throws(() => domain('a.*.example.com', true), /Invalid domain/);
  assert.equal(isWildcard('*.example.com'), true);
  assert.equal(isWildcard('example.com'), false);
});
