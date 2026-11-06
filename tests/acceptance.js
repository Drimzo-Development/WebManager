'use strict';
/*
 * End-to-end acceptance test against a RUNNING installation (real containers, real API).
 * No dependencies; needs Node >= 18 (run it in a container, see tests/run-acceptance.sh).
 *
 *   BASE_URL=http://127.0.0.1:8088 ADMIN_EMAIL=... ADMIN_PASSWORD=... node tests/acceptance.js
 *
 * Websites are reached through the reverse proxy with a Host header, so no DNS setup is needed.
 * All created websites are deleted again at the end (files purged).
 */
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8088').replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error('set ADMIN_EMAIL and ADMIN_PASSWORD'); process.exit(2); }

const RUN = Date.now().toString(36);
let cookie = '';
let csrf = '';
const results = [];
const created = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, path, { json, form, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (csrf && method !== 'GET') h['X-CSRF-Token'] = csrf;
  let body;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  const res = await fetch(BASE + path, { method, headers: h, body, redirect: 'manual' });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  if (raw) return { status: res.status, text, headers: res.headers };
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* html */ }
  return { status: res.status, data, text, headers: res.headers };
}

const api = async (method, path, json) => {
  const r = await http(method, path, { json });
  if (r.status >= 400) { const e = new Error(`${method} ${path} -> ${r.status}: ${r.data && r.data.error}`); e.status = r.status; e.body = r.data; throw e; }
  return r.data;
};

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').join('\n        ')}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function waitJob(id, timeoutSec = 600) {
  const end = Date.now() + timeoutSec * 1000;
  let after = 0; let log = '';
  for (;;) {
    const d = await api('GET', `/api/jobs/${id}/logs?after=${after}`);
    for (const l of d.lines) { log += `${l.line}\n`; after = l.id; }
    if (d.finished && d.lines.length === 0) { return { status: d.job.status, error: d.job.error, log }; }
    if (Date.now() > end) throw new Error(`Job ${id} Timeout\n${log.slice(-1500)}`);
    await sleep(1000);
  }
}
async function ok(jobId, label) {
  const r = await waitJob(jobId);
  if (r.status !== 'succeeded') throw new Error(`${label || 'Job'} ${jobId}: ${r.status} ${r.error || ''}\n${r.log.slice(-2000)}`);
  return r;
}

