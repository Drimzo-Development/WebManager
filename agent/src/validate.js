'use strict';
const crypto = require('crypto');
const net = require('net');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

const TYPES = ['static', 'php', 'laravel', 'node', 'express', 'next', 'custom'];
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const BLOCKED_ENV = /^(PATH|HOME|USER|PORT|HOSTNAME|PWD|SHELL|LD_.*|DOCKER_.*|BASH_ENV|ENV|IFS)$/;
const SCRIPT_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,99}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const CERT_NAME_RE = /^(site-\d{3,5}|dashboard)$/;

function int(v, min, max, label) {
  const n = typeof v === 'string' && /^-?\d+$/.test(v) ? parseInt(v, 10) : v;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${label} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function num(v, min, max, label) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
    throw new ValidationError(`${label} must be a number between ${min} and ${max}`);
  }
  return n;
}

function cmd(v, label) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.length > 1000 || v.includes('\0')) {
    throw new ValidationError(`${label} is invalid (max. 1000 characters)`);
  }
  return v.trim();
}

/** A host name. A wildcard (`*.example.com`) is only accepted where the caller says so (websites; certificates by DNS validation). */
function domain(v, allowWildcard = false) {
  if (typeof v !== 'string') throw new ValidationError('Domain invalid');
  const d = v.trim().toLowerCase().replace(/\.$/, '');
  const base = allowWildcard && d.startsWith('*.') ? d.slice(2) : d;
  if (!DOMAIN_RE.test(base)) throw new ValidationError(`Invalid domain: ${String(v).slice(0, 80)}`);
  return d;
}

const isWildcard = (d) => typeof d === 'string' && d.startsWith('*.');

function docroot(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || !/^[A-Za-z0-9_\-./]{1,100}$/.test(v)) {
    throw new ValidationError('Document root contains invalid characters');
  }
  const parts = v.split('/').filter((p) => p !== '' && p !== '.');
  if (v.startsWith('/') || parts.includes('..')) {
    throw new ValidationError('Document root must be relative to the project directory');
  }
  return parts.join('/');
}

function envMap(v) {
  const out = {};
  if (v === undefined || v === null) return out;
  if (typeof v !== 'object' || Array.isArray(v)) throw new ValidationError('Environment variables must be an object');
  const keys = Object.keys(v);
  if (keys.length > 200) throw new ValidationError('Too many environment variables (max. 200)');
  for (const k of keys) {
    if (!ENV_KEY_RE.test(k)) throw new ValidationError(`Invalid variable name: ${k.slice(0, 40)}`);
    if (BLOCKED_ENV.test(k)) throw new ValidationError(`Variable name is reserved: ${k}`);
    const val = v[k];
    if (typeof val !== 'string' || val.length > 4096 || /[\0\r\n]/.test(val)) {
      throw new ValidationError(`Value of ${k} is invalid (single line, max. 4096 characters)`);
    }
    out[k] = val;
  }
  return out;
}

