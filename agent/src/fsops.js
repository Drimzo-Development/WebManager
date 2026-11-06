'use strict';
const path = require('path');
const { spawn } = require('child_process');
const { config } = require('./config');
const { siteName } = require('./validate');

const ROOTS = { files: 'files', logs: 'logs' };

function rootFor(siteId, which) {
  if (!Object.prototype.hasOwnProperty.call(ROOTS, which)) {
    const e = new Error('Unbekanntes Verzeichnis'); e.status = 400; throw e;
  }
  return path.join(config.SITES_DIR, siteName(siteId), ROOTS[which]);
}

function spawnWorker(siteId, req) {
  const uid = config.uidBase + siteId;
  return spawn(process.execPath, [path.join(__dirname, 'fsworker.js'), JSON.stringify(req)], {
    uid, gid: uid, cwd: '/', stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
  });
}

/** Runs a JSON-returning file operation. `input` may be a Readable to pipe into the worker. */
function fsJson(siteId, which, op, params = {}, input = null) {
  return new Promise((resolve, reject) => {
    const req = { op, root: rootFor(siteId, which), ...params };
    const child = spawnWorker(siteId, req);
    let out = '';
    child.stdout.on('data', (d) => { if (out.length < 16_000_000) out += d; });
    child.stderr.on('data', () => {});
    child.on('error', (e) => reject(Object.assign(new Error(`File operation failed: ${e.message}`), { status: 500 })));
    child.on('close', () => {
      let parsed;
      try { parsed = JSON.parse(out); } catch (_) { return reject(Object.assign(new Error('File operation failed'), { status: 500 })); }
      if (!parsed.ok) return reject(Object.assign(new Error(parsed.error || 'Error'), { status: 400 }));
      resolve(parsed);
    });
    child.stdin.on('error', () => {});
    if (input) {
      input.pipe(child.stdin);
      input.on('error', () => child.kill('SIGKILL'));
    } else child.stdin.end();
  });
}

/** Streams the output of a worker operation into `res`; an error is reported as JSON before anything else was sent. */
function fsStream(siteId, which, req, headers, res) {
  const child = spawnWorker(siteId, { ...req, root: rootFor(siteId, which) });
  let started = false;
  res.on('close', () => { if (child.exitCode === null) child.kill('SIGKILL'); }); // the client went away
  child.stdout.once('data', (first) => {
    // An error is reported as JSON starting with {"ok":false
    if (first.slice(0, 11).toString() === '{"ok":false') {
      let msg = first.toString();
      child.stdout.on('data', (d) => { msg += d; });
      child.on('close', () => {
        let m = 'Error';
        try { m = JSON.parse(msg).error; } catch (_) { /* ignore */ }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: m }));
      });
      return;
    }
    started = true;
    res.writeHead(200, { ...headers, 'X-Content-Type-Options': 'nosniff' });
    res.write(first);
    child.stdout.pipe(res);
  });
  child.on('close', () => { if (!started && !res.headersSent) { res.writeHead(500); res.end(); } });
  child.stdin.end();
}

const attachment = (name) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;

/** Streams a file download from the worker into `res`. */
function fsDownload(siteId, which, rel, res) {
  fsStream(siteId, which, { op: 'download', rel }, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': attachment(path.basename(rel)) }, res);
}

/** Streams a ZIP archive of `names` (entries of the folder `dir`) into `res`. */
function fsArchive(siteId, which, dir, names, filename, res) {
  fsStream(siteId, which, { op: 'zip', rel: dir, names }, { 'Content-Type': 'application/zip', 'Content-Disposition': attachment(filename) }, res);
}

module.exports = { fsJson, fsDownload, fsArchive };