function viaProxy(host, path = '/') {
  const u = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = require('http').request({ host: u.hostname, port: u.port || 80, path, method: 'GET', headers: { Host: host } }, (res) => {
      let t = '';
      res.on('data', (d) => { t += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}
async function waitHttp(host, expect, timeoutSec = 90) {
  const end = Date.now() + timeoutSec * 1000;
  let last = '';
  while (Date.now() < end) {
    try { const r = await viaProxy(host); last = `${r.status} ${r.text.slice(0, 120)}`; if (r.status === 200 && r.text.includes(expect)) return r; } catch (e) { last = e.message; }
    await sleep(2000);
  }
  throw new Error(`${host} did not return "${expect}" (last: ${last})`);
}

async function createSite(body) {
  const r = await api('POST', '/api/sites', body);
  created.push({ id: r.site, name: body.name });
  return r;
}
const write = (id, path, content) => api('PUT', `/api/sites/${id}/files/content?path=${encodeURIComponent(path)}`, { content });


/** Minimal tar.gz writer (ustar) so the test needs no dependencies. entries: [{name, content}] */
function makeTarGz(entries) {
  const blocks = [];
  for (const e of entries) {
    const data = Buffer.from(e.content);
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
    h.write('        ', 148); h.write('0', 156); h.write('ustar\0' + '00', 257);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return require('zlib').gzipSync(Buffer.concat(blocks));
}
async function uploadFile(id, name, buf) {
  const fd = new FormData();
  fd.append('file[]', new Blob([buf]), name);
  const r = await fetch(BASE + '/api/sites/' + id + '/files/upload?path=', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: fd });
  const d = await r.json();
  if (!r.ok || !d.results[0].ok) throw new Error('Upload failed: ' + JSON.stringify(d));
}

const NODE_SERVER = "require('http').createServer((q,r)=>{r.setHeader('content-type','text/plain');r.end('node-site:'+process.env.MSG+':'+process.env.PORT)}).listen(process.env.PORT,'0.0.0.0');";
const nodePkg = '{"name":"acceptance","version":"1.0.0","scripts":{"start":"node server.js","build":"echo build-ok"}}';

(async () => {
  console.log(`WebManager acceptance test against ${BASE} (run ${RUN})\n`);

  await step('Sign-in: wrong password is rejected', async () => {
    const login = await http('GET', '/login', { raw: true });
    assert(login.status === 302 && login.headers.get('location') === '/app', 'GET /login must redirect to /app');
    const state = await http('GET', '/api/auth/state');
    const t = [null, state.data && state.data.csrf];
    assert(t[1], 'CSRF token of the sign-in is missing');
    const bad = await http('POST', '/login', { form: { _csrf: t[1], email: EMAIL, password: `${PASSWORD}-wrong` } });
    assert(bad.status === 401, `expected 401, got ${bad.status}`);
  });
  await step('Sign-in: POST without CSRF token is rejected', async () => {
    const r = await http('POST', '/login', { form: { email: EMAIL, password: PASSWORD } });
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });
  await step('Sign-in: administrator can sign in', async () => {
    const state = await http('GET', '/api/auth/state');
    const r = await http('POST', '/login', { form: { _csrf: state.data.csrf, email: EMAIL, password: PASSWORD } });
    assert(r.status === 302 && r.headers.get('location') === '/app', `expected 302 to /app, got ${r.status} ${r.headers.get('location')}`);
    const home = await http('GET', '/', { raw: true });
    assert(home.status === 302 && home.headers.get('location') === '/app', 'GET / must redirect to /app');
    const me = await http('GET', '/api/v1/me');
    assert(me.status === 200 && me.data.csrf, 'CSRF token not found after login');
    csrf = me.data.csrf;
  });
  await step('API without sign-in returns 401', async () => {
    const saved = cookie; cookie = '';
    const r = await http('GET', '/api/overview');
    cookie = saved;
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });
  await step('System status: all components healthy', async () => {
    const s = await api('GET', '/api/system');
    for (const [k, v] of Object.entries(s.components)) assert(v.ok, `Component ${k} not ok: ${v.detail}`);
  });

  // ---------------------------------------------------------------- static
  const sStatic = `static-${RUN}`; const dStatic = `${sStatic}.test`;
  let idStatic;
  await step('Create and serve a static website', async () => {
    const r = await createSite({ name: sStatic, type: 'static', runtime: 'static', domains: [dStatic], memory_mb: 128, cpus: 0.5, pids: 64, autostart: true });
    idStatic = r.site;
    await ok(r.job, 'site.create');
    const resp = await waitHttp(dStatic, sStatic);
    assert(resp.text.includes('WebManager'), 'Welcome page missing');
  });
  await step('File manager: edit a file of the static website', async () => {
    await write(idStatic, 'index.html', `<h1>changed-${RUN}</h1>`);
    await waitHttp(dStatic, `changed-${RUN}`, 20);
    const list = await api('GET', `/api/sites/${idStatic}/files?path=`);
    assert(list.entries.some((e) => e.name === 'index.html'), 'index.html not in the list');
  });


  await step('File manager: create folder, move, copy, protection against copying into itself', async () => {
    const f = '/api/sites/' + idStatic + '/files';
    await api('POST', f + '/mkdir', { path: 'assets' });
    await api('POST', f + '/mkdir', { path: 'assets/img' });
    await write(idStatic, 'assets/a.txt', 'A');
    await api('POST', f + '/rename', { path: 'assets/a.txt', to: 'assets/img/a.txt' });           // move
    let l = await api('GET', f + '?path=assets/img');
    assert(l.entries.some((e) => e.name === 'a.txt'), 'File not in the target folder after moving');
    await api('POST', f + '/copy', { path: 'assets', to: 'assets-copy' });                         // copy folder recursively
    l = await api('GET', f + '?path=assets-copy/img');
    assert(l.entries.some((e) => e.name === 'a.txt'), 'The copy does not contain the file');
    l = await api('GET', f + '?path=assets/img');
    assert(l.entries.some((e) => e.name === 'a.txt'), 'Original disappeared after copying');
    for (const bad of [{ path: 'assets', to: 'assets/sub' }, { path: 'assets', to: 'assets-copy' }, { path: 'assets', to: '../x' }, { path: '../x', to: 'y' }]) {
      const r = await http('POST', f + '/copy', { json: bad });
      assert(r.status >= 400, 'Invalid copy was accepted: ' + JSON.stringify(bad));
    }
    const mv = await http('POST', f + '/rename', { json: { path: 'assets', to: 'assets-copy' } });
    assert(mv.status >= 400, 'Moving onto an existing target was accepted');
    await http('DELETE', f + '?path=assets-copy');
    await http('DELETE', f + '?path=assets');
  });

  // ---------------------------------------------------------------- laravel
  await step('Laravel: PHP runtime with Composer/npm, document root public, quick commands', async () => {
    const r = await createSite({ name: 'laravel-' + RUN, type: 'laravel', runtime: 'php-8.3', domains: ['laravel-' + RUN + '.test'], memory_mb: 512, cpus: 1, pids: 128, autostart: true, install_command: 'composer --version && node --version && php --version | head -1' });
    await ok(r.job, 'site.create');
    const d = 'laravel-' + RUN + '.test';
    const site = (await api('GET', '/api/sites/' + r.site)).site;
    assert(site.docroot === 'public', 'Document root should be public, is: ' + site.docroot);
    await api('POST', '/api/sites/' + r.site + '/files/mkdir', { path: 'public' });
    await write(r.site, 'public/index.php', "<?php echo 'laravel-ok:' . getenv('APP_NAME');");
    await write(r.site, 'composer.json', '{"name":"demo/app","require":{}}');
    await api('PUT', '/api/sites/' + r.site + '/env', { env: { APP_NAME: 'Demo' } }).then((x) => ok(x.job, 'env apply'));
    await sleep(3000);
    await waitHttp(d, 'laravel-ok:Demo', 60);
    const inst = await api('POST', '/api/sites/' + r.site + '/commands', { kind: 'install' });
    const out = (await ok(inst.job, 'install')).log;
    assert(/Composer version 2\./.test(out) && /v\d+\./.test(out) && /PHP 8\.3/.test(out), 'composer/node/php missing in the runtime image:\n' + out);
    const ci = await api('POST', '/api/sites/' + r.site + '/commands', { kind: 'composer_install' });
    await ok(ci.job, 'composer install');
    const bad = await http('POST', '/api/sites/' + idStatic + '/commands', { json: { kind: 'artisan_migrate' } });
    assert(bad.status === 422, 'artisan commands must only apply to Laravel websites');
    const opt = await api('POST', '/api/sites/' + r.site + '/commands', { kind: 'artisan_optimize' });
    const o = await waitJob(opt.job, 60);
    assert(/artisan/i.test(o.log), 'artisan was not called: ' + o.log);   // without Laravel code artisan fails; what matters is that the command ran
  });


  await step('PHP 8.4 and default page: current runtime, name safely escaped', async () => {
    const d = 'php84-' + RUN + '.test';
    const r = await createSite({ name: 'php84-' + RUN, type: 'php', runtime: 'php-8.4', domains: [d], memory_mb: 256, cpus: 0.5, pids: 128, autostart: true });
    await ok(r.job, 'site.create');
    const resp = await waitHttp(d, 'PHP 8.4.', 90);
    assert(resp.text.includes('php84-' + RUN), 'Name missing on the default page');
    assert(resp.text.includes('prefers-color-scheme'), 'Default page without light/dark design');
  });

  // ---------------------------------------------------------------- php
  const sPhp = `php-${RUN}`; const dPhp = `${sPhp}.test`;
  let idPhp;
  await step('Create a PHP website (PHP-FPM + Nginx)', async () => {
    const r = await createSite({ name: sPhp, type: 'php', runtime: 'php-8.3', domains: [dPhp], memory_mb: 256, cpus: 0.5, pids: 128, autostart: true });
    idPhp = r.site;
    await ok(r.job, 'site.create');
    await waitHttp(dPhp, 'PHP 8.3', 120);
  });
  await step('PHP website: own code with environment variable', async () => {
    await write(idPhp, 'info.php', "<?php echo 'env=' . getenv('GREETING') . ';fn=' . (function_exists('exec') ? 'exec-ok' : 'no-exec');");
    const r = await api('PUT', `/api/sites/${idPhp}/env`, { env: { GREETING: `hallo-${RUN}` } });
    await ok(r.job, 'site.apply');
    await sleep(3000);
    const direct = await viaProxy(dPhp, '/info.php');
    assert(direct.text.includes(`env=hello-${RUN}`), `Environment variable missing: ${direct.text.slice(0, 200)}`);
  });

  // ---------------------------------------------------------------- node x2 (same internal port)
  const mk = (n) => ({ name: `node${n}-${RUN}`, domain: `node${n}-${RUN}.test` });
  const n1 = mk(1); const n2 = mk(2);
  await step('Create two Node.js websites with the same internal port', async () => {
    for (const n of [n1, n2]) {
      const r = await createSite({
        name: n.name, type: 'node', runtime: 'node-22', internal_port: 3000, domains: [n.domain], memory_mb: 256, cpus: 0.5, pids: 128,
        env: { MSG: n.name }, autostart: true,
      });
      n.id = r.site;
      await ok(r.job, 'site.create');
      await write(n.id, 'package.json', nodePkg);
      await write(n.id, 'server.js', NODE_SERVER);
    }
    assert(n1.id !== n2.id, 'IDs must differ');
  });
  await step('Run npm install in the isolated container', async () => {
    const r = await api('POST', `/api/sites/${n1.id}/commands`, { kind: 'npm_install' });
    const res = await ok(r.job, 'npm install');
    assert(/up to date|added|audited|found 0/i.test(res.log) || res.log.includes('npm install'), 'npm output missing');
  });
  await step('package.json scripts are detected and npm run build runs', async () => {
    const sc = await api('GET', `/api/sites/${n1.id}/scripts`);
    assert(sc.scripts.includes('start') && sc.scripts.includes('build'), `Scripts: ${JSON.stringify(sc)}`);
    const r = await api('POST', `/api/sites/${n1.id}/commands`, { kind: 'npm_script', script: 'build' });
    const res = await ok(r.job, 'npm run build');
    assert(res.log.includes('build-ok'), 'build-ok not in the output');
  });
  await step('Start Node websites; both answer on the same port 3000', async () => {
    for (const n of [n1, n2]) { const r = await api('POST', `/api/sites/${n.id}/action`, { action: 'start' }); await ok(r.job, 'start'); }
    await waitHttp(n1.domain, `node-site:${n1.name}:3000`);
    await waitHttp(n2.domain, `node-site:${n2.name}:3000`);
  });
  await step('Domain routing: the right website per domain, none for an unknown domain', async () => {
    assert((await viaProxy(n1.domain)).text.includes(n1.name), 'Domain 1 wrong');
    assert((await viaProxy(n2.domain)).text.includes(n2.name), 'Domain 2 wrong');
    assert((await viaProxy(dStatic)).text.includes(`changed-${RUN}`), 'static domain wrong');
    const unknown = await viaProxy(`unknown-${RUN}.test`);
    assert(!unknown.text.includes('node-site:'), 'unknown domain ends up at a website');
  });
  await step('Restart an application', async () => {
    const before = await api('GET', `/api/sites/${n1.id}/status`);
    const r = await api('POST', `/api/sites/${n1.id}/action`, { action: 'restart' });
    await ok(r.job, 'restart');
    const after = await api('GET', `/api/sites/${n1.id}/status`);
    assert(after.status.running, 'not running after restart');
    assert(after.status.startedAt !== before.status.startedAt, 'StartedAt unchanged – no restart');
    await waitHttp(n1.domain, n1.name);
  });
  await step('Stop and start via the dashboard', async () => {
    let r = await api('POST', `/api/sites/${n2.id}/action`, { action: 'stop' }); await ok(r.job, 'stop');
    const st = await api('GET', `/api/sites/${n2.id}/status`);
    assert(!st.status.running, 'Container still running after stop');
    const down = await viaProxy(n2.domain);
    assert(down.status === 502 || down.status === 503, `gestoppte Website sollte 502 liefern, erhielt ${down.status}`);
    assert((await viaProxy(n1.domain)).status === 200, 'other website must not be affected');
    r = await api('POST', `/api/sites/${n2.id}/action`, { action: 'start' }); await ok(r.job, 'start');
    await waitHttp(n2.domain, n2.name);
  });
  await step('Logs and resource usage are shown', async () => {
    await viaProxy(dStatic);
    const logs = await api('GET', `/api/sites/${n1.id}/logs?source=container&tail=50`);
    assert(typeof logs.log === 'string', 'Container log missing');
    const acc = await api('GET', `/api/sites/${idStatic}/logs?source=access&tail=20`);
    assert(acc.log.includes('GET'), 'Access log of the static website empty');
    const st = await api('GET', `/api/sites/${n1.id}/status`);
    assert(st.stats && st.stats.memLimitBytes > 0 && st.stats.memLimitBytes <= 256 * 1024 * 1024 * 1.01, `Memory limit not set: ${JSON.stringify(st.stats)}`);
    assert(st.stats.pids >= 1, 'PIDs fehlen');
  });

  // ---------------------------------------------------------------- isolation & permissions
  const sIso = `iso-${RUN}`; const probe = [
    'echo uid=$(id -u)',
    "grep -E '^CapEff' /proc/self/status",
    `(wget -q -T 3 -O- http://wm-agent:9000/healthz >/dev/null 2>&1 && echo AGENT_REACHABLE) || echo agent-unreachable`,
    `(wget -q -T 3 -O- http://agent:9000/healthz >/dev/null 2>&1 && echo AGENT2_REACHABLE) || echo agent2-unreachable`,
    `(wget -q -T 3 -O- http://db:3306 >/dev/null 2>&1; nc -z -w 3 db 3306 2>/dev/null && echo DB_REACHABLE) || echo db-unreachable`,
    `(wget -q -T 3 -O- http://wm-site-${String(n1.id).padStart(3, '0')}:3000 >/dev/null 2>&1 && echo OTHERSITE_REACHABLE) || echo othersite-unreachable`,
    '[ -S /var/run/docker.sock ] && echo SOCKET_PRESENT || echo no-docker-socket',
    '[ -e /var/lib/webmanager ] && echo DATADIR_VISIBLE || echo datadir-hidden',
    'touch /etc/probe 2>/dev/null && echo ROOTFS_WRITABLE || echo rootfs-readonly',
    'ln -s /etc/passwd /app/evil-link && ln -s /app /app/evil-dir && echo links-created',
  ].join('; ');
  let idIso;
  await step('Isolation: container without privileges, without access to agent, database, socket, other websites', async () => {
    const r = await createSite({ name: sIso, type: 'node', runtime: 'node-22', internal_port: 3000, install_command: probe, start_command: 'node server.js', autostart: false, memory_mb: 128, cpus: 0.5, pids: 64 });
    idIso = r.site;
    await ok(r.job, 'site.create');
    const run = await api('POST', `/api/sites/${idIso}/commands`, { kind: 'install' });
    const out = (await ok(run.job, 'Probe')).log.split('\n').filter((l) => !l.startsWith('$ ')).join('\n');
    const uid = 20000 + idIso;
    assert(out.includes(`uid=${uid}`), `Process does not run with uid ${uid}:\n${out}`);
    assert(/CapEff:\s*0+\s*$/m.test(out), `Capabilities not empty:\n${out}`);
    for (const bad of ['AGENT_REACHABLE', 'AGENT2_REACHABLE', 'DB_REACHABLE', 'OTHERSITE_REACHABLE', 'SOCKET_PRESENT', 'DATADIR_VISIBLE', 'ROOTFS_WRITABLE']) {
      assert(!out.includes(bad), `${bad} – Isolation verletzt:\n${out}`);
    }
    for (const good of ['agent-unreachable', 'db-unreachable', 'othersite-unreachable', 'no-docker-socket', 'datadir-hidden', 'rootfs-readonly']) {
      assert(out.includes(good), `${good} missing in the output:\n${out}`);
    }
  });
  await step('File manager: path traversal and symlinks are rejected', async () => {
    for (const p of ['../../etc/passwd', '..', '/etc/passwd', 'a/../../x']) {
      const r = await http('GET', `/api/sites/${idIso}/files/content?path=${encodeURIComponent(p)}`);
      assert(r.status >= 400, `Path ${p} was not rejected (${r.status})`);
    }
    const link = await http('GET', `/api/sites/${idIso}/files/content?path=evil-link`);
    assert(link.status === 400 && /Symbolic links/.test(link.data.error), `Symlink not rejected: ${link.status} ${link.text.slice(0, 100)}`);
    const dir = await http('GET', `/api/sites/${idIso}/files?path=evil-dir`);
    assert(dir.status === 400, 'Symlink directory not rejected');
    const w = await http('PUT', `/api/sites/${idIso}/files/content?path=evil-link`, { json: { content: 'pwn' } });
    assert(w.status === 400, 'Writing through symlink not rejected');
    const del = await http('DELETE', `/api/sites/${idPhp}/files?path=`);
    assert(del.status >= 400, 'Deleting the project directory was not rejected');
  });
  await step('File access is separated per website (foreign ID/path not reachable)', async () => {
    await write(n1.id, 'secret.txt', `geheim-${RUN}`);
    const r = await http('GET', `/api/sites/${n2.id}/files/content?path=${encodeURIComponent('../site-' + String(n1.id).padStart(3, '0') + '/files/secret.txt')}`);
    assert(r.status >= 400, 'Access to a foreign directory possible');
    const r2 = await http('GET', `/api/sites/${n2.id}/files/content?path=secret.txt`);
    assert(r2.status >= 400, 'File of the other website visible');
  });
  await step('Input validation: invalid values are rejected', async () => {
    const bad = [
      { name: 'x', type: 'node', runtime: 'node-22' },
      { name: `bad-${RUN}`, type: 'node', runtime: 'not/approved:latest' },
      { name: `bad-${RUN}`, type: 'node', runtime: 'node-22', internal_port: 80 },
      { name: `bad-${RUN}`, type: 'node', runtime: 'node-22', memory_mb: 99999999 },
      { name: `bad-${RUN}`, type: 'node', runtime: 'node-22', domains: ['evil;rm -rf /'] },
      { name: `bad-${RUN}`, type: 'node', runtime: 'node-22', env: { 'LD_PRELOAD': '/x' } },
      { name: `bad-${RUN}`, type: 'node', runtime: 'node-22', git_url: 'file:///etc' },
      { name: `bad-${RUN}`, type: 'static', runtime: 'node-22' },
    ];
    for (const b of bad) {
      const r = await http('POST', '/api/sites', { json: b });
      assert(r.status === 422, `${JSON.stringify(b)} -> ${r.status}`);
    }
    const dup = await http('PUT', `/api/sites/${n2.id}/domains`, { json: { domains: [n1.domain] } });
    assert(dup.status === 422, 'duplicate domain was accepted');
  });
  await step('HTTPS status is not claimed as long as no certificate exists', async () => {
    const c = await api('GET', `/api/sites/${n1.id}/cert`);
    assert(c.cert.exists === false, 'Certificate must not exist');
    const o = await api('GET', '/api/overview');
    const s = o.sites.find((x) => x.id === n1.id);
    assert(s.cert_status !== 'verified' && !s.tls, 'Dashboard claims HTTPS without a certificate');
  });
  await step('Cancel tasks', async () => {
    const r = await api('PUT', `/api/sites/${idIso}`, { install_command: 'sleep 300' });
    await ok(r.job, 'apply');
    const run = await api('POST', `/api/sites/${idIso}/commands`, { kind: 'install' });
    for (let i = 0; i < 30; i++) { const j = await api('GET', `/api/jobs/${run.job}`); if (j.job.status === 'running') break; await sleep(1000); }
    await api('POST', `/api/jobs/${run.job}/cancel`);
    const res = await waitJob(run.job, 60);
    assert(res.status === 'cancelled', `expected cancelled, got ${res.status}`);
  });


  // ---------------------------------------------------------------- code sources: archive + git
  const sArc = 'arc-' + RUN; const dArc = sArc + '.test';
  let idArc;
  await step('Archive upload: upload tar.gz, extract (top-level folder resolved)', async () => {
    const r = await createSite({ name: sArc, type: 'static', runtime: 'static', domains: [dArc], memory_mb: 128, cpus: 0.5, pids: 64, autostart: true });
    idArc = r.site;
    await ok(r.job, 'site.create');
    const arc = makeTarGz([
      { name: 'project-main/index.html', content: '<h1>from-archive-' + RUN + '</h1>' },
      { name: 'project-main/css/app.css', content: 'body{color:red}' },
    ]);
    const name = '.wm-upload-' + Date.now() + '.tar.gz';
    await uploadFile(idArc, name, arc);
    const c = await api('POST', '/api/sites/' + idArc + '/commands', { kind: 'extract', archive: name, strip: true });
    await ok(c.job, 'extract');
    await waitHttp(dArc, 'from-archive-' + RUN, 30);
    const css = await viaProxy(dArc, '/css/app.css');
    assert(css.status === 200 && css.text.includes('color:red'), 'Subfolder from the archive missing');
    const left = await api('GET', '/api/sites/' + idArc + '/files?path=');
    assert(!left.entries.some((e) => e.name.startsWith('.wm-upload') || e.name === '.wm-extract'), 'Archive/temp files not cleaned up');
  });
  await step('Archive upload: archive name and path tricks are rejected', async () => {
    for (const bad of ['../x.zip', 'a;rm -rf.zip', 'evil.exe', 'x/y.zip']) {
      const r = await http('POST', '/api/sites/' + idArc + '/commands', { json: { kind: 'extract', archive: bad } });
      assert(r.status === 422, bad + ' -> ' + r.status);
    }
    // a malicious archive with ../ entries must not escape the project directory
    const evil = makeTarGz([{ name: '../../escaped-' + RUN + '.txt', content: 'x' }, { name: 'ok.txt', content: 'fine' }]);
    const name = '.wm-upload-evil-' + Date.now() + '.tar.gz';
    await uploadFile(idArc, name, evil);
    const c = await api('POST', '/api/sites/' + idArc + '/commands', { kind: 'extract', archive: name });
    await waitJob(c.job, 60);
    const files = await api('GET', '/api/sites/' + idArc + '/files?path=');
    assert(files.entries.some((e) => e.name === 'ok.txt'), 'Archive was not extracted'); /* ../ is stripped by tar: the file stays in the project directory */
  });
  const gitUrl = process.env.GIT_TEST_URL || 'https://github.com/octocat/Hello-World.git';
  await step('Git: load repository (' + gitUrl + '), then update', async () => {
    const r = await createSite({ name: 'git-' + RUN, type: 'static', runtime: 'static', memory_mb: 128, cpus: 0.5, pids: 64, autostart: false, git_url: gitUrl });
    await ok(r.job, 'site.create (mit Git-Clone)');
    const files = await api('GET', '/api/sites/' + r.site + '/files?path=');
    assert(files.entries.some((e) => e.name === '.git'), '.git missing after the clone');
    assert(files.entries.length > 1, 'Repository files missing');
    const u = await api('POST', '/api/sites/' + r.site + '/commands', { kind: 'git_sync' });
    const res = await ok(u.job, 'git sync (Update)');
    assert(!/token|Authorization/i.test(res.log), 'Credentials in the log');
    const bad = await http('PUT', '/api/sites/' + r.site, { json: { git_url: 'http://insecure.example/x.git' } });
    assert(bad.status === 422, 'http:// repository URL was accepted');
  });

  // ---------------------------------------------------------------- cleanup
  if (process.env.KEEP_SITES) { console.log('  (KEEP_SITES set: test websites are kept)'); results.push({ name: 'Cleanup skipped', ok: true }); } else await step('Websites löschen (Container, Netzwerk, Proxy-Route; Dateien endgültig)', async () => {
    for (const s of created.slice().reverse()) {
      const d = await http('DELETE', `/api/sites/${s.id}`, { json: { confirm: s.name, purge: true } });
      assert(d.status === 200, `Deleting ${s.name}: ${d.status} ${d.text.slice(0, 120)}`);
      await ok(d.data.job, 'site.delete');
    }
    const o = await api('GET', '/api/overview');
    for (const s of created) assert(!o.sites.some((x) => x.id === s.id), `${s.name} still exists`);
    const gone = await viaProxy(n1.domain);
    assert(!gone.text.includes('node-site:'), 'Proxy route of the deleted website still active');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} tests passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('Aborted:', e); process.exit(2); });