/** Validates and normalises a website specification. `runtimesDoc` is the parsed runtimes.json. */
function validateSpec(raw, runtimesDoc) {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Specification missing');
  const s = {};
  s.id = int(raw.id, 1, 40000, 'id');
  if (!TYPES.includes(raw.type)) throw new ValidationError('Unknown website type');
  s.type = raw.type;
  const rt = Object.prototype.hasOwnProperty.call(runtimesDoc.runtimes, raw.runtime) ? runtimesDoc.runtimes[raw.runtime] : null;
  if (!rt) throw new ValidationError('Runtime template is not approved');
  if (!rt.types.includes(s.type)) throw new ValidationError('Runtime template does not match the website type');
  s.runtime = raw.runtime;
  s.internalPort = rt.fixedPort ? rt.fixedPort : int(raw.internalPort, 1024, 65535, 'Internal port');
  s.docroot = docroot(raw.docroot);
  s.memoryMb = int(raw.memoryMb ?? 512, 64, 16384, 'Memory (MB)');
  s.cpus = num(raw.cpus ?? 1, 0.1, 16, 'CPU-Limit');
  s.pids = int(raw.pids ?? 256, 16, 4096, 'Prozesslimit');
  s.startCommand = cmd(raw.startCommand, 'Start command');
  s.installCommand = cmd(raw.installCommand, 'Install command');
  s.buildCommand = cmd(raw.buildCommand, 'Build command');
  s.env = envMap(raw.env);
  const doms = Array.isArray(raw.domains) ? raw.domains.map((d) => domain(d, true)) : [];
  if (doms.length > 20) throw new ValidationError('Too many domains (max. 20)');
  s.domains = [...new Set(doms)];
  s.autostart = raw.autostart !== false;
  s.webserverConf = webserverConf(raw.webserverConf);
  s.gate = raw.gate === true;
  s.gateBypass = bypassPaths(raw.gateBypass);
  s.maintenance = raw.maintenance === true;
  s.maintenanceAllow = ipList(raw.maintenanceAllow);
  s.ipAllow = netList(raw.ipAllow);
  s.ipDeny = netList(raw.ipDeny);
  s.database = databaseSpec(raw.database, runtimesDoc);
  s.secHeaders = secHeaders(raw.secHeaders);
  s.wafMode = ['off', 'detect', 'block'].includes(raw.wafMode) ? raw.wafMode : 'off';
  s.wafCategories = (Array.isArray(raw.wafCategories) ? raw.wafCategories : []).filter((c, i, a) => WAF_CATEGORIES.includes(c) && a.indexOf(c) === i);
  s.wafExempt = bypassPaths(raw.wafExempt);
  s.geoMode = ['off', 'block', 'allow'].includes(raw.geoMode) ? raw.geoMode : 'off';
  s.geoCountries = countryList(raw.geoCountries);
  if (s.geoMode !== 'off' && !s.geoCountries.length) throw new ValidationError('At least one country is required for the country rule');
  s.connLimit = int(raw.connLimit ?? 0, 0, 10000, 'Connections per IP');
  s.rateRps = int(raw.rateRps ?? 0, 0, 1000, 'Requests per second');
  s.rateBurst = int(raw.rateBurst ?? 50, 0, 5000, 'Burst');
  return s;
}

/** Public URL paths that skip the password prompt: "/api/" = everything below, "/health" = exactly that URL. */
function bypassPaths(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 20) throw new ValidationError('Path exceptions: at most 20 entries');
  const out = [];
  for (const p of v) {
    if (typeof p !== 'string' || !/^\/[A-Za-z0-9_\-./]{1,100}$/.test(p) || p.includes('..') || p.includes('//')) {
      throw new ValidationError(`Invalid path: ${String(p).slice(0, 60)}`);
    }
    out.push(p);
  }
  return [...new Set(out)];
}

function ipList(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 20) throw new ValidationError('IP list: at most 20 entries');
  const out = v.map((x) => {
    if (typeof x !== 'string' || x.includes('%') || net.isIP(x.trim()) === 0) throw new ValidationError(`Invalid IP address: ${String(x).slice(0, 60)}`);
    return x.trim();
  });
  return [...new Set(out)];
}

/** True for a network whose prefix is so short that it covers (half of) the internet. */
function tooBroad(entry) {
  const [addr, prefix] = String(entry).split('/');
  return prefix !== undefined && Number(prefix) < (net.isIP(addr) === 4 ? 8 : 16);
}

/** Optional per-website database; credentials are generated by the dashboard, validated here before they reach docker. */
function databaseSpec(v, doc) {
  if (v === undefined || v === null || v === false) return null;
  if (typeof v !== 'object') throw new ValidationError('Database details invalid');
  const dbs = doc.databases || {};
  if (!Object.prototype.hasOwnProperty.call(dbs, v.engine)) throw new ValidationError('Database type is not approved');
  const ident = /^[a-z][a-z0-9_]{0,31}$/;
  const secret = /^[A-Za-z0-9]{16,128}$/;
  if (!ident.test(String(v.name)) || !ident.test(String(v.user))) throw new ValidationError('Invalid database or user name');
  if (!secret.test(String(v.password)) || (v.engine === 'mariadb' && !secret.test(String(v.rootPassword)))) throw new ValidationError('Invalid database password');
  let external = null;
  if (v.external) {
    const allow = netList(v.external.allow);
    if (!allow.length) throw new ValidationError('At least one allowed address is required for external access');
    if (allow.some(tooBroad)) throw new ValidationError('A network for external database access is too large (at least /8 for IPv4, /16 for IPv6)');
    external = { allow };
  }
  return { external, engine: v.engine, name: v.name, user: v.user, password: v.password, rootPassword: v.engine === 'mariadb' ? v.rootPassword : '', memoryMb: int(v.memoryMb ?? 512, 128, 8192, 'Database memory (MB)') };
}

