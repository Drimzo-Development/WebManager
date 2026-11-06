'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.APP_KEY = 'a'.repeat(64);
const ch = require('../src/channels');

const MSG = { brand: 'Drimzo Development', subject: 'Website “Shop” is not reachable', text: 'The website is no longer running.', kind: 'error', facts: [['Website', 'Shop'], ['Empty', ''], ['ID', 'site-001']] };

test('addresses inside the server are refused, public ones are fine', () => {
  for (const ip of ['127.0.0.1', '127.8.8.8', '0.0.0.0', '169.254.169.254', '::1', '::', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '172.16.0.1', '172.18.0.3', '172.31.255.255', '100.64.0.1', '100.127.1.1', 'fc00::1', 'fd12:3456::1', '::ffff:172.18.0.3', 'nonsense']) {
    assert.equal(ch.isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '192.168.1.5', '10.0.0.2', '2606:4700::1111']) assert.equal(ch.isBlockedAddress(ip), false, ip);
});

test('addresses must be https with a full domain and without credentials', () => {
  assert.equal(ch.checkUrl('https://ntfy.sh/topic').hostname, 'ntfy.sh');
  for (const bad of ['http://ntfy.sh/t', 'https://localhost/x', 'https://agent:9000/', 'https://db/', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest',
    'https://user:pw@example.com/x', 'ftp://example.com', 'not a url', '', 'https://printer.local/x', 'https://svc.internal/x']) {
    assert.throws(() => ch.checkUrl(bad), undefined, bad);
  }
  assert.doesNotThrow(() => ch.checkUrl('https://192.168.1.5:8443/hook'));
});

test('webhook: structured data, Slack/Discord fields and optional signature', () => {
  const r = ch.webhookRequest('https://example.com/hook', 'topsecret', MSG, new Date('2026-11-02T10:00:00Z'));
  const j = JSON.parse(r.body);
  assert.equal(j.source, 'webmanager');
  assert.equal(j.kind, 'error');
  assert.deepEqual(j.facts, { Website: 'Shop', ID: 'site-001' });
  assert.equal(j.time, '2026-11-02T10:00:00.000Z');
  assert.match(j.text, /^\[Drimzo Development\] Website “Shop” is not reachable\n/);
  assert.equal(j.text, j.content);
  assert.equal(r.headers['X-WebManager-Signature'], `sha256=${crypto.createHmac('sha256', 'topsecret').update(r.body).digest('hex')}`);
  assert.deepEqual(ch.webhookRequest('https://example.com/hook', '', MSG).headers, {});
});

test('long messages are shortened to what Discord accepts', () => {
  const j = JSON.parse(ch.webhookRequest('https://example.com/h', '', { ...MSG, text: 'x'.repeat(5000) }).body);
  assert.ok(j.content.length <= 1800);
});

test('ntfy: JSON publishing to the server root, topic from the path, priority by kind', () => {
  const r = ch.ntfyRequest('https://ntfy.example.org/my-topic', 'tk_abc', MSG);
  assert.equal(r.url, 'https://ntfy.example.org/');
  assert.equal(r.headers.Authorization, 'Bearer tk_abc');
  const j = JSON.parse(r.body);
  assert.equal(j.topic, 'my-topic');
  assert.equal(j.priority, 4);
  assert.deepEqual(j.tags, ['rotating_light']);
  assert.match(j.title, /“Shop”/, 'non-ASCII text stays intact');
  assert.deepEqual(ch.ntfyRequest('https://ntfy.sh/t', '', { ...MSG, kind: 'ok' }).headers, {});
  assert.throws(() => ch.ntfyRequest('https://ntfy.sh/', '', MSG), /topic/);
  assert.throws(() => ch.ntfyRequest('https://ntfy.sh/a/b', '', MSG), /topic/);
});

test('Telegram: token and chat are validated, the message is plain text', () => {
  const token = '123456789:AAE-abcdefghijklmnopqrstuvwxyz012345';
  assert.equal(ch.validTelegram(token, '-1001234567890'), true);
  assert.equal(ch.validTelegram(token, '@mychannel'), true);
  assert.equal(ch.validTelegram('bad', '123'), false);
  assert.equal(ch.validTelegram(token, 'no chat'), false);
  const r = ch.telegramRequest(token, '42', MSG);
  assert.equal(r.url, `https://api.telegram.org/bot${token}/sendMessage`);
  const j = JSON.parse(r.body);
  assert.equal(j.chat_id, '42');
  assert.equal(j.parse_mode, undefined, 'no markup parsing: names cannot break the message');
  assert.match(j.text, /Website: Shop/);
  assert.throws(() => ch.telegramRequest('bad', '42', MSG), /Invalid/);
});

test('channels come from the settings, incomplete ones are left out', () => {
  const dec = (v) => v.replace(/^enc:/, '');
  assert.deepEqual(ch.fromSettings({}, dec), []);
  const list = ch.fromSettings({
    notify_webhook_enc: 'enc:https://example.com/h', notify_webhook_secret_enc: 'enc:s3',
    notify_ntfy_enc: 'enc:https://ntfy.sh/t',
    notify_tg_token_enc: 'enc:123456789:AAE-abcdefghijklmnopqrstuvwxyz012345',
  }, dec);
  assert.deepEqual(list.map((c) => c.type), ['webhook', 'ntfy'], 'Telegram without chat is incomplete');
  assert.equal(list[0].secret, 's3');
  const broken = ch.fromSettings({ notify_webhook_enc: 'x' }, () => { throw new Error('bad key'); });
  assert.deepEqual(broken, []);
});

test('one failing channel does not stop the others', async () => {
  const calls = [];
  const transport = async (url) => { calls.push(url); if (url.includes('bad')) throw new Error('HTTP 500'); return { status: 200 }; };
  const res = await ch.sendAll([
    { type: 'webhook', url: 'https://bad.example.com/h', secret: '' },
    { type: 'webhook', url: 'https://good.example.com/h', secret: '' },
  ], MSG, transport);
  assert.deepEqual(res.map((r) => r.ok), [false, true]);
  assert.equal(res[0].error, 'HTTP 500');
  assert.equal(calls.length, 2);
});
