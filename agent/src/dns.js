'use strict';
/**
 * Files of the DNS provider connection (Cloudflare, Hetzner). The token lives only here, in a file that only root of the host can
 * read (0600), and is mounted read-only into the throw-away certificate container when a certificate is requested or renewed with
 * DNS validation (wildcards) or when DNS records are set. The dashboard never sees it again after saving.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { ValidationError, CERT_NAME_RE } = require('./validate');

const DIR = path.join(config.DATA_DIR, 'runtime', 'dns');
const CRED = path.join(DIR, 'credentials.json');
const RENEWAL_DIR = path.join(config.LE_DIR, 'renewal');
const HOOK_SRC = () => path.join(config.TEMPLATES_DIR, 'dns', 'dns_hook.py');
const PROVIDERS = ['cloudflare', 'hetzner'];

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o755 });
  fs.chmodSync(DIR, 0o755);
}

function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeAtomic(file, content, mode) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/** Validates and stores the credentials. `wait` = seconds to wait for the name servers after a TXT record was set. */
function save({ provider, token, wait }) {
  if (!PROVIDERS.includes(provider)) throw new ValidationError('Unknown DNS provider');
  if (typeof token !== 'string' || !/^[\x21-\x7e]{8,500}$/.test(token)) throw new ValidationError('The API token looks invalid (8 to 500 visible characters, no spaces)');
  const w = wait === undefined ? 30 : Number(wait);
  if (!Number.isInteger(w) || w < 0 || w > 300) throw new ValidationError('Wait time: 0 to 300 seconds');
  ensureDir();
  writeAtomic(CRED, JSON.stringify({ provider, token, wait: w }), 0o600);
  syncHook();
}

function clear() {
  fs.rmSync(CRED, { force: true });
}

/** Copies the hook script next to the credentials, so that the container sees exactly the script of this version. */
function syncHook() {
  ensureDir();
  const src = fs.readFileSync(HOOK_SRC());
  const dest = path.join(DIR, 'dns_hook.py');
  const same = (() => { try { return fs.readFileSync(dest).equals(src); } catch (_) { return false; } })();
  if (!same) writeAtomic(dest, src, 0o644);
}

/** What the dashboard may know: whether a connection exists and which provider, never the token. */
function status() {
  const c = read(CRED, null);
  return { configured: !!(c && PROVIDERS.includes(c.provider) && c.token), provider: c && PROVIDERS.includes(c.provider) ? c.provider : null, wait: c && Number.isInteger(c.wait) ? c.wait : 30, dnsCerts: dnsCerts() };
}

/**
 * Does the renewal file of certbot say that the certificate is validated through our DNS hook? The file is the truth: certbot keeps the
 * method of the last issue even when a later request left the certificate as it was.
 */
function usesDnsHook(conf) {
  return /^authenticator\s*=\s*manual\s*$/m.test(conf) && /^manual_auth_hook\s*=.*\/dns\/dns_hook\.py/m.test(conf);
}

/** Names of the certificates that are renewed by DNS validation (read from the renewal files). */
function dnsCerts() {
  let files;
  try { files = fs.readdirSync(RENEWAL_DIR); } catch (_) { return []; }
  const out = [];
  for (const f of files.sort()) {
    if (!f.endsWith('.conf')) continue;
    const name = f.slice(0, -5);
    if (!CERT_NAME_RE.test(name)) continue;
    try { if (usesDnsHook(fs.readFileSync(path.join(RENEWAL_DIR, f), 'utf8'))) out.push(name); } catch (_) { /* unreadable: not ours */ }
  }
  return out;
}

const isDnsCert = (name) => dnsCerts().includes(name);

/** `docker run` mount for the hook container. */
const mount = () => ['-v', `${DIR}:/dns:ro`];

/** Certbot hook arguments for the DNS validation. */
const certbotHooks = () => ['--manual', '--preferred-challenges', 'dns', '--manual-auth-hook', 'python3 /dns/dns_hook.py auth', '--manual-cleanup-hook', 'python3 /dns/dns_hook.py cleanup'];

module.exports = { save, clear, status, dnsCerts, isDnsCert, usesDnsHook, syncHook, mount, certbotHooks, PROVIDERS, DIR };
