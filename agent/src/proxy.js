'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const { config } = require('./config');
const { docker } = require('./docker');
const { audit } = require('./audit');

let chain = Promise.resolve();
/** Serialises proxy configuration changes so they cannot interleave. */
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function tpl(name) {
  return fs.readFileSync(path.join(config.TEMPLATES_DIR, 'nginx', name), 'utf8');
}

function fill(template, vars) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => (k in vars ? vars[k] : ''));
}

function certPaths(name) {
  const dir = path.join(config.LE_DIR, 'live', name);
  return { full: path.join(dir, 'fullchain.pem'), key: path.join(dir, 'privkey.pem') };
}

function certExists(name) {
  const p = certPaths(name);
  try { return fs.existsSync(p.full) && fs.existsSync(p.key); } catch (_) { return false; }
}

const geo = require('./geo');
const waf = require('./waf');

/**
 * Per-vhost view of the ban list (value 1 = banned). Kept inside every vhost so it also works when the proxy image
 * is older than the agent; local networks can never be banned.
 */
function banBlock(varName) {
  const local = geo.ALWAYS_ALLOWED.map((n) => `    ${n} 0;`).join('\n');
  return `geo $${varName} {\n    default 0;\n${local}\n    include /etc/nginx/conf.d/geo/banned-*.map;\n}\n`;
}

const PERMISSIONS_POLICY = 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()';

