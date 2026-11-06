'use strict';
const { spawn } = require('child_process');

const ENV = { ...process.env, DOCKER_CONFIG: process.env.DOCKER_CONFIG || '/tmp/.docker', DOCKER_CLI_HINTS: 'false' };

/** Runs the docker CLI with an argument array (never through a shell). */
function docker(args, { timeout = 120000, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', (d) => { if (stdout.length < 8_000_000) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 1_000_000) stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: String(e.message) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: killed ? 124 : code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

async function dockerOk(args, opts) {
  const r = await docker(args, opts);
  if (r.code !== 0) {
    const err = new Error(`docker ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
    err.status = 502;
    err.result = r;
    throw err;
  }
  return r;
}

/**
 * Runs docker and streams output line by line. Resolves with the exit code.
 * `handle.kill()` terminates the CLI process (the caller kills the container separately).
 */
function dockerStream(args, onLine, { timeoutSec = 1800, handle = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    handle.kill = () => child.kill('SIGKILL');
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); onLine('[Time limit reached, task is being cancelled]'); }, timeoutSec * 1000);
    const pump = (stream) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, i).replace(/\r$/, '').slice(0, 8192));
          buf = buf.slice(i + 1);
        }
        if (buf.length > 65536) { onLine(buf.slice(0, 8192)); buf = ''; }
      });
      stream.on('end', () => { if (buf) onLine(buf.slice(0, 8192)); });
    };
    pump(child.stdout);
    pump(child.stderr);
    child.on('error', (e) => { clearTimeout(timer); onLine(`[Error: ${e.message}]`); resolve(127); });
    child.on('close', (code) => { clearTimeout(timer); resolve(timedOut ? 124 : (code ?? 1)); });
  });
}

module.exports = { docker, dockerOk, dockerStream };
