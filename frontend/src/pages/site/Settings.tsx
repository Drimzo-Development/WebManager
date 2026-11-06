import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../../api.ts';
import { Field, Notice, Panel, SaveBar, Toggle, ProgressButton } from '../../forms.tsx';
import { siteHref } from '../../routes.ts';
import { SiteFields, type SiteValues } from '../../SiteFields.tsx';
import { selectableRuntimes, siteBody, TYPE_LABEL, withoutErrors, type SiteInfo } from '../../siteForm.ts';
import { waitForJob } from '../../jobs.ts';
import { toast } from '../../runtime.ts';
import type { SiteDetail } from '../../types.ts';
import { ActionButton } from './Actions.tsx';
import { JobLog } from './JobLog.tsx';
import { fill } from '../../i18n.ts';
import { Rich } from '../../Rich.tsx';

interface Props {
  id: number;
  d: SiteDetail;
  onChanged: () => void;
}

const valuesOf = (s: SiteInfo): SiteValues & { name: string; description: string } => ({
  name: s.name, description: s.description, runtime: s.runtime, internal_port: s.internal_port, docroot: s.docroot,
  git_url: s.git_url, git_branch: s.git_branch, git_username: s.git_username, git_token: '', install_command: s.install_command,
  build_command: s.build_command, start_command: s.start_command, memory_mb: s.memory_mb, cpus: s.cpus, pids: s.pids, autostart: s.autostart,
});

function General({ id, d, onChanged }: Props) {
  const [v, setV] = useState(() => valuesOf(d.site));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // reset when the server's copy changes (after saving), not on every poll
  const serverKey = JSON.stringify(siteBody(d.site));
  useEffect(() => setV(valuesOf(d.site)), [serverKey]);
  const set = (p: Partial<typeof v>) => {
    setV((cur) => ({ ...cur, ...p }));
    setErrors((cur) => withoutErrors(cur, Object.keys(p)));
  };
  const runtimes = selectableRuntimes(d.runtimes, d.site.type, d.site.runtime);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setErrors({});
    try {
      const { git_token, ...rest } = v;
      const r = await api.put<{ job: number }>(`/api/sites/${id}`, siteBody(d.site, { ...rest, ...(git_token ? { git_token } : {}) }));
      const done = await waitForJob(r.job);
      toast(done ? 'Saved and applied' : 'Saved, the configuration is still being applied');
      set({ git_token: '' });
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length > 0) {
        setErrors(err.fields);
        setError('Please check the highlighted inputs.');
      } else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Settings">
      <form onSubmit={submit}>
        <div class="form-grid">
          <div>
            <Field label="Name" htmlFor="st-name"><input id="st-name" class="input" required maxLength={100} value={v.name} onInput={(e) => set({ name: e.currentTarget.value })} /></Field>
            {errors.name && <span class="err-text small" role="alert">{errors.name}</span>}
          </div>
          <Field label="Description" htmlFor="st-desc"><input id="st-desc" class="input" maxLength={500} value={v.description} onInput={(e) => set({ description: e.currentTarget.value })} /></Field>
        </div>
        <p class="muted small" style={{ marginBottom: 'var(--sp-4)' }}><Rich text="Application type: {type} (cannot be changed later)." with={{ type: <b>{TYPE_LABEL[d.site.type] ?? d.site.type}</b> }} /></p>
        <SiteFields idp="st" type={d.site.type} values={v} set={set} runtimes={runtimes} errors={errors} tokenSaved={d.site.has_git_token} />
        <p class="muted small" style={{ margin: 'var(--sp-3) 0' }}>Changes to image, port, limits or commands recreate the container.</p>
        <SaveBar busy={busy} error={error} label="Save and apply">
          <ActionButton id={id} action="apply" icon="refresh" label="Update container" onDone={onChanged} />
        </SaveBar>
      </form>
    </Panel>
  );
}

function Duplicate({ id, d }: Props) {
  const [name, setName] = useState(fill('{name} (copy)', { name: d.site.name }));
  const [files, setFiles] = useState(true);
  const [env, setEnv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState<{ site: number; job: number } | null>(null);
  const [finished, setFinished] = useState(false);
  return (
    <Panel title="Duplicate website">
      <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>Creates a copy (for example for staging). The copy gets no domain, no password protection and no maintenance mode; assign it its own domain afterwards.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            setFinished(false);
            setJob(await api.post<{ site: number; job: number }>(`/api/sites/${id}/duplicate`, { name: name.trim(), copy_files: files, copy_env: env }));
          } catch (err) {
            setError(err instanceof ApiError && Object.keys(err.fields).length ? Object.values(err.fields).join(' ') : err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Name of the copy" htmlFor="dp-name"><input id="dp-name" class="input" required maxLength={100} value={name} onInput={(e) => setName(e.currentTarget.value)} /></Field>
        <Toggle id="dp-files" checked={files} onChange={setFiles} label="Copy the files too" />
        <Toggle id="dp-env" checked={env} onChange={setEnv} label="Copy the environment variables too" hint="They often contain credentials; the copy will then use them as well." />
        <SaveBar busy={busy} error={error} label="Create copy" disabled={busy || (job !== null && !finished)} />
      </form>
      {job && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <JobLog
            jobId={job.job}
            onFinished={(j) => {
              if (j.status === 'succeeded') setFinished(true);
              else {
                setError('The copy could not be created. The details are in the task log.');
                setJob(null);
              }
            }}
          />
          {finished && <p style={{ marginTop: 'var(--sp-3)' }}><a class="btn primary" href={siteHref(job.site)}>To the copy</a></p>}
        </div>
      )}
    </Panel>
  );
}

function Delete({ id, d }: Props) {
  const [name, setName] = useState('');
  const [purge, setPurge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState<number | null>(null);
  return (
    <Panel title="Delete website">
      <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}><Rich text="Container, network and proxy route are removed. By default the files are only moved to the trash folder ({dir})." with={{ dir: <code>trash/</code> }} /></p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const r = await api.del<{ job: number }>(`/api/sites/${id}`, { confirm: name, purge });
            setJob(r.job);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={fill('To confirm, enter the name: {name}', { name: d.site.name })} htmlFor="dl-name"><input id="dl-name" class="input" autocomplete="off" value={name} onInput={(e) => setName(e.currentTarget.value)} /></Field>
        <Toggle id="dl-purge" checked={purge} onChange={setPurge} label="Delete files permanently" hint="Instead of moving them to the trash. This cannot be undone." />
        {error && <Notice tone="err">{error}</Notice>}
        <ProgressButton class="btn danger" type="submit" busy={busy} disabled={name !== d.site.name || job !== null} label="Delete website" />
      </form>
      {job !== null && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <JobLog jobId={job} onFinished={(j) => { if (j.status === 'succeeded') { toast('Website deleted'); location.hash = '#/'; } }} />
        </div>
      )}
    </Panel>
  );
}

export function SettingsSection(props: Props) {
  return (
    <div class="stack">
      <General {...props} />
      <Duplicate {...props} />
      <Delete {...props} />
    </div>
  );
}
