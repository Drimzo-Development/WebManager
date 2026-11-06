'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.DATA_DIR = path.join(require('os').tmpdir(), 'wm-data-test');
process.env.AGENT_TOKEN_DASHBOARD = 'a'.repeat(40);
process.env.AGENT_TOKEN_WORKER = 'b'.repeat(40);
process.env.TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

const proxy = require('../src/proxy');
const sites = require('../src/sites');

test('http-only vhost proxies to the site container', () => {
  const out = proxy.renderVhost({ name: 'site-001', domains: ['a.example.com', 'b.example.com'], upstream: 'wm-site-001:3000', tls: false });
  assert.match(out, /server_name a\.example\.com b\.example\.com;/);
  assert.match(out, /set \$wm_upstream http:\/\/wm-site-001:3000;/);
  assert.match(out, /acme-challenge/);
  assert.doesNotMatch(out, /listen 443/);
  assert.doesNotMatch(out, /\{\{/);
});

test('tls vhost redirects http and serves https with websocket headers', () => {
  const out = proxy.renderVhost({ name: 'site-002', domains: ['x.example.com'], upstream: 'wm-site-002:3000', tls: true });
  assert.match(out, /return 301 https:\/\/\$host\$request_uri;/);
  assert.match(out, /listen 443 ssl;/);
  assert.match(out, /live\/site-002\/fullchain\.pem/);
  assert.match(out, /Upgrade \$http_upgrade/);
  assert.doesNotMatch(out, /\{\{/);
});

test('dashboard without domain is the default server; with domain unknown hosts get 444', () => {
  assert.match(proxy.renderDashboard(''), /listen 80 default_server;[\s\S]*webmanager:8080/);
  const withDomain = proxy.renderDashboard('panel.example.com');
  assert.match(withDomain, /server_name panel\.example\.com;/);
  assert.match(withDomain, /return 444;/);
});

test('every site gets its own network subnet and uid', () => {
  const nets = new Set();
  for (let i = 1; i <= 2048; i++) nets.add(sites.subnetFor(i));
  assert.equal(nets.size, 2048);
  assert.throws(() => sites.subnetFor(2049));
  assert.notEqual(sites.names(1).uid, sites.names(2).uid);
  assert.equal(sites.names(7).network, 'wm-net-007');
});

test('password-protected vhost adds auth_request, gate routes and the widget injection', () => {
  const out = proxy.renderVhost({ name: 'site-003', domains: ['p.example.com'], upstream: 'wm-site-003:3000', tls: true, gate: true });
  assert.match(out, /location = \/__wm_gate\/auth \{\s+internal;/);
  assert.match(out, /auth_request \/__wm_gate\/auth;/);
  assert.match(out, /error_page 401 = @wm_gate_login;/);
  assert.match(out, /X-WebManager-Site site-003;/);
  assert.match(out, /sub_filter '<\/body>'/);
  assert.match(out, /http:\/\/webmanager:8080/);
  assert.doesNotMatch(out, /\{\{/);
  const plain = proxy.renderVhost({ name: 'site-003', domains: ['p.example.com'], upstream: 'wm-site-003:3000', tls: true });
  assert.doesNotMatch(plain, /auth_request|__wm_gate/);
});

test('public paths skip the password prompt and the widget', () => {
  const out = proxy.renderVhost({ name: 'site-004', domains: ['q.example.com'], upstream: 'wm-site-004:3000', tls: true, gate: true, bypass: ['/api/', '/health'] });
  assert.match(out, /location \^~ \/api\/ \{/);
  assert.match(out, /location = \/health \{/);
  const api = out.slice(out.indexOf('location ^~ /api/ {'), out.indexOf('location = /health {'));
  assert.doesNotMatch(api, /auth_request|sub_filter/);
  assert.match(out, /location \/ \{[\s\S]*auth_request \/__wm_gate\/auth;/);
  assert.doesNotMatch(out, /\{\{/);
});

test('maintenance mode answers 503 except for allowed addresses', () => {
  const out = proxy.renderVhost({ name: 'site-005', domains: ['m.example.com'], upstream: 'wm-site-005:3000', tls: false, maintenance: true, allowIps: ['203.0.113.7'] });
  assert.match(out, /set \$wm_maint 1;/);
  assert.match(out, /if \(\$remote_addr = 203\.0\.113\.7\) \{ set \$wm_maint 0; \}/);
  assert.match(out, /error_page 503 @wm_maint;/);
  assert.match(out, /if \(\$wm_maint\) \{ return 503; \}/);
  assert.match(out, /location @wm_maint \{/);
  assert.doesNotMatch(out, /auth_request/);
  const plain = proxy.renderVhost({ name: 'site-005', domains: ['m.example.com'], upstream: 'wm-site-005:3000', tls: false });
  assert.doesNotMatch(plain, /wm_maint|__wm_gate/);
});

test('ip rules and rate limit are rendered per location and zone', () => {
  const out = proxy.renderVhost({ name: 'site-006', domains: ['r.example.com'], upstream: 'wm-site-006:3000', tls: false, ipAllow: ['203.0.113.0/24'], ipDeny: ['203.0.113.9'], rateRps: 10, rateBurst: 30 });
  assert.match(out, /^limit_req_zone \$binary_remote_addr zone=wm_site_006:1m rate=10r\/s;/m);
  assert.ok(out.indexOf('deny 203.0.113.9;') < out.indexOf('allow 203.0.113.0/24;'), 'denies come before allows');
  assert.ok(out.indexOf('allow 203.0.113.0/24;') < out.indexOf('deny all;'));
  assert.match(out, /limit_req zone=wm_site_006 burst=30 nodelay;/);
  assert.match(out, /limit_req_status 429;/);
  const plain = proxy.renderVhost({ name: 'site-006', domains: ['r.example.com'], upstream: 'wm-site-006:3000', tls: false });
  assert.doesNotMatch(plain, /limit_req|allow|deny/);
});

test('country rule includes the generated map and blocks before anything else', () => {
  const out = proxy.renderVhost({ name: 'site-008', domains: ['g.example.com'], upstream: 'wm-site-008:3000', tls: false, geoMap: true, ipDeny: ['203.0.113.9'] });
  assert.match(out, /^geo \$wm_geo_site_008 \{\s+include \/etc\/nginx\/conf\.d\/geo\/site-008\.map;\s+\}/m);
  assert.ok(out.indexOf('if ($wm_geo_site_008) { return 403; }') < out.indexOf('deny 203.0.113.9;'));
  assert.doesNotMatch(proxy.renderVhost({ name: 'site-008', domains: ['g.example.com'], upstream: 'u:1', tls: false }), /wm_geo/);
});

test('every vhost carries the ban check and a connection limit zone when configured', () => {
  const out = proxy.renderVhost({ name: 'site-009', domains: ['b.example.com'], upstream: 'wm-site-009:3000', tls: false, connLimit: 25 });
  assert.match(out, /geo \$wm_ban_site_009 \{\s+default 0;/);
  assert.match(out, /include \/etc\/nginx\/conf\.d\/geo\/banned-\*\.map;/);
  assert.match(out, /127\.0\.0\.0\/8 0;/, 'local networks can never be banned');
  assert.match(out, /if \(\$wm_ban_site_009\) \{ return 444; \}/);
  assert.match(out, /limit_conn_zone \$binary_remote_addr zone=wm_site_009_conn:1m;/);
  assert.match(out, /limit_conn wm_site_009_conn 25;/);
  assert.match(out, /limit_conn_status 429;/);
  assert.match(proxy.renderDashboard(''), /if \(\$wm_ban_dashboard\) \{ return 444; \}/);
});

test('security headers are sent once, HSTS only over TLS', () => {
  const h = { hsts: true, xfo: 'sameorigin', nosniff: true, referrer: 'strict-origin-when-cross-origin', permissions: true, csp: "default-src 'self'; img-src 'self' data:", cspReportOnly: false };
  const tls = proxy.renderVhost({ name: 'site-010', domains: ['h.example.com'], upstream: 'u:1', tls: true, secHeaders: h });
  assert.match(tls, /proxy_hide_header Strict-Transport-Security;\s+add_header Strict-Transport-Security "max-age=31536000" always;/);
  assert.match(tls, /add_header X-Frame-Options "SAMEORIGIN" always;/);
  assert.match(tls, /add_header X-Content-Type-Options "nosniff" always;/);
  assert.match(tls, /add_header Content-Security-Policy "default-src 'self'; img-src 'self' data:" always;/);
  const plain = proxy.renderVhost({ name: 'site-010', domains: ['h.example.com'], upstream: 'u:1', tls: false, secHeaders: h });
  assert.doesNotMatch(plain, /Strict-Transport-Security/);
  const ro = proxy.renderVhost({ name: 'site-010', domains: ['h.example.com'], upstream: 'u:1', tls: false, secHeaders: { ...h, cspReportOnly: true } });
  assert.match(ro, /add_header Content-Security-Policy-Report-Only /);
  assert.doesNotMatch(proxy.renderVhost({ name: 'site-010', domains: ['h.example.com'], upstream: 'u:1', tls: false }), /add_header/);
});

test('the firewall blocks or only logs, and exempt paths switch it off', () => {
  const base = { name: 'site-011', domains: ['w.example.com'], upstream: 'u:1', tls: false };
  const block = proxy.renderVhost({ ...base, wafConf: { mode: 'block', categories: ['sqli', 'xss'], exempt: ['/admin/'] } });
  assert.match(block, /map \$wm_waf_cat \$wm_waf_site_011 \{\s+default 0;\s+sqli 1;\s+xss 1;\s+\}/);
  assert.match(block, /map \$uri \$wm_waf_ex_site_011/);
  assert.match(block, /if \(\$wm_waf_hit_site_011\) \{ return 403; \}/);
  assert.match(block, /access_log \/dev\/stdout main;\s+access_log \/dev\/stdout wm_waf if=\$wm_waf_hit_site_011;/);
  const detect = proxy.renderVhost({ ...base, wafConf: { mode: 'detect', categories: ['sqli'], exempt: [] } });
  assert.doesNotMatch(detect, /return 403/);
  assert.match(detect, /wm_waf if=\$wm_waf_site_011;/);
  assert.doesNotMatch(proxy.renderVhost(base), /wm_waf/);
});

test('the dashboard vhost fronts the database administration behind a dashboard session check', () => {
  for (const out of [proxy.renderDashboard(''), proxy.renderDashboard('panel.example.com')]) {
    assert.match(out, /location = \/__dbadmin_auth \{\s+internal;/);
    assert.match(out, /proxy_pass \$wm_dash\/api\/dbadmin\/auth;/);
    assert.match(out, /proxy_set_header X-Original-URI \$request_uri;/);
    assert.match(out, /location ~ "\^\/dbadmin\/\(site-\[0-9\]\{3,5\}\)\(\/\.\*\)\?\$" \{\s+if \(\$wm_ban_dashboard\) \{ return 444; \}\s+auth_request \/__dbadmin_auth;/);
    assert.match(out, /error_page 401 = @dbadmin_login;/);
    assert.match(out, /proxy_cookie_path \/ \/dbadmin\/\$1\/;/);
    assert.match(out, /set \$wm_dbadmin http:\/\/wm-dbadmin-\$1:8080;/);
    assert.doesNotMatch(out, /\{\{/);
  }
  // websites never get it
  assert.doesNotMatch(proxy.renderVhost({ name: 'site-001', domains: ['a.example.com'], upstream: 'u:1', tls: false }), /dbadmin/);
});

/** nginx reads an unquoted "{" as the start of a block: regex locations and map keys with braces must be quoted. */
function assertBracesQuoted(out, label) {
  for (const line of out.split('\n')) {
    const loc = /^\s*location\s+~\*?\s+(.*?)\s*\{\s*$/.exec(line);
    if (loc) {
      const pat = loc[1];
      if (/[{}]/.test(pat)) assert.match(pat, /^"[^"]*"$/, `${label}: unquoted braces in: ${line.trim()}`);
    }
    const key = /^\s*(\S.*?)\s+\S+;\s*$/.exec(line);
    if (key && /^~\*?\S*[{}]/.test(key[1])) assert.fail(`${label}: unquoted regex with braces in map key: ${line.trim()}`);
  }
}

test('generated nginx configuration never contains unquoted braces inside regular expressions', () => {
  assertBracesQuoted(proxy.renderDashboard(''), 'dashboard (IP)');
  assertBracesQuoted(proxy.renderDashboard('panel.example.com'), 'dashboard (domain)');
  const full = proxy.renderVhost({
    name: 'site-020', domains: ['x.example.com'], upstream: 'u:1', tls: true, gate: true, bypass: ['/api/', '/health'], maintenance: true, allowIps: ['203.0.113.7'],
    ipAllow: ['203.0.113.0/24'], ipDeny: ['198.51.100.1'], rateRps: 5, rateBurst: 10, connLimit: 5, geoMap: true,
    secHeaders: { hsts: true, xfo: 'deny', nosniff: true, referrer: 'no-referrer', permissions: true, csp: "default-src 'self'", cspReportOnly: false },
    wafConf: { mode: 'block', categories: ['sqli', 'xss', 'traversal', 'rce', 'probe', 'scanner'], exempt: ['/admin/'] },
  });
  assertBracesQuoted(full, 'full vhost');
  assertBracesQuoted(require('../src/waf').renderRules(), 'waf rules');
  // the checker itself must notice the bug that took the proxy down in 0.5.0
  assert.throws(() => assertBracesQuoted('    location ~ ^/dbadmin/(site-[0-9]{3,5})(/.*)?$ {\n', 'bad'));
});

test('fallback pages: error_page for errors nginx produces itself, 503 stays with the maintenance page in maintenance mode', () => {
  const plain = proxy.renderVhost({ name: 'site-011', domains: ['e.example.com'], upstream: 'wm-site-011:3000', tls: true });
  for (const c of [400, 403, 413, 429, 500, 502, 503, 504]) assert.match(plain, new RegExp(`error_page ${c} /__wm_err/${c}\.html;`));
  assert.match(plain, /location \^~ \/__wm_err\/ \{\s+internal;\s+alias \/etc\/nginx\/errors\/;/);
  assert.match(plain, /location \^~ \/__wm_err\/assets\/ \{\s+alias \/etc\/nginx\/errors\/assets\/;/);
  assert.doesNotMatch(plain, /proxy_intercept_errors/, 'responses of the website itself stay unchanged');
  const maint = proxy.renderVhost({ name: 'site-011', domains: ['e.example.com'], upstream: 'wm-site-011:3000', tls: false, maintenance: true });
  assert.doesNotMatch(maint, /error_page 503 \/__wm_err/);
  assert.match(maint, /error_page 503 @wm_maint;/);
  assert.match(maint, /error_page 502 \/__wm_err\/502\.html;/);
  assert.match(proxy.renderDashboard(''), /error_page 502 \/__wm_err\/502\.html;/);
});

test('fallback pages: every referenced file exists and loads only files of the same origin', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', '..', 'docker', 'proxy', 'errors');
  for (const c of [400, 403, 413, 429, 500, 502, 503, 504]) {
    const html = fs.readFileSync(path.join(dir, `${c}.html`), 'utf8');
    assert.match(html, new RegExp(`Error ${c}`));
    assert.doesNotMatch(html, /<script|<link[^>]+href="https?:|src="https?:/, 'no scripts and no external resources (strict CSP)');
    for (const m of html.matchAll(/(?:href|src)="\/__wm_err\/assets\/([^"]+)"/g)) assert.ok(fs.existsSync(path.join(dir, 'assets', m[1])), m[1]);
  }
  assert.match(fs.readFileSync(path.join(dir, '502.html'), 'utf8'), /http-equiv="refresh"/);
});

test('trusted proxies: valid entries become a real-ip snippet', () => {
  const list = proxy.parseTrustedProxies(' 10.1.2.3 , 172.20.0.0/16,2001:db8::/32 ');
  assert.deepEqual(list, ['10.1.2.3', '172.20.0.0/16', '2001:db8::/32']);
  const out = proxy.renderRealIp(list);
  assert.match(out, /set_real_ip_from 172\.20\.0\.0\/16;/);
  assert.match(out, /real_ip_header X-Forwarded-For;/);
  assert.match(out, /real_ip_recursive on;/);
});

test('trusted proxies: empty means nothing is trusted', () => {
  assert.deepEqual(proxy.parseTrustedProxies(''), []);
  assert.equal(proxy.renderRealIp([]), '');
});

test('trusted proxies: refuses garbage and "trust everyone"', () => {
  for (const bad of ['0.0.0.0/0', '::/0', '10.0.0.1/33', 'example.com', '10.0.0.1;deny all', '10.0.0.1/', '1.2.3.4/8/9', 'unix:/tmp/x']) {
    assert.throws(() => proxy.parseTrustedProxies(bad), /TRUSTED_PROXIES/, bad);
  }
});

test('dashboard vhost forwards the console WebSocket only after the dashboard confirmed the session', () => {
  for (const out of [proxy.renderDashboard('panel.example.com'), proxy.renderDashboard('')]) {
    assert.match(out, /location = \/__console_auth \{\s+internal;/);
    assert.match(out, /proxy_pass \$wm_dash\/api\/console\/auth;/);
    assert.match(out, /proxy_set_header X-Original-Host \$http_host;/);
    assert.match(out, /location = \/__console \{\s+if \(\$wm_ban_dashboard\) \{ return 444; \}\s+auth_request \/__console_auth;/);
    assert.match(out, /proxy_pass \$wm_agent\/ws\/console;/, 'the target path is fixed: nothing else of the agent is reachable');
    assert.doesNotMatch(out, /__console\/\(/, 'the ticket is not part of the URL');
    assert.match(out, /proxy_set_header Upgrade \$http_upgrade;/);
    assert.match(out, /proxy_buffering off;/);
  }
});

test('the dashboard does not serve the password-gate endpoints', () => {
  for (const out of [proxy.renderDashboard(''), proxy.renderDashboard('panel.example.com')]) {
    assert.match(out, /location \^~ \/gate\/ \{ return 404; \}/);
  }
});

test('every error page the vhost points to exists, uses the logo and has the brand header', () => {
  const fs = require('fs');
  const path = require('path');
  const out = proxy.renderVhost({ name: 'site-009', domains: ['e.example.com'], upstream: 'wm-site-009:3000', tls: false });
  const codes = [...out.matchAll(/error_page (\d{3}) \/__wm_err\/\d{3}\.html;/g)].map((m) => m[1]);
  assert.ok(codes.includes('404'), '404 has a page');
  assert.ok(codes.length >= 9);
  const dir = path.join(__dirname, '..', '..', 'docker', 'proxy', 'errors');
  for (const c of new Set(codes)) {
    const html = fs.readFileSync(path.join(dir, `${c}.html`), 'utf8');
    assert.match(html, /<div class="brand"><img src="\/__wm_err\/assets\/logo\.png"/, `${c} shows the logo`);
    assert.match(html, new RegExp(`Error ${c}`));
  }
  assert.ok(fs.existsSync(path.join(dir, 'assets', 'logo.png')));
  assert.equal(fs.readFileSync(path.join(dir, 'assets', 'logo.png')).equals(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'assets', 'logo.png'))), true, 'the logo of the error pages is the current one');
});
