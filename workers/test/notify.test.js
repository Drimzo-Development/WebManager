'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_KEY = 'a'.repeat(64);
const { evaluate, siteIsDown, recipients } = require('../src/notify');

test('an outage is reported once after two failed checks and recovery once', () => {
  let r = evaluate(null, true);
  assert.equal(r.event, null);
  r = evaluate(r.state, true);
  assert.equal(r.event, 'down');
  r = evaluate(r.state, true);
  assert.equal(r.event, null, 'no repeated outage mail');
  r = evaluate(r.state, false);
  assert.equal(r.event, 'up');
  r = evaluate(r.state, false);
  assert.equal(r.event, null);
});

test('a short blip never produces mail', () => {
  let r = evaluate(null, true);
  r = evaluate(r.state, false);
  assert.equal(r.event, null);
});

test('only sites that should be running count as down', () => {
  const ok = { exists: true, running: true, health: 'healthy', state: 'running' };
  assert.equal(siteIsDown({ lifecycle: 'ready', desired_state: 'running' }, ok), false);
  assert.equal(siteIsDown({ lifecycle: 'ready', desired_state: 'running' }, { ...ok, running: false }), true);
  assert.equal(siteIsDown({ lifecycle: 'ready', desired_state: 'running' }, { ...ok, health: 'unhealthy' }), true);
  assert.equal(siteIsDown({ lifecycle: 'ready', desired_state: 'stopped' }, { exists: true, running: false }), false);
  assert.equal(siteIsDown({ lifecycle: 'creating', desired_state: 'running' }, undefined), false);
  assert.equal(siteIsDown({ lifecycle: 'ready', desired_state: 'running' }, undefined), true);
});

test('recipient list tolerates separators and drops junk', () => {
  assert.deepEqual(recipients({ notify_to: 'a@x.de, b@y.de;\nnope c@z.de' }), ['a@x.de', 'b@y.de', 'c@z.de']);
});

test('disk usage percentage and backup problems are derived from the agent status', () => {
  const { diskUsedPercent, backupProblem } = require('../src/notify');
  assert.equal(diskUsedPercent({ totalBytes: 1000, freeBytes: 100 }), 90);
  assert.equal(diskUsedPercent(null), null);
  const now = Date.parse('2026-10-11T12:00:00Z');
  assert.equal(backupProblem(null, now), null, 'no backup configured: no alert');
  assert.equal(backupProblem({ ok: true, at: '2026-10-11T03:00:00Z' }, now), null);
  assert.equal(backupProblem({ ok: false, at: '2026-10-11T03:00:00Z' }, now).kind, 'failed');
  assert.equal(backupProblem({ ok: true, at: '2026-10-09T03:00:00Z' }, now).kind, 'stale');
});

