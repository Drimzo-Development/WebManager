import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { Field, Notice, Panel, Toggle } from '../../forms.tsx';
import { archiveName, siteBody } from '../../siteForm.ts';
import { toast, useLoad } from '../../runtime.ts';
import type { Job, SiteDetail } from '../../types.ts';
import { JobLog } from './JobLog.tsx';
import { fill } from '../../i18n.ts';

interface Props {
  id: number;
  d: SiteDetail;
  onChanged: () => void;
}

const failure = (e: unknown) => (e instanceof Error ? e.message : String(e));

const LARAVEL: [string, string, string][] = [
  ['composer_install', 'composer install', 'composer install --no-dev --optimize-autoloader'],
  ['artisan_migrate', 'php artisan migrate --force', 'Run database migrations'],
  ['artisan_storage_link', 'storage:link', 'Create the public/storage symlink'],
  ['artisan_optimize', 'optimize', 'Cache config, routes and views'],
  ['artisan_optimize_clear', 'optimize:clear', 'Clear caches'],
];

export function CommandsSection({ id, d, onChanged }: Props) {
  const site = d.site;
  const isNode = !!d.runtimes.find((r) => r.key === site.runtime)?.npm;
  const [jobId, setJobId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [restart, setRestart] = useState(false);
  const [script, setScript] = useState('');
  // code source
  const [git, setGit] = useState({ url: site.git_url, branch: site.git_branch, user: site.git_username, token: '' });
  const [runInstall, setRunInstall] = useState(!!site.install_command);
  const [runBuild, setRunBuild] = useState(!!site.build_command);
  const [restartAfter, setRestartAfter] = useState(true);
  const [strip, setStrip] = useState(true);
  const file = useRef<HTMLInputElement>(null);
  const scripts = useLoad(() => (isNode ? api.get<{ exists: boolean; scripts: string[] }>(`/api/sites/${id}/scripts`) : Promise.resolve({ exists: false, scripts: [] as string[] })));

  // pick up a command that is still running after a reload
  useEffect(() => {
    api.get<{ jobs: Job[] }>(`/api/v1/sites/${id}/jobs`).then(
      (r) => {
        const active = r.jobs.find((j) => j.type === 'site.exec' && ['queued', 'running', 'cancelling'].includes(j.status));
        if (active) setJobId(active.id);
      },
      () => undefined,
    );
  }, [id]);
  useEffect(() => {
    const first = scripts.data?.scripts[0];
    if (first && !script) setScript(first);
  }, [scripts.data]);

  const start = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await api.post<{ job: number }>(`/api/sites/${id}/commands`, body);
      setJobId(r.job);
      return true;
    } catch (e) {
      toast(failure(e), 'err');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const run = (kind: string, extra: Record<string, unknown> = {}) => start({ kind, restart_after: restart, ...extra });
  const common = { run_install: runInstall, run_build: runBuild, restart_after: restartAfter };

  async function fromGit(e: Event) {
    e.preventDefault();
    if (!git.url.trim()) return toast('Please enter a repository URL.', 'err');
    setBusy(true);
    try {
      // the repository belongs to the site's configuration, so it is saved first (an empty token keeps the stored one)
      await api.put(`/api/sites/${id}`, siteBody(site, { git_url: git.url.trim(), git_branch: git.branch.trim(), git_username: git.user.trim(), ...(git.token ? { git_token: git.token } : {}) }));
      const r = await api.post<{ job: number }>(`/api/sites/${id}/commands`, { kind: 'git_sync', ...common });
      setGit((g) => ({ ...g, token: '' }));
      setJobId(r.job);
      onChanged();
    } catch (err) {
      toast(failure(err), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function fromArchive(e: Event) {
    e.preventDefault();
    const f = file.current?.files?.[0];
    if (!f) return toast('Please choose an archive first.', 'err');
    const safe = archiveName(f.name);
    if (!safe) return toast('Allowed: .zip, .tar.gz and .tgz.', 'err');
    setBusy(true);
    try {
      toast(fill('“{name}” is being uploaded …', { name: f.name }));
      const body = new FormData();
      // the temporary name never contains anything from the original file name
      body.append('file[]', new File([f], safe));
      const up = await api.post<{ results: { ok: boolean; error?: string }[] }>(`/api/sites/${id}/files/upload?path=`, body);
      if (!up.results[0]?.ok) throw new Error(up.results[0]?.error ?? 'Upload failed');
      const r = await api.post<{ job: number }>(`/api/sites/${id}/commands`, { kind: 'extract', archive: safe, strip, ...common });
      if (file.current) file.current.value = '';
      setJobId(r.job);
    } catch (err) {
      toast(failure(err), 'err');
    } finally {
      setBusy(false);
    }
  }

  const options = (
    <div class="row">
      {site.install_command && <label class="check small"><input type="checkbox" checked={runInstall} onChange={(e) => setRunInstall(e.currentTarget.checked)} /> {'then install command'}</label>}
      {site.build_command && <label class="check small"><input type="checkbox" checked={runBuild} onChange={(e) => setRunBuild(e.currentTarget.checked)} /> {'then build command'}</label>}
      <label class="check small"><input type="checkbox" checked={restartAfter} onChange={(e) => setRestartAfter(e.currentTarget.checked)} /> {'then restart'}</label>
    </div>
  );

  return (
    <div class="stack">
      <Panel title="Commands">
        <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>{'Commands run in an isolated throwaway container (without privileges, with the website\'s resource limits) in the project directory.'}</p>
        <div class="row">
          {isNode && <button class="btn" disabled={busy} onClick={() => run('npm_install')}>npm install</button>}
          {isNode && <button class="btn" disabled={busy} onClick={() => run('npm_ci')}>npm ci</button>}
          {site.install_command && <button class="btn" disabled={busy} title={site.install_command} onClick={() => run('install')}>Install command</button>}
          {site.build_command && <button class="btn" disabled={busy} title={site.build_command} onClick={() => run('build')}>Build command</button>}
          {!isNode && !site.install_command && !site.build_command && site.type !== 'laravel' && <span class="muted small">No commands are configured for this website type.</span>}
        </div>
        <Toggle id="cmd-restart" checked={restart} onChange={setRestart} label="Restart the application after a successful command" />
        {isNode && (
          <div class="row" style={{ marginTop: 'var(--sp-3)' }}>
            <b class="small">package.json scripts:</b>
            <select class="input inline" aria-label="Script" value={script} onChange={(e) => setScript(e.currentTarget.value)} disabled={!scripts.data?.scripts.length}>
              {!scripts.data ? <option>Loading scripts …</option> : !scripts.data.exists ? <option>No package.json found</option> : !scripts.data.scripts.length ? <option>No scripts defined</option> : scripts.data.scripts.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button class="btn primary" disabled={busy || !script || !scripts.data?.scripts.length} onClick={() => run('npm_script', { script })}>Run npm script</button>
            <button class="btn ghost" onClick={scripts.reload}>Reload</button>
          </div>
        )}
      </Panel>

      {site.type === 'laravel' && (
        <Panel title="Laravel">
          <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>{'Fixed, safe shortcuts (no free shell access). They run in the isolated container with your environment variables (APP_KEY, DB_* etc. under “Environment”).'}</p>
          <div class="row">{LARAVEL.map(([kind, label, title]) => <button key={kind} class="btn" disabled={busy} title={title} onClick={() => start({ kind, restart_after: false })}>{label}</button>)}</div>
        </Panel>
      )}

      <Panel title="Load code">
        <form onSubmit={fromGit}>
          <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>Source 1: Git repository (GitHub, Gitea, GitLab or any other https server). Cloned the first time, updated afterwards; local changes to versioned files are overwritten.</p>
          <div class="form-grid">
            <div class="span-2"><Field label="Repository (https)" htmlFor="cd-url"><input id="cd-url" class="input mono" autocomplete="off" placeholder="https://github.com/user/project.git" value={git.url} onInput={(e) => setGit({ ...git, url: e.currentTarget.value })} /></Field></div>
            <Field label="Branch (optional)" htmlFor="cd-branch"><input id="cd-branch" class="input" autocomplete="off" placeholder="main" value={git.branch} onInput={(e) => setGit({ ...git, branch: e.currentTarget.value })} /></Field>
            <Field label="Username (optional)" htmlFor="cd-user" hint="Anything works with GitHub."><input id="cd-user" class="input" autocomplete="off" value={git.user} onInput={(e) => setGit({ ...git, user: e.currentTarget.value })} /></Field>
            <Field label="Access token (private repositories)" htmlFor="cd-token" hint="Stored encrypted and never shown."><input id="cd-token" class="input" type="password" autocomplete="new-password" placeholder={site.has_git_token ? 'saved, leave empty to keep' : 'optional'} value={git.token} onInput={(e) => setGit({ ...git, token: e.currentTarget.value })} /></Field>
          </div>
          {options}
          <div style={{ marginTop: 'var(--sp-3)' }}><button class="btn primary" type="submit" disabled={busy}>{site.git_url ? 'Save and update from Git' : 'Save and load from Git'}</button></div>
        </form>
        <hr />
        <form onSubmit={fromArchive}>
          <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>Source 2: archive (.zip, .tar.gz, .tgz, up to 128 MB). The contents are extracted into the project directory; existing files with the same name are overwritten, others are kept.</p>
          <div class="row"><input ref={file} type="file" accept=".zip,.tar.gz,.tgz" aria-label="Archive" /><label class="check small"><input type="checkbox" checked={strip} onChange={(e) => setStrip(e.currentTarget.checked)} /> {'flatten a single top-level folder in the archive'}</label></div>
          <div style={{ margin: 'var(--sp-3) 0' }}>{options}</div>
          <button class="btn primary" type="submit" disabled={busy}>Upload and extract</button>
        </form>
      </Panel>

      {jobId !== null ? (
        <Panel title="Output"><JobLog jobId={jobId} onFinished={() => onChanged()} /></Panel>
      ) : (
        <Notice tone="ok">The output of a command appears here as soon as you start one.</Notice>
      )}
    </div>
  );
}
