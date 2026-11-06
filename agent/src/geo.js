'use strict';
/**
 * Country blocking without a third-party GeoIP database: the five Regional Internet Registries publish
 * which country every IPv4/IPv6 allocation was registered in ("delegated-*-extended-latest"). The agent downloads
 * these public files, stores one CIDR list per country, and renders per-website nginx `geo` maps from them.
 * Accuracy is the registration country: VPNs, mobile roaming and multinational companies can differ.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { config } = require('./config');
const { audit } = require('./audit');

// every registry offers its file under more than one address; the next one is tried when a download fails
const REGISTRIES = [
  { name: 'RIPE NCC', urls: ['https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest', 'https://ftp.ripe.net/ripe/stats/delegated-ripencc-extended-latest'] },
  { name: 'ARIN', urls: ['https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest'] },
  { name: 'APNIC', urls: ['https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest', 'https://ftp.apnic.net/pub/stats/apnic/delegated-apnic-extended-latest', 'https://ftp.apnic.net/apnic/stats/apnic/delegated-apnic-extended-latest'] },
  { name: 'LACNIC', urls: ['https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest'] },
  { name: 'AFRINIC', urls: ['https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest'] },
];
const SOURCES = REGISTRIES.flatMap((r) => r.urls);
const MAX_BYTES = 150 * 1024 * 1024;
const GEO_DIR = path.join(config.DATA_DIR, 'geo');
const MAP_DIR = path.join(config.PROXY_CONF_DIR, 'geo');
const CC_RE = /^[A-Z]{2}$/;
// never blocked, whatever the rules say: the host itself, Docker and typical LAN ranges
const ALWAYS_ALLOWED = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '::1/128', 'fc00::/7'];

/** A readable reason for a failed request (Node reports some failures as an AggregateError with an empty message). */
function describeError(e) {
  if (!e) return 'unknown error';
  const parts = [];
  const add = (x) => {
    if (!x) return;
    const t = [x.code, x.message].filter((v, i, a) => v && a.indexOf(v) === i).join(' ');
    if (t) parts.push(x.address ? `${t} (${x.address})` : t);
  };
  add(e);
  if (Array.isArray(e.errors)) e.errors.forEach(add);
  return [...new Set(parts)].join('; ') || e.name || 'unknown error';
}

async function fetchWithRetry(urls) {
  let last = null;
  for (const url of urls) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await fetchText(url);
      } catch (e) {
        last = Object.assign(new Error(`${new URL(url).host}: ${describeError(e)}`), { cause: e });
        if (/^HTTP 4\d\d/.test(e.message || '')) break; // wrong address, no point in retrying it
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  throw last;
}

/** Downloads a text file over https (follows a few redirects, size-capped). */
function fetchText(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    // IPv4 only: the Docker egress network has no IPv6 route, and a dual-stack attempt then fails with an empty AggregateError
    const req = https.get(url, { family: 4, timeout: 120000, headers: { 'User-Agent': 'webmanager' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url);
        if (next.protocol !== 'https:') return reject(new Error('Redirect to an unencrypted address rejected'));
        return resolve(fetchText(next.toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} from ${new URL(url).host}`)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(new Error('File is too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
      res.on('error', reject);
      return undefined;
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout at ${new URL(url).host}`)));
    req.on('error', reject);
  });
}

const ipv4ToInt = (s) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const intToIpv4 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** Splits an IPv4 range (start address + number of addresses) into the minimal list of CIDR blocks. */
function rangeToCidrs(startIp, count) {
  const out = [];
  let start = ipv4ToInt(startIp);
  let left = count;
  while (left > 0) {
    // largest block that is aligned at `start` and fits into what is left
    let size = start === 0 ? 2 ** 32 : start & -start;
    if (size < 0) size = 2 ** 31;
    while (size > left) size /= 2;
    out.push(`${intToIpv4(start)}/${32 - Math.log2(size)}`);
    start += size;
    left -= size;
  }
  return out;
}

/** Adds the allocations of one "delegated" file to `byCountry` (Map code -> Set of CIDR strings). */
function parseDelegated(text, byCountry) {
  let lines = 0;
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const f = line.split('|');
    if (f.length < 7 || (f[2] !== 'ipv4' && f[2] !== 'ipv6')) continue;
    const cc = f[1];
    if (!CC_RE.test(cc) || (f[6] !== 'allocated' && f[6] !== 'assigned')) continue;
    let set = byCountry.get(cc);
    if (!set) { set = new Set(); byCountry.set(cc, set); }
    if (f[2] === 'ipv4') {
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(f[3]) || !/^\d+$/.test(f[4])) continue;
      for (const c of rangeToCidrs(f[3], Number(f[4]))) set.add(c);
    } else {
      if (!/^[0-9a-fA-F:]+$/.test(f[3]) || !/^\d{1,3}$/.test(f[4]) || Number(f[4]) > 128) continue;
      set.add(`${f[3].toLowerCase()}/${f[4]}`);
    }
    lines++;
  }
  return lines;
}

