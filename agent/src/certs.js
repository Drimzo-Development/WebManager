'use strict';
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const tls = require('tls');
const net = require('net');
const crypto = require('crypto');
const { config, loadRuntimes } = require('./config');
const { docker, dockerStream } = require('./docker');
const { audit } = require('./audit');
const proxy = require('./proxy');
const sites = require('./sites');
const { CERT_NAME_RE, domain: normDomain, isWildcard, ValidationError } = require('./validate');
const dnsFiles = require('./dns');

const DASH_FILE = path.join(config.RUNTIME_DIR, 'dashboard.json');

function getDashboardDomain() {
  try {
    const j = JSON.parse(fs.readFileSync(DASH_FILE, 'utf8'));
    if (typeof j.domain === 'string') return j.domain;
  } catch (_) { /* fall through */ }
  return config.envDashboardDomain;
}

function setDashboardDomain(d) {
  fs.mkdirSync(config.RUNTIME_DIR, { recursive: true, mode: 0o755 });
  fs.writeFileSync(DASH_FILE, JSON.stringify({ domain: d }), { mode: 0o644 });
}

async function proxyRunning() {
  const r = await docker(['inspect', '-f', '{{.State.Running}}', config.proxyContainer]);
  return r.code === 0 && r.stdout.trim() === 'true';
}

const REALIP_FILE = '00-realip.conf';

/** Installs (or removes) the real-IP snippet from TRUSTED_PROXIES. An invalid value is reported and ignored, never half applied. */
async function applyRealIp() {
  const content = proxy.renderRealIp(proxy.parseTrustedProxies(config.trustedProxies));
  if (await proxyRunning()) return content ? proxy.installVhost(REALIP_FILE, content) : proxy.removeVhost(REALIP_FILE);
  const target = path.join(config.PROXY_CONF_DIR, REALIP_FILE);
  if (!content) { fs.rmSync(target, { force: true }); return { changed: false }; }
  fs.mkdirSync(config.PROXY_CONF_DIR, { recursive: true, mode: 0o755 });
  fs.writeFileSync(`${target}.tmp`, content, { mode: 0o644 });
  fs.renameSync(`${target}.tmp`, target);
  return { changed: true, untested: true };
}

/** Writes the dashboard vhost; when the proxy is not up yet the file is written without testing. */
async function applyDashboard() {
  const content = proxy.renderDashboard(getDashboardDomain());
  if (await proxyRunning()) return proxy.installVhost('00-dashboard.conf', content);
  fs.mkdirSync(config.PROXY_CONF_DIR, { recursive: true, mode: 0o755 });
  const target = path.join(config.PROXY_CONF_DIR, '00-dashboard.conf');
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  fs.renameSync(tmp, target);
  return { changed: true, untested: true };
}

function certInfo(name) {
  if (!CERT_NAME_RE.test(name)) throw new ValidationError('Invalid certificate name');
  const p = proxy.certPaths(name);
  if (!fs.existsSync(p.full)) return { exists: false };
  try {
    const x = new crypto.X509Certificate(fs.readFileSync(p.full));
    const notAfter = new Date(x.validTo);
    const daysLeft = Math.floor((notAfter.getTime() - Date.now()) / 86400000);
    return {
      exists: true,
      notBefore: new Date(x.validFrom).toISOString(),
      notAfter: notAfter.toISOString(),
      daysLeft,
      expired: daysLeft < 0,
      expiresSoon: daysLeft < 21,
      names: x.subjectAltName ? x.subjectAltName.split(',').map((s) => s.trim().replace(/^DNS:/, '')) : [],
      issuer: x.issuer.replace(/\n/g, ', '),
      staging: /STAGING|Fake LE/i.test(x.issuer),
    };
  } catch (e) {
    return { exists: true, error: `Certificate not readable: ${e.message}` };
  }
}