/** Response headers of a website. Upstream copies are hidden first, so each header is sent exactly once. */
function headerLines(h, tls) {
  if (!h) return '';
  const set = [];
  if (h.hsts && tls) set.push(['Strict-Transport-Security', 'max-age=31536000']);
  if (h.xfo !== 'off') set.push(['X-Frame-Options', h.xfo.toUpperCase()]);
  if (h.nosniff) set.push(['X-Content-Type-Options', 'nosniff']);
  if (h.referrer !== 'off') set.push(['Referrer-Policy', h.referrer]);
  if (h.permissions) set.push(['Permissions-Policy', PERMISSIONS_POLICY]);
  if (h.csp) set.push([h.cspReportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', h.csp]);
  return set.map(([k, v]) => `        proxy_hide_header ${k};\n        add_header ${k} "${v}" always;\n`).join('');
}

const GATE_WIDGET = `        # the widget is injected into HTML pages, which requires an uncompressed upstream response
        proxy_set_header Accept-Encoding "";
        sub_filter_once on;
        sub_filter_types text/html;
        sub_filter '</body>' '<script src="/__wm_gate/widget.js" defer></script></body>';
`;
/**
 * Fallback pages (docker/proxy/errors, baked into the proxy image) for errors nginx produces itself: website stopped or
 * unreachable (502), too slow (504), refused (403/429/413) ... Responses the website sends itself pass through untouched.
 * They are static files, so they work even when the dashboard or the agent is down. 503 is left to the maintenance page when active.
 */
const ERROR_CODES = [400, 403, 404, 413, 429, 500, 502, 503, 504];
const errorPages = (maintenance) => ERROR_CODES.filter((c) => !(maintenance && c === 503)).map((c) => `        error_page ${c} /__wm_err/${c}.html;\n`).join('');
const ERROR_LOCATIONS = `    location ^~ /__wm_err/assets/ {
        alias /etc/nginx/errors/assets/;
    }
    location ^~ /__wm_err/ {
        internal;
        alias /etc/nginx/errors/;
    }
`;
const MAINTENANCE_RETURN = `        error_page 503 @wm_maint;
        if ($wm_maint) { return 503; }
`;

/**
 * IP allow/deny and request rate limit for a proxied location. nginx applies the first matching rule:
 * denied networks first, then the allowed ones, then "deny all" when an allow list exists.
 */
function accessRules({ ipAllow, ipDeny, rateRps, rateBurst, connLimit = 0, zone }) {
  let out = '';
  for (const n of ipDeny) out += `        deny ${n};
`;
  for (const n of ipAllow) out += `        allow ${n};
`;
  if (ipAllow.length) out += `        deny all;
`;
  if (connLimit > 0) out += `        limit_conn ${zone}_conn ${connLimit};
        limit_conn_status 429;
`;
  if (rateRps > 0) out += `        limit_req zone=${zone} burst=${rateBurst} nodelay;
        limit_req_status 429;
`;
  return out;
}

/**
 * Locations of the dashboard vhost that front the on-demand database administration (Adminer) of each website.
 * Access needs a signed-in dashboard session of at least the operator role (checked by the dashboard through auth_request).
 */
function dbadminLocations(banVar) {
  const dash = config.dashboardUpstream;
  return `    location = /__dbadmin_auth {
        internal;
        set $wm_dash http://${dash};
        proxy_pass $wm_dash/api/dbadmin/auth;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $wm_forwarded_proto;
        proxy_set_header X-Original-URI $request_uri;
    }
    location @dbadmin_login { return 302 /login; }
    location ~ "^/dbadmin/(site-[0-9]{3,5})(/.*)?$" {
        if ($${banVar}) { return 444; }
        auth_request /__dbadmin_auth;
        error_page 401 = @dbadmin_login;
        set $wm_dbadmin http://wm-dbadmin-$1:8080;
        set $wm_dbadmin_path $2;
        if ($wm_dbadmin_path = '') { set $wm_dbadmin_path /; }
        proxy_pass $wm_dbadmin$wm_dbadmin_path$is_args$args;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $wm_forwarded_proto;
        proxy_cookie_path / /dbadmin/$1/;
        proxy_connect_timeout 10s;
        proxy_read_timeout 300s;
        client_max_body_size 128m;
    }
`;
}

/**
 * WebSocket of the web console on the dashboard's address: /__console is forwarded to the agent, but only after the
 * dashboard confirmed that the session belongs to a signed-in administrator (auth_request) and the request comes from the
 * dashboard's own page (Origin check there). Nothing else of the agent is reachable this way: the target path is fixed. The one-time
 * ticket travels in the Sec-WebSocket-Protocol header (passed on unchanged), not in the URL, so it does not end up in access logs.
 */
function consoleLocations(banVar) {
  if (!config.consoleEnabled) return '';
  const dash = config.dashboardUpstream;
  return `    location = /__console_auth {
        internal;
        set $wm_dash http://${dash};
        proxy_pass $wm_dash/api/console/auth;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $wm_forwarded_proto;
        proxy_set_header X-Original-URI $request_uri;
        proxy_set_header X-Original-Host $http_host;
    }
    location = /__console {
        if ($${banVar}) { return 444; }
        auth_request /__console_auth;
        set $wm_agent http://${config.agentUpstream};
        proxy_pass $wm_agent/ws/console;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_connect_timeout 10s;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
`;
}

/**
 * Renders the vhost for a site (or for the dashboard) from the validated spec.
 * Optional access control: `gate` (password), `bypass` (public path list), `maintenance` + `allowIps`.
 */
function renderVhost({ name, domains, upstream, tls, gate = false, bypass = [], maintenance = false, allowIps = [], ipAllow = [], ipDeny = [], rateRps = 0, rateBurst = 0, connLimit = 0, geoMap = false, bans = true, secHeaders = null, wafConf = null, extraLocations = '', extraHttp = '' }) {
  const names = domains.join(' ');
  const vars = { GATE_UPSTREAM: config.dashboardUpstream, GATE_SITE: name };
  let pre = '';
  const zone = `wm_${name.replace(/-/g, '_')}`;
  const geoVar = `wm_geo_${name.replace(/-/g, '_')}`;
  const banVar = `wm_ban_${name.replace(/-/g, '_')}`;
  const wafVars = wafConf && wafConf.mode !== 'off' ? waf.renderSiteVars(name, wafConf.categories, wafConf.exempt || []) : null;
  const wafLines = wafVars
    ? (wafConf.mode === 'block' ? `        if ($${wafVars.varName}) { return 403; }\n` : '')
      + `        access_log /dev/stdout main;\n        access_log /dev/stdout wm_waf if=$${wafVars.varName};\n`
    : '';
  const rules = headerLines(secHeaders, tls) + (bans ? `        if ($${banVar}) { return 444; }\n` : '') + (geoMap ? `        if ($${geoVar}) { return 403; }\n` : '') + wafLines
    + accessRules({ ipAllow, ipDeny, rateRps, rateBurst, connLimit, zone });
  const extra = (withGate) => rules + errorPages(maintenance) + (maintenance ? MAINTENANCE_RETURN : '') + (withGate && gate ? `        auth_request /__wm_gate/auth;\n        error_page 401 = @wm_gate_login;\n${GATE_WIDGET}` : '');
  let location = '';
  if (gate || maintenance) {
    if (maintenance) {
      pre += '    set $wm_maint 1;\n';
      for (const ip of allowIps) pre += `    if ($remote_addr = ${ip}) { set $wm_maint 0; }\n`;
    }
    location += fill(tpl('gate-common.conf.tpl'), vars);
    if (gate) location += fill(tpl('gate-auth.conf.tpl'), vars);
  }
  if (gate) {
    // public paths: a trailing slash means "everything below", otherwise exactly that URL
    for (const p of bypass) {
      location += fill(tpl('proxy-location.conf.tpl'), { UPSTREAM: upstream, MATCH: p.endsWith('/') ? `^~ ${p}` : `= ${p}`, EXTRA: extra(false) });
    }
  }
  location += ERROR_LOCATIONS;
  location += extraLocations;
  location += fill(tpl('proxy-location.conf.tpl'), { UPSTREAM: upstream, MATCH: '/', EXTRA: extra(true) });
  location = pre + location;
  const httpBody = tls ? '    location / {\n        return 301 https://$host$request_uri;\n    }' : location;
  const tlsServer = tls ? fill(tpl('tls-server.conf.tpl'), { SERVER_NAMES: names, CERT: name, PROXY_LOCATION: location }) : '';
  const geoBlock = geoMap ? `geo $${geoVar} {\n    include /etc/nginx/conf.d/geo/${name}.map;\n}\n` : '';
  const connLine = connLimit > 0 ? `limit_conn_zone $binary_remote_addr zone=${zone}_conn:1m;\n` : '';
  const zoneLine = (bans ? banBlock(banVar) : '') + (wafVars ? wafVars.block : '') + geoBlock + connLine + (rateRps > 0 ? `limit_req_zone $binary_remote_addr zone=${zone}:1m rate=${rateRps}r/s;
` : '');
  return zoneLine + fill(tpl('vhost.conf.tpl'), { NAME: name, SERVER_NAMES: names, HTTP_BODY: httpBody, TLS_SERVER: tlsServer }) + extraHttp;
}

// The password-gate endpoints (/gate/...) are for the websites' vhosts only, where the proxy sets X-WebManager-Site itself. On the
// dashboard's own address that header would come from the visitor, so these paths are not served there at all.
const NO_GATE = '    location ^~ /gate/ { return 404; }\n';

/** Dashboard vhost plus the catch-all default server. */
function renderDashboard(domain) {
  const upstream = config.dashboardUpstream;
  if (!domain) {
    const loc = fill(tpl('proxy-location.conf.tpl'), { UPSTREAM: upstream, MATCH: '/', EXTRA: `        if ($wm_ban_dashboard) { return 444; }\n${errorPages(false)}` });
    return `# Managed by WebManager (dashboard, IP based first-time access)
${banBlock('wm_ban_dashboard')}server {
    listen 80 default_server;
    server_name _;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
        default_type text/plain;
    }
${ERROR_LOCATIONS}${NO_GATE}${dbadminLocations('wm_ban_dashboard')}${consoleLocations('wm_ban_dashboard')}${loc}
}
`;
  }
  const tls = certExists('dashboard');
  const vhost = renderVhost({ name: 'dashboard', domains: [domain], upstream, tls, extraLocations: NO_GATE + dbadminLocations('wm_ban_dashboard') + consoleLocations('wm_ban_dashboard') });
  return `${vhost}
# Unknown hosts never reach the dashboard once a dashboard domain is configured.
server {
    listen 80 default_server;
    server_name _;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
        default_type text/plain;
    }
    location / { return 444; }
}
`;
}

async function nginxTest() {
  return docker(['exec', config.proxyContainer, 'nginx', '-t'], { timeout: 30000 });
}

async function nginxReload() {
  return docker(['exec', config.proxyContainer, 'nginx', '-s', 'reload'], { timeout: 30000 });
}

/**
 * Atomically installs a vhost file: previous content is restored if `nginx -t` fails,
 * so an invalid configuration can never take the other websites offline.
 */
function installVhost(fileName, content) {
  return exclusive(async () => {
    const target = path.join(config.PROXY_CONF_DIR, fileName);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    let previous = null;
    try { previous = fs.readFileSync(target, 'utf8'); } catch (_) { /* new file */ }
    if (previous === content) return { changed: false };
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o644 });
    fs.renameSync(tmp, target);
    const t = await nginxTest();
    if (t.code !== 0) {
      if (previous === null) fs.rmSync(target, { force: true }); else fs.writeFileSync(target, previous, { mode: 0o644 });
      audit('proxy.config_rejected', { file: fileName, output: (t.stderr || t.stdout).slice(0, 500) });
      const e = new Error(`Proxy configuration was rejected and rolled back: ${(t.stderr || t.stdout).trim().slice(0, 400)}`);
      e.status = 422;
      throw e;
    }
    const r = await nginxReload();
    if (r.code !== 0) {
      const e = new Error(`Proxy could not be reloaded: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      e.status = 502;
      throw e;
    }
    return { changed: true };
  });
}

function removeVhost(fileName) {
  return exclusive(async () => {
    const target = path.join(config.PROXY_CONF_DIR, fileName);
    if (!fs.existsSync(target)) return { changed: false };
    const previous = fs.readFileSync(target, 'utf8');
    fs.rmSync(target, { force: true });
    const t = await nginxTest();
    if (t.code !== 0) {
      fs.writeFileSync(target, previous, { mode: 0o644 });
      const e = new Error(`Removing the proxy route was rejected: ${(t.stderr || t.stdout).trim().slice(0, 300)}`);
      e.status = 422;
      throw e;
    }
    await nginxReload();
    return { changed: true };
  });
}

/**
 * Validates the list of trusted upstream proxies (TRUSTED_PROXIES: comma separated IPs or CIDR ranges).
 * "Everything" (0.0.0.0/0, ::/0) is refused: it would let any visitor choose the address the throttling, bans and logs see.
 */
function parseTrustedProxies(raw) {
  const items = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length > 50) throw new Error('TRUSTED_PROXIES: at most 50 entries');
  return items.map((item) => {
    const [ip, bits, ...rest] = item.split('/');
    const family = net.isIP(ip);
    if (!family || rest.length || (bits !== undefined && !/^\d{1,3}$/.test(bits))) throw new Error(`TRUSTED_PROXIES: invalid entry "${item}"`);
    const max = family === 4 ? 32 : 128;
    if (bits !== undefined && Number(bits) > max) throw new Error(`TRUSTED_PROXIES: invalid prefix in "${item}"`);
    if (bits !== undefined && Number(bits) === 0) throw new Error(`TRUSTED_PROXIES: "${item}" would trust every address`);
    return item;
  });
}

/** nginx snippet (http level) that takes the visitor address from X-Forwarded-For when the request comes from a trusted proxy. */
function renderRealIp(list) {
  if (!list.length) return '';
  return `# Managed by WebManager (TRUSTED_PROXIES): the visitor address behind another reverse proxy
${list.map((n) => `set_real_ip_from ${n};`).join('\n')}
real_ip_header X-Forwarded-For;
real_ip_recursive on;
`;
}

module.exports = { consoleLocations, renderVhost, renderDashboard, installVhost, removeVhost, certExists, certPaths, parseTrustedProxies, renderRealIp };
