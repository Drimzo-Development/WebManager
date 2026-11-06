'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-geo-'));
process.env.AGENT_TOKEN_DASHBOARD = 'a'.repeat(40);
process.env.AGENT_TOKEN_WORKER = 'b'.repeat(40);
process.env.TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

const geo = require('../src/geo');

test('ranges are split into aligned CIDR blocks', () => {
  assert.deepEqual(geo.rangeToCidrs('192.0.2.0', 256), ['192.0.2.0/24']);
  assert.deepEqual(geo.rangeToCidrs('192.0.2.0', 768), ['192.0.2.0/23', '192.0.4.0/24']);
  assert.deepEqual(geo.rangeToCidrs('10.0.0.128', 384), ['10.0.0.128/25', '10.0.1.0/24']);
  assert.deepEqual(geo.rangeToCidrs('1.2.3.4', 1), ['1.2.3.4/32']);
  assert.deepEqual(geo.rangeToCidrs('0.0.0.0', 2 ** 32), ['0.0.0.0/0']);
  assert.deepEqual(geo.rangeToCidrs('128.0.0.0', 2 ** 31), ['128.0.0.0/1']);
});

test('delegated files are parsed per country, only allocated and assigned blocks count', () => {
  const text = [
    '2|ripencc|20261011|1234|19830705|20261010|+0100',
    'ripencc|*|ipv4|*|100|summary',
    '# comment',
    'ripencc|DE|ipv4|5.1.0.0|65536|20120101|allocated',
    'ripencc|DE|ipv6|2001:db8::|32|20120101|allocated',
    'ripencc|FR|ipv4|5.2.0.0|256|20120101|assigned',
    'ripencc|FR|ipv4|5.3.0.0|256|20120101|reserved',
    'ripencc||ipv4|5.4.0.0|256|20120101|available',
    'ripencc|XX|asn|100|1|20120101|allocated',
    'ripencc|DE|ipv4|not-an-ip|256|20120101|allocated',
  ].join('\n');
  const m = new Map();
  assert.equal(geo.parseDelegated(text, m), 3);
  assert.deepEqual([...m.get('DE')].sort(), ['2001:db8::/32', '5.1.0.0/16']);
  assert.deepEqual([...m.get('FR')], ['5.2.0.0/24']);
});

test('site maps invert for allow mode and keep local networks reachable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-geo-lists-'));
  fs.writeFileSync(path.join(dir, 'DE.txt'), '5.1.0.0/16\n2001:db8::/32\n');
  const block = geo.renderMap('block', ['DE'], dir);
  assert.match(block, /default 0;/);
  assert.match(block, /5\.1\.0\.0\/16 1;/);
  assert.match(block, /192\.168\.0\.0\/16 0;/);
  const allow = geo.renderMap('allow', ['DE', 'ZZ'], dir);
  assert.match(allow, /default 1;/);
  assert.match(allow, /5\.1\.0\.0\/16 0;/);
  assert.match(allow, /2001:db8::\/32 0;/);
  assert.throws(() => geo.renderMap('block', ['de; return 200'], dir));
});

test('map generation refuses to run without country data', () => {
  assert.throws(() => geo.writeSiteMap('site-001', 'block', ['DE']), /GeoIP data is missing/);
  assert.equal(geo.writeSiteMap('site-001', 'off', []), false);
});

test('network errors get a readable description, including empty AggregateErrors', () => {
  const agg = new AggregateError([Object.assign(new Error('connect ENETUNREACH 2001:db8::1:443'), { code: 'ENETUNREACH', address: '2001:db8::1' }), Object.assign(new Error('connect ETIMEDOUT 203.0.113.9:443'), { code: 'ETIMEDOUT', address: '203.0.113.9' })], '');
  const text = geo.describeError(agg);
  assert.match(text, /ENETUNREACH/);
  assert.match(text, /ETIMEDOUT/);
  assert.match(text, /203\.0\.113\.9/);
  assert.equal(geo.describeError(new Error('HTTP 404 from ftp.apnic.net')), 'HTTP 404 from ftp.apnic.net');
  assert.ok(geo.describeError(new Error('')).length > 0);
  assert.ok(geo.REGISTRIES.every((r) => r.urls.length >= 1 && r.urls.every((u) => u.startsWith('https://'))));
});