test('HTML mail: colour per kind, facts, logo, escaping', () => {
  const { renderMail } = require('../src/mailtemplate');
  const html = renderMail({
    title: 'Website <b>x</b> is down', text: 'Line 1\nLine 2\n\n• one\n• two', kind: 'error',
    facts: [['Website', 'A&B'], ['Empty', ''], ['Domains', 'a.de']], link: { url: 'https://panel.example.com/' }, logo: true,
  });
  assert.match(html, /cid:logo/);
  assert.match(html, /#dc2626/);
  assert.match(html, /Website &lt;b&gt;x&lt;\/b&gt; is down/);
  assert.match(html, /A&amp;B/);
  assert.doesNotMatch(html, /Empty/);
  assert.match(html, /<ul[^>]*><li[^>]*>one/);
  assert.match(html, /href="https:\/\/panel\.example\.com\/"/);
  assert.doesNotMatch(renderMail({ title: 't', text: 'x', link: { url: 'javascript:alert(1)' } }), /javascript:/);
  assert.doesNotMatch(renderMail({ title: 't', text: 'x' }), /cid:logo/);
});

test('external backup target: error, stale upload and failed restore test are reported', () => {
  const { remoteBackupProblems } = require('../src/notify');
  const now = Date.parse('2026-10-12T12:00:00Z');
  assert.deepEqual(remoteBackupProblems(null, now), []);
  assert.deepEqual(remoteBackupProblems({ configured: false, upload: { ok: false, at: 'x' } }, now), [], 'no target, no message');
  assert.deepEqual(remoteBackupProblems({ configured: true, upload: { ok: true, at: '2026-10-12T03:40:00Z' }, verify: { ok: true, at: '2026-10-11T05:00:00Z' } }, now), []);
  assert.deepEqual(remoteBackupProblems({ configured: true, upload: { ok: false, at: '2026-10-12T03:40:00Z' } }, now).map((p) => p.kind), ['remote_failed']);
  assert.deepEqual(remoteBackupProblems({ configured: true, upload: { ok: true, at: '2026-10-08T03:40:00Z' } }, now).map((p) => p.kind), ['remote_stale']);
  assert.deepEqual(remoteBackupProblems({ configured: true, upload: { ok: true, at: '2026-10-12T03:40:00Z' }, verify: { ok: false, at: '2026-10-12T05:00:00Z' } }, now).map((p) => p.kind), ['verify_failed']);
});

test('update mails: new version once, auto update result once per run', () => {
  const { updateMails } = require('../src/notify');
  const base = { version: '0.7.1', releases: [{ version: '0.7.3', notes: 'Fix A' }, { version: '0.7.2', notes: 'Fix B' }, { version: '0.7.1' }], auto: { mode: 'off', from: 2, to: 5 }, state: null };
  const m1 = updateMails(base, new Set());
  assert.equal(m1.length, 1);
  assert.equal(m1[0].key, 'update:0.7.3');
  assert.match(m1[0].text, /Fix A/);
  assert.match(m1[0].text, /Update now/);
  assert.deepEqual(updateMails(base, new Set(['update:0.7.3'])), [], 'the same version is not reported again');
  assert.equal(updateMails({ ...base, releases: [{ version: '0.7.4' }, ...base.releases] }, new Set(['update:0.7.3']))[0].key, 'update:0.7.4', 'an even newer version is reported');
  assert.match(updateMails({ ...base, auto: { mode: 'patch', from: 2, to: 5 } }, new Set())[0].text, /installed automatically/);
  assert.match(updateMails({ ...base, auto: { mode: 'patch', from: 2, to: 5 }, releases: [{ version: '0.8.0' }] }, new Set())[0].text, /Update now/, 'a new minor version always needs a click');
  assert.deepEqual(updateMails({ ...base, releases: [{ version: '0.7.1' }, { version: '0.6.0' }] }, new Set()), []);
  assert.deepEqual(updateMails({ ...base, version: 'dev' }, new Set()), []);
  const ok = updateMails({ ...base, releases: [], state: { state: 'ok', version: '0.7.2', at: 'T1', auto: true } }, new Set());
  assert.equal(ok[0].kind, 'ok');
  assert.equal(ok[0].key, 'update-run:T1');
  const bad = updateMails({ ...base, releases: [], state: { state: 'failed', version: '0.7.2', at: 'T2', auto: true }, logTail: 'a\nb\nError X' }, new Set());
  assert.equal(bad[0].kind, 'error');
  assert.match(bad[0].text, /Error X/);
  assert.match(bad[0].text, /paused/);
  assert.deepEqual(updateMails({ ...base, releases: [], state: { state: 'ok', version: '0.7.2', at: 'T1', auto: false } }, new Set()), [], 'manual updates trigger no mail');
  assert.deepEqual(updateMails({ ...base, releases: [], state: { state: 'ok', version: '0.7.2', at: 'T1', auto: true } }, new Set(['update-run:T1'])), []);
  assert.deepEqual(updateMails({ ...base, releases: [], state: { state: 'running', version: '0.7.2', at: 'T3', auto: true } }, new Set()), []);
});

test('HTML mail: a custom name is escaped, the product name webmanager always stays', () => {
  const { renderMail } = require('../src/mailtemplate');
  const custom = renderMail({ title: 't', text: 'x', brand: 'Muster <Hosting> & Co' });
  assert.match(custom, /Muster &lt;Hosting&gt; &amp; Co/);
  assert.doesNotMatch(custom, /Muster <Hosting>/);
  assert.match(custom, /webmanager/);
  assert.doesNotMatch(custom, /Drimzo Development/);
  const plain = renderMail({ title: 't', text: 'x' });
  assert.match(plain, /Drimzo Development/);
  assert.match(plain, /webmanager/);
});

test('sign-in warning: text, device and facts', () => {
  const { loginText, loginFacts, browserOf } = require('../src/notify');
  assert.match(loginText('Anna'), /^Hello Anna,\n\na sign-in to your account/);
  assert.doesNotMatch(loginText(''), /Hello/);
  assert.equal(browserOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120'), 'Edge on Windows');
  assert.equal(browserOf('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0'), 'Firefox on Linux');
  assert.equal(browserOf(''), 'Unknown browser');
  const f = loginFacts({ ip: '203.0.113.9', ua: 'Firefox/1 Linux', at: '2026-10-23T10:00:00Z' });
  assert.deepEqual(f.map((x) => x[0]), ['Time', 'IP address', 'Device']);
  assert.equal(f[1][1], '203.0.113.9');
  assert.equal(loginFacts({ ip: 'x', ua: '', at: 'kaputt' })[0][1], '');
});

test('a wave of automatic bans is detected inside the window only', () => {
  const { banWave } = require('../src/notify');
  const now = Date.parse('2026-11-02T10:00:00Z');
  const ban = (ip, minutesAgo, reason = '700 requests in 60 s') => ({ ip, reason, since: new Date(now - minutesAgo * 60000).toISOString(), until: new Date(now + 3600000).toISOString() });
  const prot = { config: { autoBan: { banMinutes: 60 } }, bans: [ban('1.1.1.1', 2), ban('1.1.1.2', 5, '200 erroneous requests in 60 s'), ban('1.1.1.3', 30), ban('1.1.1.4', 1)] };
  assert.equal(banWave(prot, now, 5), null, 'below the threshold');
  const w = banWave(prot, now, 3);
  assert.equal(w.count, 3, 'the ban from 30 minutes ago is not part of the wave');
  assert.deepEqual([w.flood, w.errors], [2, 1]);
  assert.deepEqual(w.sample, ['1.1.1.1', '1.1.1.2', '1.1.1.4']);
  assert.equal(banWave({ bans: [] }, now, 1), null);
  assert.equal(banWave(null, now, 1), null);
  // bans written before 0.1.3 have no start time: it is derived from the end and the ban duration
  const old = { config: { autoBan: { banMinutes: 60 } }, bans: [{ ip: '9.9.9.9', reason: 'x', until: new Date(now + 55 * 60000).toISOString() }] };
  assert.equal(banWave(old, now, 1).count, 1);
});

test('only a fresh failed HTTP check counts as an outage', () => {
  const { probeDown, rowsFrom } = require('../src/uptime');
  assert.equal(probeDown(null), false);
  assert.equal(probeDown({ ok: true, ageMs: 1000 }), false);
  assert.equal(probeDown({ ok: false, ageMs: 30000 }), true);
  assert.equal(probeDown({ ok: false, ageMs: 10 * 60000 }), false, 'old result: the check itself may be broken');
  assert.deepEqual(rowsFrom({ 3: { state: 'up', status: 200, ms: 41 }, 4: { state: 'down', status: null, ms: 8000, error: 'Timeout' }, 5: { state: 'unknown' }, x: { state: 'up' } }),
    [[3, 1, 200, 41, null], [4, 0, null, 8000, 'Timeout']]);
});
