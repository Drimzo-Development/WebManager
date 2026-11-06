import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../api.ts';
import { Field, Loading, Notice, Panel, SaveBar } from '../forms.tsx';
import { parseEnv, parseList } from '../lines.ts';
import { siteHref } from '../routes.ts';
import { useLoad } from '../runtime.ts';
import { SiteFields, type SiteValues } from '../SiteFields.tsx';
import { COMMAND_DEFAULTS, defaultRuntime, selectableRuntimes, TYPE_LABEL, withoutErrors } from '../siteForm.ts';
import type { AppTemplate, Me, RuntimeDef } from '../types.ts';
import { ErrorNote } from '../ui.tsx';
import { JobLog } from './site/JobLog.tsx';
import { Rich } from '../Rich.tsx';

const TYPES = ['static', 'php', 'laravel', 'node', 'express', 'next', 'custom'];

function initial(type: string, runtimes: RuntimeDef[]): SiteValues {
  const [install, build, start] = COMMAND_DEFAULTS[type] ?? ['', '', ''];
  return {
    runtime: defaultRuntime(runtimes, type), internal_port: 3000, docroot: type === 'laravel' ? 'public' : '', git_url: '', git_branch: '', git_username: '', git_token: '',
    install_command: install, build_command: build, start_command: start, memory_mb: 512, cpus: 1, pids: 256, autostart: true,
  };
}

