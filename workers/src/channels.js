'use strict';
/**
 * Notification channels besides e-mail: generic webhook, ntfy and Telegram. Everything that builds or validates a request is
 * pure (testable); the only network access is `post()`, which refuses targets inside the server (loopback, link-local, cloud
 * metadata) at connect time and never follows redirects.
 */
const https = require('https');
const dns = require('dns');
const net = require('net');
const crypto = require('crypto');

const TIMEOUT_MS = 10000;
const MAX_TEXT = 1800; // Discord allows 2000 characters, Telegram 4096

const clip = (s, n = MAX_TEXT) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** True for addresses a notification must never be sent to (this host, link-local incl. the cloud metadata address). */
function isBlockedAddress(ip) {
  let a = String(ip || '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  if (net.isIPv4(a)) {
    const [o1, o2] = a.split('.').map(Number);
    // 172.16/12: Docker networks of this stack; 100.64/10: carrier-grade NAT. 10/8 and 192.168/16 stay allowed (self-hosted ntfy/webhooks in the LAN).
    return o1 === 0 || o1 === 127 || (o1 === 169 && o2 === 254) || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 100 && o2 >= 64 && o2 <= 127);
  }
  if (net.isIPv6(a)) return a === '::' || a === '::1' || /^fe[89ab]/.test(a) || /^f[cd]/.test(a);
  return true; // not an address at all
}

/**
 * Validates the address of a webhook / ntfy topic: https only, no credentials in the address, a real host name (no bare names
 * such as `agent` or `localhost`, which would reach services inside the stack). Returns the parsed URL or throws.
 */
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (_) { throw new Error('Invalid address.'); }
  if (u.protocol !== 'https:') throw new Error('The address must start with https://.');
  if (u.username || u.password) throw new Error('The address must not contain credentials (use the token field).');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('This address is not allowed.');
  } else if (!host.includes('.') || /\.(internal|local|localhost)$/i.test(host)) {
    throw new Error('Please use a full domain name.');
  }
  return u;
}

/** dns.lookup that refuses internal targets (also protects against a name that is switched to 127.0.0.1 later). */
function safeLookup(host, options, cb) {
  dns.lookup(host, options, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (list.some((x) => isBlockedAddress(x.address))) return cb(new Error('The target address is not allowed.'));
    return cb(null, address, family);
  });
}

/** POST with a timeout; resolves { status } for 2xx and rejects with a short, readable message otherwise. */
function post(urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = checkUrl(urlStr);
    const data = Buffer.from(body);
    const req = https.request(u, {
      method: 'POST',
      headers: { 'User-Agent': 'WebManager', 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers },
      lookup: safeLookup,
      timeout: TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { if (buf.length < 400) buf += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode });
        const hint = buf.replace(/\s+/g, ' ').trim().slice(0, 120);
        return reject(new Error(`The server answered with HTTP ${res.statusCode}${hint ? ` (${hint})` : ''}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', (e) => reject(new Error(e.message)));
    req.end(data);
  });
}

/** message = { brand, subject, text, kind, facts: [[label, value]], title } */
function plain(m) {
  const facts = (m.facts || []).filter((f) => f[1]).map(([a, b]) => `${a}: ${b}`);
  return clip(facts.length ? `${m.text}\n\n${facts.join('\n')}` : m.text);
}

const TITLE = (m) => clip(`[${m.brand || 'WebManager'}] ${m.subject}`, 200);

/** Generic webhook: JSON with the structured data plus `text`/`content`, which Slack, Mattermost and Discord accept directly. */
function webhookRequest(url, secret, m, now = new Date()) {
  const summary = `${TITLE(m)}\n${plain(m)}`;
  const body = JSON.stringify({
    source: 'webmanager',
    kind: m.kind || 'info',
    title: m.title || m.subject,
    subject: m.subject,
    message: m.text,
    facts: Object.fromEntries((m.facts || []).filter((f) => f[1]).map(([a, b]) => [a, String(b)])),
    time: now.toISOString(),
    text: clip(summary),
    content: clip(summary),
  });
  const headers = {};
  if (secret) headers['X-WebManager-Signature'] = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  return { url, body, headers };
}

const NTFY_PRIORITY = { error: 4, warn: 3, ok: 3, info: 3 };
const NTFY_TAGS = { error: ['rotating_light'], warn: ['warning'], ok: ['white_check_mark'], info: ['information_source'] };

/** ntfy JSON publishing (UTF-8 safe, unlike header based publishing): the topic is the last path segment of the address. */
function ntfyRequest(urlStr, token, m) {
  const u = checkUrl(urlStr);
  const topic = u.pathname.replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) throw new Error('The address must end with the topic, e.g. https://ntfy.sh/my-topic');
  const kind = NTFY_PRIORITY[m.kind] ? m.kind : 'info';
  const body = JSON.stringify({ topic, title: TITLE(m), message: plain(m), priority: NTFY_PRIORITY[kind], tags: NTFY_TAGS[kind] });
  return { url: `${u.origin}/`, body, headers: token ? { Authorization: `Bearer ${token}` } : {} };
}

const TG_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const TG_CHAT = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,63})$/;
const validTelegram = (token, chat) => TG_TOKEN.test(String(token)) && TG_CHAT.test(String(chat));

function telegramRequest(token, chat, m) {
  if (!validTelegram(token, chat)) throw new Error('Invalid Telegram bot token or chat.');
  const prefix = { error: '🔴', warn: '🟠', ok: '🟢' }[m.kind] || 'ℹ️';
  const body = JSON.stringify({ chat_id: chat, text: clip(`${prefix} ${TITLE(m)}\n\n${plain(m)}`, 4000), disable_web_page_preview: true });
  return { url: `https://api.telegram.org/bot${token}/sendMessage`, body, headers: {} };
}

/**
 * Active channels from the settings. `decrypt` turns the stored secrets into text. Only complete channels are returned.
 * Result: [{ type: 'webhook'|'ntfy'|'telegram', ... }]
 */
function fromSettings(s, decrypt) {
  const out = [];
  const dec = (k) => { try { return s[k] ? decrypt(s[k]) : ''; } catch (_) { return ''; } };
  const webhook = dec('notify_webhook_enc');
  if (webhook) out.push({ type: 'webhook', url: webhook, secret: dec('notify_webhook_secret_enc') });
  const ntfy = dec('notify_ntfy_enc');
  if (ntfy) out.push({ type: 'ntfy', url: ntfy, token: dec('notify_ntfy_token_enc') });
  const tg = dec('notify_tg_token_enc');
  if (tg && s.notify_tg_chat) out.push({ type: 'telegram', token: tg, chat: s.notify_tg_chat });
  return out;
}

/** Sends one message through one channel. `transport(url, body, headers)` is replaceable for tests. */
async function sendVia(ch, m, transport = post) {
  const r = ch.type === 'webhook' ? webhookRequest(ch.url, ch.secret, m)
    : ch.type === 'ntfy' ? ntfyRequest(ch.url, ch.token, m)
      : telegramRequest(ch.token, ch.chat, m);
  return transport(r.url, r.body, r.headers);
}

/** Tries every channel, never throws; returns [{ type, ok, error }]. */
async function sendAll(channels, m, transport = post) {
  return Promise.all(channels.map(async (ch) => {
    try { await sendVia(ch, m, transport); return { type: ch.type, ok: true }; } catch (e) { return { type: ch.type, ok: false, error: String(e.message).slice(0, 300) }; }
  }));
}

module.exports = { isBlockedAddress, checkUrl, validTelegram, webhookRequest, ntfyRequest, telegramRequest, fromSettings, sendVia, sendAll, post, plain };
