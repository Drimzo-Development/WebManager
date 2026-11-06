'use strict';
const http = require('http');

const BASE = new URL(process.env.AGENT_URL || 'http://agent:9000');
const TOKEN = process.env.AGENT_TOKEN_WORKER || '';

function opts(method, path, extra = {}) {
  return {
    method, hostname: BASE.hostname, port: BASE.port, path,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...extra },
  };
}

/** JSON request/response. Rejects with the agent's error message for non-2xx answers. */
function call(method, path, body, { timeoutMs = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(opts(method, path, data ? { 'Content-Length': Buffer.byteLength(data) } : {}), (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        let json = {};
        try { json = buf ? JSON.parse(buf) : {}; } catch (_) { /* ignore */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        const err = new Error(json.error || `Agent answered with HTTP ${res.statusCode}`);
        err.status = res.statusCode;
        reject(err);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout of the agent request')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * NDJSON streaming call. `onMsg` is invoked per message ({t:'out'|'exit'|'result', ...}).
 * Aborting `signal` destroys the connection, which makes the agent kill the container.
 */
function stream(method, path, body, onMsg, signal) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(opts(method, path, { 'Content-Length': Buffer.byteLength(data) }), (res) => {
      if (res.statusCode !== 200) {
        let buf = '';
        res.on('data', (d) => { buf += d; });
        res.on('end', () => {
          let m = `Agent answered with HTTP ${res.statusCode}`;
          try { m = JSON.parse(buf).error || m; } catch (_) { /* ignore */ }
          reject(new Error(m));
        });
        return;
      }
      let buf = '';
      res.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line) continue;
          try { onMsg(JSON.parse(line)); } catch (_) { /* ignore malformed */ }
        }
      });
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    req.on('error', (e) => reject(signal && signal.aborted ? Object.assign(new Error('Cancelled'), { aborted: true }) : e));
    if (signal) {
      if (signal.aborted) { req.destroy(); return; }
      signal.addEventListener('abort', () => req.destroy(), { once: true });
    }
    req.write(data);
    req.end();
  });
}

/** Raw (non-JSON) PUT, used to write a file into a site's directory. */
function putRaw(path, content) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(content, 'utf8');
    const req = http.request(opts('PUT', path, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length }), (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error(buf.slice(0, 200)))));
    });
    req.on('error', reject);
    req.end(data);
  });
}

module.exports = { call, stream, putRaw };