function Form({ runtimes, apps }: { runtimes: RuntimeDef[]; apps: AppTemplate[] }) {
  const [app, setApp] = useState('');
  const tpl = apps.find((a) => a.key === app) ?? null;
  const [type, setType] = useState('php');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [domains, setDomains] = useState('');
  const [env, setEnv] = useState('');
  const [v, setV] = useState(() => initial('php', runtimes));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ site: number; job: number } | null>(null);
  const [finished, setFinished] = useState<'ok' | 'failed' | null>(null);
  const set = (p: Partial<SiteValues>) => {
    setV((cur) => ({ ...cur, ...p }));
    setErrors((cur) => withoutErrors(cur, Object.keys(p)));
  };
  const fitting = selectableRuntimes(runtimes, type);
  // a new type brings its own runtime and command defaults
  const changeType = (t: string) => {
    setType(t);
    setV(initial(t, runtimes));
    setErrors({});
  };
  useEffect(() => {
    if (!fitting.some((r) => r.key === v.runtime) && fitting[0]) set({ runtime: fitting[0].key });
  }, [type]);

  async function submit(e: Event) {
    e.preventDefault();
    setError('');
    setErrors({});
    let envObj: Record<string, string>;
    try {
      envObj = parseEnv(env);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setBusy(true);
    try {
      setCreated(await api.post<{ site: number; job: number }>('/api/sites', { name, description, type, domains: parseList(domains), env: envObj, ...v, ...(tpl ? { app: tpl.key } : {}) }));
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length > 0) {
        setErrors(err.fields);
        setError('Please check the highlighted inputs.');
      } else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Panel title="Website is being created">
        <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>Container, network and proxy route are being set up. The first time this takes a little longer because the runtime is prepared.</p>
        <JobLog jobId={created.job} onFinished={(j) => setFinished(j.status === 'succeeded' ? 'ok' : 'failed')} />
        {finished === 'failed' && <Notice tone="err">Creating failed. The details are in the log above.</Notice>}
        <div class="row" style={{ marginTop: 'var(--sp-4)' }}>
          <a class="btn primary" href={siteHref(created.site)}>To the website</a>
          <a class="btn ghost" href="#/">To the overview</a>
        </div>
      </Panel>
    );
  }

  const nodeLike = ['node', 'express', 'next', 'custom'].includes(type);
  return (
    <form onSubmit={submit}>
      <div class="stack">
        {apps.length > 0 && (
          <Panel title="Start from">
            <div class="row" role="radiogroup" aria-label="Start from" style={{ flexWrap: 'wrap' }}>
              <button type="button" role="radio" aria-checked={app === ''} class={`btn${app === '' ? ' primary' : ''}`} onClick={() => setApp('')}>Blank website</button>
              {apps.map((a) => <button key={a.key} type="button" role="radio" aria-checked={app === a.key} class={`btn${app === a.key ? ' primary' : ''}`} onClick={() => setApp(a.key)}>{a.label}</button>)}
            </div>
            {tpl && (
              <p class="muted small" style={{ marginTop: 'var(--sp-3)' }}>
                {tpl.description}{tpl.database ? ` A ${tpl.database === 'mariadb' ? 'MariaDB' : 'PostgreSQL'} database is created and connected automatically.` : ''}
              </p>
            )}
          </Panel>
        )}
        <Panel title="General">
          <div class="form-grid">
            <div>
              <Field label="Name" htmlFor="ns-name"><input id="ns-name" class="input" required maxLength={100} placeholder="e.g. Customer portal" value={name} onInput={(e) => { setName(e.currentTarget.value); setErrors((c) => withoutErrors(c, ['name'])); }} /></Field>
              {errors.name && <span class="err-text small" role="alert">{errors.name}</span>}
            </div>
            <Field label="Description (optional)" htmlFor="ns-desc"><input id="ns-desc" class="input" maxLength={500} value={description} onInput={(e) => setDescription(e.currentTarget.value)} /></Field>
            {!tpl && <div>
              <Field label="Application type" htmlFor="ns-type">
                <select id="ns-type" class="input" value={type} onChange={(e) => changeType(e.currentTarget.value)}>
                  {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </select>
              </Field>
              {errors.type && <span class="err-text small" role="alert">{errors.type}</span>}
            </div>}
          </div>
          <Field label="Domains (one per line, optional)" htmlFor="ns-domains" hint="The domains must point to this server via DNS. You set up HTTPS after creating the site.">
            <textarea id="ns-domains" class="input mono" rows={2} spellcheck={false} placeholder="app1.example.com" value={domains} onInput={(e) => setDomains(e.currentTarget.value)} />
          </Field>
        </Panel>
        {tpl ? (
          <Notice tone="ok">{tpl.after || 'The website is set up for you.'} It starts with {tpl.memory_mb} MB of memory; you can change the limits later under Settings.</Notice>
        ) : (
        <Panel title="Application and limits">
          <SiteFields idp="ns" type={type} values={v} set={set} runtimes={fitting} errors={errors} />
          <Field label="Environment variables (NAME=value, one per line)" htmlFor="ns-env" hint="Values are stored encrypted.">
            <textarea id="ns-env" class="input mono" rows={3} spellcheck={false} autocomplete="off" placeholder="NODE_ENV=production" value={env} onInput={(e) => setEnv(e.currentTarget.value)} />
          </Field>
          {nodeLike && <p class="muted small"><Rich text="Without a Git repository the container is not started at first: upload your code under “Deploy → Commands” via Git or as a ZIP archive (or in the file manager), run {cmd} and start the website." with={{ cmd: <code>npm install</code> }} /></p>}
        </Panel>
        )}
        <SaveBar busy={busy} error={error} label="Create website">
          <a class="btn ghost" href="#/">Cancel</a>
        </SaveBar>
      </div>
    </form>
  );
}

export function NewSite({ me }: { me: Me }) {
  const rts = useLoad(() => api.get<{ runtimes: RuntimeDef[] }>('/api/runtimes'));
  const catalog = useLoad(() => api.get<{ apps: AppTemplate[] }>('/api/apps'));
  if (!['operator', 'admin'].includes(me.user.role)) {
    return <main><ErrorNote message="You do not have permission for this." /></main>;
  }
  return (
    <main>
      <div class="page-head">
        <div>
          <p class="crumbs muted"><a href="#/">Overview</a> / Websites /</p>
          <h1>New website</h1>
          <p class="muted">WebManager creates the container, network and proxy route automatically.</p>
        </div>
      </div>
      <Loading load={rts}>{(d) => <Form runtimes={d.runtimes} apps={catalog.data?.apps ?? []} />}</Loading>
    </main>
  );
}
