'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-dns-'));
process.env.DATA_DIR = data;
process.env.AGENT_TOKEN_DASHBOARD = 'd'.repeat(32);
process.env.AGENT_TOKEN_WORKER = 'w'.repeat(32);
process.env.TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');
const dns = require('../src/dns');
const { ValidationError } = require('../src/validate');

const cred = () => path.join(data, 'runtime', 'dns', 'credentials.json');

test('nothing is configured at first', () => {
  const s = dns.status();
  assert.equal(s.configured, false);
  assert.equal(s.provider, null);
  assert.deepEqual(s.dnsCerts, []);
});

test('saving stores the token readable by root only and the hook next to it; the status never contains the token', () => {
  dns.save({ provider: 'cloudflare', token: 'abcdefgh12345678', wait: 20 });
  assert.equal(fs.statSync(cred()).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(cred(), 'utf8')).token, 'abcdefgh12345678');
  assert.equal(fs.readFileSync(path.join(data, 'runtime', 'dns', 'dns_hook.py'), 'utf8'), fs.readFileSync(path.join(process.env.TEMPLATES_DIR, 'dns', 'dns_hook.py'), 'utf8'));
  const s = dns.status();
  assert.deepEqual({ configured: s.configured, provider: s.provider, wait: s.wait }, { configured: true, provider: 'cloudflare', wait: 20 });
  assert.ok(!JSON.stringify(s).includes('abcdefgh'));
});

test('an unknown provider, a bad token or a bad wait time is refused and nothing changes', () => {
  for (const bad of [
    { provider: 'route53', token: 'abcdefgh12345678' }, { provider: 'hetzner', token: 'short' }, { provider: 'hetzner', token: 'has space 12345678' },
    { provider: 'hetzner', token: 'x'.repeat(501) }, { provider: 'hetzner', token: 'abcdefgh12345678', wait: 301 }, { provider: 'hetzner', token: 'abcdefgh12345678', wait: -1 },
    { provider: 'hetzner', token: 'abcdefgh12345678', wait: 1.5 }, { provider: 'hetzner', token: 123456789 }, { provider: 'hetzner' },
  ]) assert.throws(() => dns.save(bad), ValidationError, JSON.stringify(bad));
  assert.equal(dns.status().provider, 'cloudflare');
});

test('removing the connection deletes the file', () => {
  dns.save({ provider: 'hetzner', token: 'abcdefgh12345678' });
  assert.equal(dns.status().provider, 'hetzner');
  assert.equal(dns.status().wait, 30, 'default wait time');
  dns.clear();
  assert.equal(fs.existsSync(cred()), false);
  assert.equal(dns.status().configured, false);
});

test('certificates validated through DNS are recognised by their renewal file, not by what was asked last', () => {
  const dir = path.join(data, 'letsencrypt', 'renewal');
  fs.mkdirSync(dir, { recursive: true });
  const conf = (body) => `# renew_before_expiry = 30 days\nversion = 5.9.0\n\n[renewalparams]\naccount = abc\n${body}\nserver = https://acme-v02.api.letsencrypt.org/directory\n`;
  fs.writeFileSync(path.join(dir, 'site-002.conf'), conf('authenticator = manual\nmanual_auth_hook = python3 /dns/dns_hook.py auth\nmanual_cleanup_hook = python3 /dns/dns_hook.py cleanup\npref_challs = dns-01,'));
  fs.writeFileSync(path.join(dir, 'site-001.conf'), conf('authenticator = manual\nmanual_auth_hook = python3 /dns/dns_hook.py auth'));
  fs.writeFileSync(path.join(dir, 'site-003.conf'), conf('authenticator = webroot\nwebroot_path = /var/www/acme,'));
  fs.writeFileSync(path.join(dir, 'site-004.conf'), conf('authenticator = manual\nmanual_auth_hook = /usr/local/bin/my-own-hook.sh'));
  fs.writeFileSync(path.join(dir, 'dashboard.conf'), conf('authenticator = webroot'));
  fs.writeFileSync(path.join(dir, 'Bad Name.conf'), conf('authenticator = manual\nmanual_auth_hook = python3 /dns/dns_hook.py auth'));
  fs.writeFileSync(path.join(dir, 'site-005.txt'), 'authenticator = manual\nmanual_auth_hook = python3 /dns/dns_hook.py auth');
  assert.deepEqual(dns.dnsCerts(), ['site-001', 'site-002'], 'only our hook counts, sorted, valid names, .conf files');
  assert.equal(dns.isDnsCert('site-002'), true);
  assert.equal(dns.isDnsCert('site-003'), false);
  assert.equal(dns.isDnsCert('site-004'), false, 'a manual certificate with someone else\'s hook is not ours');
  assert.deepEqual(dns.status().dnsCerts, ['site-001', 'site-002']);
  // the same site later issued through the web root: the file says webroot, so the renewal uses the web root
  fs.writeFileSync(path.join(dir, 'site-002.conf'), conf('authenticator = webroot'));
  assert.deepEqual(dns.dnsCerts(), ['site-001']);
});

test('usesDnsHook needs the authenticator and the hook of this program in one file', () => {
  assert.equal(dns.usesDnsHook('authenticator = manual\nmanual_auth_hook = python3 /dns/dns_hook.py auth\n'), true);
  assert.equal(dns.usesDnsHook('authenticator = manual\n'), false);
  assert.equal(dns.usesDnsHook('manual_auth_hook = python3 /dns/dns_hook.py auth\n'), false);
  assert.equal(dns.usesDnsHook('# authenticator = manual\nmanual_auth_hook = x /dns/dns_hook.py\n'), false, 'a comment is no setting');
  assert.equal(dns.usesDnsHook(''), false);
});

test('certbot is told to use the hook script from the read-only mount', () => {
  const h = dns.certbotHooks();
  assert.ok(h.includes('--manual') && h.includes('dns'));
  assert.equal(h[h.indexOf('--manual-auth-hook') + 1], 'python3 /dns/dns_hook.py auth');
  assert.equal(h[h.indexOf('--manual-cleanup-hook') + 1], 'python3 /dns/dns_hook.py cleanup');
  assert.match(dns.mount()[1], /:\/dns:ro$/);
});