async function dnsDiag(domainName) {
  const d = normDomain(domainName, true);
  const res = { domain: d, a: [], aaaa: [], ok: false, matches: null, message: '' };
  const r = new dns.Resolver({ timeout: 4000, tries: 2 });
  // a wildcard record answers any name, so a made-up label tells whether it exists
  const q = isWildcard(d) ? `wm-check.${d.slice(2)}` : d;
  try { res.a = await r.resolve4(q); } catch (_) { /* none */ }
  try { res.aaaa = await r.resolve6(q); } catch (_) { /* none */ }
  if (!res.a.length && !res.aaaa.length) {
    res.message = `DNS: ${d} cannot be resolved (no A/AAAA record). Please create the DNS record and wait for it to propagate.`;
    return res;
  }
  res.ok = true;
  const resolved = [...res.a, ...res.aaaa];
  if (config.publicIps.length) {
    res.matches = resolved.some((ip) => config.publicIps.includes(ip));
    res.message = res.matches
      ? `DNS: ${d} → ${resolved.join(', ')} (matches this server IP)`
      : `DNS: ${d} points to ${resolved.join(', ')}, but this server has ${config.publicIps.join(', ')}. The validation will probably fail.`;
  } else {
    res.message = `DNS: ${d} → ${resolved.join(', ')} (cannot compare with the server IP, PUBLIC_IPS is not set)`;
  }
  return res;
}

/** Connects to the proxy with SNI and validates what is really served. */
function verifyServed(domainName) {
  const d = normDomain(domainName, true);
  const sni = isWildcard(d) ? `wm-verify.${d.slice(2)}` : d;
  return new Promise((resolve) => {
    const [host] = config.proxyContainer.split(':');
    const sock = tls.connect({ host, port: 443, servername: sni, rejectUnauthorized: true, timeout: 8000 }, () => {
      const c = sock.getPeerCertificate();
      sock.end();
      resolve({ ok: true, domain: d, validTo: c.valid_to, issuer: c.issuer && c.issuer.O });
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, domain: d, error: 'Timeout during the TLS handshake' }); });
    sock.on('error', (e) => resolve({ ok: false, domain: d, error: e.code || e.message }));
  });
}