function status() {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(GEO_DIR, 'meta.json'), 'utf8'));
    return { ready: true, updatedAt: meta.updatedAt, countries: meta.countries, ranges: meta.ranges };
  } catch (_) {
    return { ready: false, updatedAt: null, countries: 0, ranges: 0 };
  }
}

/** Downloads all registry files and replaces the stored country lists. */
async function update() {
  const byCountry = new Map();
  let used = 0;
  const errors = [];
  for (const reg of REGISTRIES) {
    try {
      parseDelegated(await fetchWithRetry(reg.urls), byCountry);
      used++;
    } catch (e) {
      errors.push(`${reg.name} – ${e.message}`);
    }
  }
  // a partial download would silently un-block whole regions, so every registry must have answered
  if (used !== REGISTRIES.length) {
    audit('geo.update_failed', { errors });
    throw Object.assign(new Error(`GeoIP data could not be loaded completely (${errors.join('; ')})`), { status: 502 });
  }
  const tmp = `${GEO_DIR}.new`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o755 });
  let ranges = 0;
  for (const [cc, set] of byCountry) {
    fs.writeFileSync(path.join(tmp, `${cc}.txt`), `${[...set].join('\n')}\n`, { mode: 0o644 });
    ranges += set.size;
  }
  fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify({ updatedAt: new Date().toISOString(), countries: byCountry.size, ranges }), { mode: 0o644 });
  fs.rmSync(`${GEO_DIR}.old`, { recursive: true, force: true });
  if (fs.existsSync(GEO_DIR)) fs.renameSync(GEO_DIR, `${GEO_DIR}.old`);
  fs.renameSync(tmp, GEO_DIR);
  fs.rmSync(`${GEO_DIR}.old`, { recursive: true, force: true });
  audit('geo.update', { countries: byCountry.size, ranges });
  return status();
}

/**
 * Body of an nginx `geo` block for one website: value 1 = blocked.
 * mode "block": listed countries are blocked; mode "allow": only listed countries are let in.
 */
function renderMap(mode, countries, dir = GEO_DIR) {
  const blockedValue = mode === 'allow' ? 0 : 1;
  const lines = [`default ${mode === 'allow' ? 1 : 0};`];
  for (const n of ALWAYS_ALLOWED) lines.push(`${n} 0;`);
  const seen = new Set(ALWAYS_ALLOWED);
  for (const cc of countries) {
    if (!CC_RE.test(cc)) throw new Error(`Invalid country code: ${cc}`);
    let text = '';
    try { text = fs.readFileSync(path.join(dir, `${cc}.txt`), 'utf8'); } catch (_) { continue; } // country without allocations
    for (const cidr of text.split('\n')) {
      if (cidr && !seen.has(cidr)) { seen.add(cidr); lines.push(`${cidr} ${blockedValue};`); }
    }
  }
  return `# Generated by WebManager (${mode}: ${countries.join(' ')})\n${lines.join('\n')}\n`;
}

const mapFile = (siteName) => path.join(MAP_DIR, `${siteName}.map`);

/** Writes (or removes) the nginx map of a website. Throws when country data is needed but missing. */
function writeSiteMap(siteName, mode, countries) {
  if (mode === 'off' || !countries.length) {
    fs.rmSync(mapFile(siteName), { force: true });
    return false;
  }
  if (!status().ready) {
    throw Object.assign(new Error('The GeoIP data is missing. Please load the country data first under “Access rules” or “System”.'), { status: 409 });
  }
  fs.mkdirSync(MAP_DIR, { recursive: true, mode: 0o755 });
  const tmp = `${mapFile(siteName)}.tmp`;
  fs.writeFileSync(tmp, renderMap(mode, countries), { mode: 0o644 });
  fs.renameSync(tmp, mapFile(siteName));
  return true;
}

module.exports = { update, status, renderMap, writeSiteMap, rangeToCidrs, parseDelegated, describeError, SOURCES, REGISTRIES, ALWAYS_ALLOWED, MAP_DIR };