const WAF_CATEGORIES = ['sqli', 'xss', 'traversal', 'rce', 'probe', 'scanner'];
const CSP_RE = /^[A-Za-z0-9 ;:'\-_.*/=,+%?&#!~()]{0,1500}$/;

/** Security response headers; returns null when nothing is switched on. Only fixed, validated values reach nginx. */
function secHeaders(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new ValidationError('Security headers invalid');
  const referrers = ['off', 'no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin'];
  const out = {
    hsts: v.hsts === true,
    xfo: ['off', 'sameorigin', 'deny'].includes(v.xfo) ? v.xfo : 'off',
    nosniff: v.nosniff === true,
    referrer: referrers.includes(v.referrer) ? v.referrer : 'off',
    permissions: v.permissions === true,
    csp: typeof v.csp === 'string' ? v.csp.trim() : '',
    cspReportOnly: v.cspReportOnly === true,
  };
  if (out.csp && !CSP_RE.test(out.csp)) throw new ValidationError('Content-Security-Policy contains invalid characters');
  const any = out.hsts || out.xfo !== 'off' || out.nosniff || out.referrer !== 'off' || out.permissions || out.csp;
  return any ? out : null;
}

/** ISO 3166 alpha-2 country codes for the geo rule. */
function countryList(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 260) throw new ValidationError('Too many countries');
  const out = v.map((x) => {
    if (typeof x !== 'string' || !/^[A-Z]{2}$/.test(x)) throw new ValidationError(`Invalid country code: ${String(x).slice(0, 10)}`);
    return x;
  });
  return [...new Set(out)].sort();
}

/** IP addresses or CIDR networks (IPv4/IPv6) for allow/deny rules. */
function netList(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 100) throw new ValidationError('IP rules: at most 100 entries');
  const out = v.map((x) => {
    const t = typeof x === 'string' ? x.trim() : '';
    const [addr, prefix, extra] = t.split('/');
    const kind = net.isIP(addr || '');
    // net.isIP() accepts IPv6 zone IDs (fe80::1%eth0); nginx does not
    if (!kind || t.includes('%') || extra !== undefined || (prefix !== undefined && (!/^[0-9]{1,3}$/.test(prefix) || Number(prefix) > (kind === 4 ? 32 : 128)))) {
      throw new ValidationError(`Invalid IP address or network: ${String(x).slice(0, 60)}`);
    }
    return t;
  });
  return [...new Set(out)];
}

/** Optional custom nginx.conf for static/php sites ('' = managed default); syntax is checked with `nginx -t` before use. */
function webserverConf(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.length > 65536 || v.includes('\0')) {
    throw new ValidationError('Web server configuration is invalid (max. 64 KB)');
  }
  return v.replace(/\r\n/g, '\n');
}

/** Hash over everything that requires re-creating the container when it changes. */
function containerHash(spec, runtimesDoc, extra = '') {
  const rt = runtimesDoc.runtimes[spec.runtime];
  const data = {
    id: spec.id, type: spec.type, image: rt.image, digest: rt.digest || '', port: spec.internalPort,
    docroot: spec.docroot, memoryMb: spec.memoryMb, cpus: spec.cpus, pids: spec.pids,
    start: spec.startCommand, env: Object.keys(spec.env).sort().map((k) => [k, spec.env[k]]), extra,
  };
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
}

function siteName(id) { return `site-${String(id).padStart(3, '0')}`; }

function parseSiteId(v) {
  const m = /^site-(\d{3,5})$/.exec(String(v));
  const n = m ? parseInt(m[1], 10) : /^\d{1,5}$/.test(String(v)) ? parseInt(v, 10) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 40000) throw new ValidationError('Invalid website ID');
  return n;
}

// Fixed scripts; all variable parts arrive through validated environment variables, never through the shell text.
const GIT_SYNC_SCRIPT = `set -e
g() { if [ -n "$GIT_AUTH" ]; then git -c "http.extraHeader=Authorization: Basic $GIT_AUTH" "$@"; else git "$@"; fi; }
if [ -d .git ]; then
  git remote set-url origin "$GIT_URL"
  if [ -n "$GIT_BRANCH" ]; then g fetch --depth 1 origin "$GIT_BRANCH"; else g fetch --depth 1 origin HEAD; fi
  git reset --hard FETCH_HEAD
else
  rm -rf .wm-clone
  if [ -n "$GIT_BRANCH" ]; then g clone --depth 1 --branch "$GIT_BRANCH" -- "$GIT_URL" .wm-clone; else g clone --depth 1 -- "$GIT_URL" .wm-clone; fi
  cp -a .wm-clone/. .
  rm -rf .wm-clone
fi
git log -1 --format='State: %h %s' 2>/dev/null || true
echo "Done."`;

