'use strict';
const fs = require('fs');
const { config, loadRuntimes } = require('./config');
const { docker, dockerStream } = require('./docker');
const { audit } = require('./audit');
const { validateExec } = require('./validate');
const sites = require('./sites');

const running = new Map(); // jobId -> handle

/**
 * Runs a validated command inside a throw-away, isolated container for one website.
 * `emit(line)` receives output lines. Resolves with the exit code.
 */
async function execInSite(id, rawReq, emit) {
  const req = validateExec(rawReq);
  const spec = sites.loadSpec(id);
  if (!spec) throw sites.httpError(404, 'Website is not known to the agent');
  const runtimes = loadRuntimes();
  const rt = runtimes.runtimes[spec.runtime];
  const p = sites.paths(id);

  if (req.kind === 'npm' && !rt.npm) {
    throw sites.httpError(422, 'npm commands are only available for Node.js runtimes');
  }
  const toolKind = req.kind === 'gitsync' || req.kind === 'extract';
  const toolDef = toolKind ? runtimes.tools.git : rt;
  const image = toolDef.image;
  if (running.has(req.jobId)) throw sites.httpError(409, 'Task is already running');

  // Env file for the job: the site's variables, but not the runtime-only NODE_ENV/PORT.
  const env = { ...spec.env };
  delete env.NODE_ENV;
  delete env.PORT;
  env.HOME = '/tmp';
  env.TZ = env.TZ || 'UTC';
  env.npm_config_cache = '/tmp/.npm';
  env.npm_config_update_notifier = 'false';
  env.COMPOSER_HOME = '/tmp/composer';
  env.COMPOSER_CACHE_DIR = '/tmp/composer-cache';
  env.COMPOSER_NO_INTERACTION = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  if (req.env) Object.assign(env, req.env);
  env.CI = 'true';
  const jobEnvFile = `${p.cfg}/env.job-${req.jobId}`;
  fs.writeFileSync(jobEnvFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });

  const mem = Math.min(Math.max(spec.memoryMb, 1024), 4096);
  const cname = `wm-job-${req.jobId}`;
  const args = [
    'run', '--rm', '--name', cname,
    '--label', 'drimzo.managed=true', '--label', `drimzo.job-site=${id}`,
    '--network', p.network, '--user', `${p.uid}:${p.uid}`,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', String(Math.max(spec.pids, 512)), '--memory', `${mem}m`, '--memory-swap', `${mem}m`, '--cpus', String(Math.max(spec.cpus, 1)),
    '--tmpfs', '/tmp:rw,nosuid,size=1g,mode=1777',
    '--env-file', jobEnvFile,
    '-v', `${p.files}:/app`, '-w', '/app',
  ];
  let tail = req.argv;
  if (toolKind) args.push('--entrypoint', 'sh');
  args.push(image, ...tail);

  audit('job.exec', { site: p.site, job: req.jobId, kind: req.kind, argv0: req.argv.slice(0, 3).join(' ').slice(0, 80) });
  const handle = {};
  running.set(req.jobId, handle);
  emit(`$ ${req.label || (req.kind === 'shell' ? req.argv[2] : req.argv.join(' '))}`);
  try {
    // make sure the image exists locally (pull can take a while and is shown to the user)
    const have = await docker(['image', 'inspect', image]);
    if (have.code !== 0) {
      emit(`Providing image ${image} …`);
      await sites.ensureImage(toolDef, emit);
    }
    const code = await dockerStream(args, emit, { timeoutSec: req.timeout, handle });
    return code;
  } finally {
    running.delete(req.jobId);
    fs.rmSync(jobEnvFile, { force: true });
    await docker(['rm', '-f', cname]);
  }
}

async function killJob(jobId) {
  const cname = `wm-job-${parseInt(jobId, 10)}`;
  const r = await docker(['kill', cname]);
  const h = running.get(parseInt(jobId, 10));
  if (h && h.kill) h.kill();
  audit('job.kill', { job: jobId, code: r.code });
  return r.code === 0;
}

module.exports = { execInSite, killJob };