function certbotBase(extraMounts = []) {
  const image = loadRuntimes().tools.certbot.image; // built by ensureCertbotImage()
  fs.mkdirSync(config.LE_DIR, { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(config.ACME_DIR, '.well-known', 'acme-challenge'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(config.CERTBOT_WORK, { recursive: true, mode: 0o755 });
  fs.mkdirSync(config.CERTBOT_LOGS, { recursive: true, mode: 0o755 });
  return [
    'run', '--rm', '--name', `wm-certbot-${crypto.randomBytes(4).toString('hex')}`,
    '--label', 'drimzo.managed=true',
    '--read-only', '--tmpfs', '/tmp:rw,size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--memory', '256m', '--pids-limit', '100',
    '-v', `${config.LE_DIR}:/etc/letsencrypt`, '-v', `${config.ACME_DIR}:/var/www/acme`,
    '-v', `${config.CERTBOT_WORK}:/var/lib/letsencrypt`, '-v', `${config.CERTBOT_LOGS}:/var/log/letsencrypt`,
    ...extraMounts,
    image,
  ];
}

function hintFor(output) {
  const hints = [];
  if (/NXDOMAIN|DNS problem/i.test(output)) hints.push('Hint: The domain cannot be resolved publicly. Check the DNS record (A/AAAA).');
  if (/Timeout during connect|Connection refused|Connection reset/i.test(output)) hints.push('Hint: Port 80 is not reachable from outside. Check the firewall/router forwarding for port 80.');
  if (/unauthorized|Invalid response/i.test(output)) hints.push('Hint: Another server answers on the domain or the route is missing. DNS must point to this server.');
  if (/rateLimited|too many/i.test(output)) hints.push('Hint: Let\'s Encrypt rate limit reached. Try again later or use ACME_STAGING=true for testing.');
  return hints;
}

async function ensureCertbotImage(log) {
  await sites.ensureImage(loadRuntimes().tools.certbot, log);
}

/** Issues or expands a certificate and switches the vhost to HTTPS. `log(line)` receives progress. */
async function issue({ name, domains, email, siteId, dns: wantDns }, log) {
  if (!CERT_NAME_RE.test(name)) throw new ValidationError('Invalid certificate name');
  if (!Array.isArray(domains) || !domains.length || domains.length > 20) throw new ValidationError('At least one domain is required');
  const doms = [...new Set(domains.map((d) => normDomain(d, true)))];
  // wildcards can only be validated through DNS
  const viaDns = wantDns === true || doms.some(isWildcard);
  if (typeof email !== 'string' || !/^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/.test(email)) throw new ValidationError('A valid contact email is required');

  if (name === 'dashboard' && doms.some(isWildcard)) throw new ValidationError('The dashboard domain cannot be a wildcard');
  if (viaDns && !dnsFiles.status().configured) throw new ValidationError('DNS validation needs a DNS provider: set one up under System → DNS provider');
  if (name === 'dashboard' && (doms.length !== 1 || doms[0] !== getDashboardDomain())) {
    throw new ValidationError('The domain does not match the configured dashboard domain');
  }
  audit('cert.issue', { name, domains: doms });
  await ensureCertbotImage(log);
  log('Step 1/4: Check DNS');
  let dnsFailed = false;
  for (const d of doms) {
    const r = await dnsDiag(d);
    log(r.message);
    // with DNS validation the website does not have to be reachable yet: the records are only informative
    if (!viaDns && (!r.ok || r.matches === false)) dnsFailed = true;
  }
  if (dnsFailed) {
    log('Aborted: DNS check failed. No certificate was requested to spare rate limits.');
    return { ok: false, stage: 'dns' };
  }

  log('Step 2/4: Provide the HTTP route for validation');
  if (name === 'dashboard') await applyDashboard();
  else {
    const spec = sites.loadSpec(siteId);
    if (!spec) throw sites.httpError(404, 'Website is not known to the agent');
    if (!doms.every((d) => spec.domains.includes(d))) throw new ValidationError('Domains do not belong to the website');
    await sites.syncVhost(spec);
  }

  log(viaDns ? 'Step 3/4: Request certificate from Let\'s Encrypt (validation through DNS)' : 'Step 3/4: Request certificate from Let\'s Encrypt');
  if (viaDns) dnsFiles.syncHook();
  const args = [...certbotBase(viaDns ? dnsFiles.mount() : []), 'certonly', ...(viaDns ? dnsFiles.certbotHooks() : ['--webroot', '-w', '/var/www/acme']), '--cert-name', name,
    ...doms.flatMap((d) => ['-d', d]), '--email', email, '--agree-tos', '--no-eff-email', '--non-interactive', '--keep-until-expiring', '--expand'];
  if (config.acmeStaging) { args.splice(args.indexOf('certonly') + 1, 0, '--staging'); log('(ACME staging active: certificate is not publicly trusted)'); }
  let collected = '';
  const code = await dockerStream(args, (l) => { collected += `${l}\n`; log(l); }, { timeoutSec: viaDns ? 900 : 300 });
  if (code !== 0) {
    hintFor(collected).forEach(log);
    if (viaDns) log('Hint: Check the token of the DNS provider (System → DNS provider → Test) and that the domain is a zone of that account.');
    log(`Certificate request failed (exit code ${code}).`);
    return { ok: false, stage: 'certbot', code };
  }

  // certbot keeps the method of the last issue when it leaves a certificate that is not due as it is: tell what will really happen
  if (viaDns && !dnsFiles.isDnsCert(name)) log('Note: certbot kept the existing certificate, which keeps being renewed with its earlier validation method. DNS validation starts with the next certificate that has a changed list of names.');
  if (!viaDns && dnsFiles.isDnsCert(name)) log('Note: this certificate was issued through DNS validation and keeps being renewed that way; the DNS provider has to stay set up.');
  log('Step 4/4: Enable and verify HTTPS');
  if (name === 'dashboard') await applyDashboard(); else await sites.syncVhost(sites.loadSpec(siteId));
  const verify = [];
  for (const d of doms) {
    const v = await verifyServed(d);
    verify.push(v);
    log(v.ok ? `✔ HTTPS verified for ${d} (valid until ${v.validTo})` : `✘ HTTPS check for ${d} failed: ${v.error}`);
  }
  return { ok: verify.every((v) => v.ok), stage: 'done', verify, cert: certInfo(name) };
}

/** Renews all due certificates and reloads the proxy. */
async function renewAll(log) {
  audit('cert.renew', {});
  await ensureCertbotImage(log);
  let code;
  const viaDns = dnsFiles.dnsCerts();
  if (!viaDns.length) {
    const args = [...certbotBase(), 'renew', '--webroot', '-w', '/var/www/acme', '--non-interactive'];
    if (config.acmeStaging) args.splice(args.indexOf('renew') + 1, 0, '--staging');
    code = await dockerStream(args, log, { timeoutSec: 900 });
  } else {
    // certificates validated through DNS keep their hooks in the renewal file and need the credentials; the others use the web root.
    // Certbot is called per certificate, because `--webroot` on the command line would replace the stored method of the DNS ones.
    dnsFiles.syncHook();
    const names = fs.existsSync(path.join(config.LE_DIR, 'renewal'))
      ? fs.readdirSync(path.join(config.LE_DIR, 'renewal')).filter((f) => f.endsWith('.conf')).map((f) => f.slice(0, -5)).filter((n) => CERT_NAME_RE.test(n))
      : [];
    code = 0;
    for (const n of names) {
      const dnsCert = viaDns.includes(n);
      const args = [...certbotBase(dnsCert ? dnsFiles.mount() : []), 'renew', '--cert-name', n, ...(dnsCert ? [] : ['--webroot', '-w', '/var/www/acme']), '--non-interactive'];
      if (config.acmeStaging) args.splice(args.indexOf('renew') + 1, 0, '--staging');
      const c = await dockerStream(args, log, { timeoutSec: dnsCert ? 900 : 300 });
      if (c !== 0) code = c;
    }
  }
  if (await proxyRunning()) await docker(['exec', config.proxyContainer, 'nginx', '-s', 'reload']);
  const certs = {};
  for (const n of ['dashboard', ...sites.listSiteIds().map((i) => `site-${String(i).padStart(3, '0')}`)]) {
    const c = certInfo(n);
    if (c.exists) certs[n] = { daysLeft: c.daysLeft, notAfter: c.notAfter };
  }
  return { ok: code === 0, code, certs };
}

/** Runs the DNS hook script in a throw-away container of the certificate tool. Returns { ok, output }. */
async function dnsRun(hookArgs, log) {
  await ensureCertbotImage(log || (() => {}));
  dnsFiles.syncHook();
  const args = certbotBase(dnsFiles.mount());
  args.splice(args.length - 1, 0, '--entrypoint', 'python3'); // before the image name
  args.push('/dns/dns_hook.py', ...hookArgs);
  let out = '';
  const code = await dockerStream(args, (l) => { out += `${l}\n`; if (log) log(l); }, { timeoutSec: 120 });
  return { ok: code === 0, output: out.trim() };
}

/** Checks the stored token. */
async function dnsTest(log) {
  if (!dnsFiles.status().configured) throw new ValidationError('No DNS provider is set up');
  return dnsRun(['test'], log);
}

/** Sets A/AAAA records for the given names to the addresses of this server (or `ips`). */
async function dnsRecords({ domains, ips }, log) {
  if (!dnsFiles.status().configured) throw new ValidationError('No DNS provider is set up');
  const addrs = (Array.isArray(ips) && ips.length ? ips : config.publicIps).map(String);
  if (!addrs.length) throw new ValidationError('The addresses of this server are not known (PUBLIC_IPS in .env)');
  if (!addrs.every((a) => net.isIP(a))) throw new ValidationError('Invalid IP address');
  if (!Array.isArray(domains) || !domains.length || domains.length > 20) throw new ValidationError('At least one domain is required');
  const pairs = [];
  for (const d of [...new Set(domains.map((x) => normDomain(x, true)))]) for (const a of addrs) pairs.push(d, a);
  audit('dns.records', { domains, ips: addrs });
  return dnsRun(['address', ...pairs], log);
}

module.exports = { dnsTest, dnsRecords, issue, renewAll, certInfo, dnsDiag, verifyServed, getDashboardDomain, setDashboardDomain, applyDashboard, applyRealIp };