const EXTRACT_SCRIPT = `set -e
[ -f "$ARCH" ] || { echo "Archive $ARCH not found"; exit 1; }
rm -rf .wm-extract && mkdir .wm-extract
case "$ARCH" in
  *.zip) unzip -q -o "$ARCH" -d .wm-extract ;;
  *) tar -xzf "$ARCH" -C .wm-extract ;;
esac
src=.wm-extract
if [ "$STRIP" = "1" ]; then
  n=$(ls -A .wm-extract | wc -l)
  if [ "$n" = "1" ]; then only=$(ls -A .wm-extract); [ -d ".wm-extract/$only" ] && src=".wm-extract/$only"; fi
fi
cp -a "$src"/. .
rm -rf .wm-extract "$ARCH"
echo "Extracted. Contents of $src were copied into the project directory."`;

function validateExec(raw) {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Invalid request');
  const timeout = int(raw.timeoutSec ?? 1800, 10, 3600, 'Timeout');
  const jobId = int(raw.jobId, 1, 2147483647, 'jobId');
  switch (raw.kind) {
    case 'npm': {
      const sub = raw.sub;
      let args;
      if (sub === 'install') args = ['install', '--no-audit', '--no-fund'];
      else if (sub === 'ci') args = ['ci', '--no-audit', '--no-fund'];
      else if (sub === 'run') {
        if (typeof raw.script !== 'string' || !SCRIPT_RE.test(raw.script)) throw new ValidationError('Invalid script name');
        args = ['run', raw.script];
      } else throw new ValidationError('npm command not allowed');
      return { kind: 'npm', argv: ['npm', ...args], timeout, jobId };
    }
    case 'shell': {
      const c = cmd(raw.command, 'Command');
      if (!c) throw new ValidationError('Command is empty');
      return { kind: 'shell', argv: ['sh', '-c', c], timeout, jobId };
    }
    case 'gitsync': {
      // Clone (first time) or update (later) the repository into the project directory.
      if (typeof raw.url !== 'string' || !/^https:\/\/[A-Za-z0-9._~:@%/+=?&#-]{4,500}$/.test(raw.url)) {
        throw new ValidationError('Only https:// repository URLs are allowed');
      }
      const env = { GIT_URL: raw.url, GIT_BRANCH: '', GIT_AUTH: '' };
      if (raw.branch) {
        if (typeof raw.branch !== 'string' || !BRANCH_RE.test(raw.branch) || raw.branch.includes('..')) {
          throw new ValidationError('Invalid branch');
        }
        env.GIT_BRANCH = raw.branch;
      }
      if (raw.token) {
        if (typeof raw.token !== 'string' || !/^[\x21-\x7e]{1,300}$/.test(raw.token)) throw new ValidationError('Invalid access token');
        const user = raw.username || 'x-access-token';
        if (typeof user !== 'string' || !/^[A-Za-z0-9._@-]{1,100}$/.test(user)) throw new ValidationError('Invalid username');
        env.GIT_AUTH = Buffer.from(`${user}:${raw.token}`).toString('base64');
      }
      return { kind: 'gitsync', argv: ['-c', GIT_SYNC_SCRIPT], env, label: `git sync ${raw.url}${env.GIT_BRANCH ? ` (${env.GIT_BRANCH})` : ''}`, timeout, jobId };
    }
    case 'extract': {
      if (typeof raw.archive !== 'string' || !/^\.?[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(zip|tar\.gz|tgz)$/.test(raw.archive) || raw.archive.includes('..')) {
        throw new ValidationError('Invalid archive name (allowed: .zip, .tar.gz, .tgz in the project directory)');
      }
      const env = { ARCH: raw.archive, STRIP: raw.strip === false ? '0' : '1' };
      return { kind: 'extract', argv: ['-c', EXTRACT_SCRIPT], env, label: `Extract archive: ${raw.archive}`, timeout, jobId };
    }
    default:
      throw new ValidationError('Unknown task kind');
  }
}

module.exports = {
  ValidationError, TYPES, DOMAIN_RE, isWildcard, CERT_NAME_RE, validateSpec, validateExec, containerHash,
  siteName, parseSiteId, domain, int, SCRIPT_RE, netList, WAF_CATEGORIES,
};
