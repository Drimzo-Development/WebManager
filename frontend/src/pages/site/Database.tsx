import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { Field, Loading, Notice, Panel, SaveBar, Toggle, useSaver, ProgressButton } from '../../forms.tsx';
import { formatBytes, relativeTime } from '../../format.ts';
import { formatList, parseList } from '../../lines.ts';
import { toast, useLoad } from '../../runtime.ts';
import { Icon, Pill } from '../../ui.tsx';
import { fill } from '../../i18n.ts';
import { askConfirm } from '../../confirm.tsx';
import { Rich } from '../../Rich.tsx';

interface Db {
  available: { key: string; label: string }[];
  enabled: boolean;
  has_data: boolean;
  engine: string | null;
  engine_label: string | null;
  name: string;
  user: string;
  host: string;
  port: number | null;
  memory_mb: number;
  external: boolean;
  external_allow: string[];
  external_port: number | null;
  your_ip: string;
  admin: { running: boolean; expiresAt?: string | null };
  env_vars: string[];
  status: { exists?: boolean; state?: string; running?: boolean; health?: string | null; image?: string };
  dumps: { name: string; size: number; createdAt: string }[];
  agent_unreachable: boolean;
  busy: boolean;
}

interface Props {
  id: number;
  slug: string;
  siteName: string;
  onChanged: () => void;
}

function Enable({ id, db, reload }: { id: number; db: Db; reload: () => void }) {
  const [engine, setEngine] = useState(db.engine ?? db.available[0]?.key ?? '');
  const [mem, setMem] = useState(String(db.memory_mb || 256));
  const [on, setOn] = useState(db.enabled);
  useEffect(() => {
    setOn(db.enabled);
    setMem(String(db.memory_mb || 256));
  }, [db.enabled, db.memory_mb]);
  const save = useSaver(reload);
  const st = db.status;
  return (
    <Panel title="Database" actions={db.has_data && <Pill tone={st.running ? 'ok' : ''}>{st.running ? 'Running' : db.enabled ? 'Starting …' : 'Stopped'}</Pill>}>
      {db.agent_unreachable && <Notice tone="err">The database status is currently not available.</Notice>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // before the first setup there is no switch: submitting means "set it up"
          const enable = db.has_data ? on : true;
          void save.run(() => api.put(`/api/sites/${id}/database`, { enabled: enable, engine, memory_mb: Number(mem) }), enable ? 'Database is set up' : 'Database container stopped');
        }}
      >
        {!db.has_data && (
          <p class="muted small" style={{ marginBottom: 'var(--sp-4)' }}>Every website can get its own database in its own container. Until you switch it on, nothing exists.</p>
        )}
        <div class="form-grid">
          <Field label="Type" htmlFor="db-engine" hint={db.has_data ? 'The type can only be changed after the database and its data have been deleted.' : undefined}>
            <select id="db-engine" class="input" disabled={db.has_data} value={engine} onChange={(e) => setEngine(e.currentTarget.value)}>
              {db.available.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
            </select>
          </Field>
          <Field label="Memory (MB)" htmlFor="db-mem" hint="128 to 8192"><input id="db-mem" class="input" type="number" min={128} max={8192} step={64} value={mem} onInput={(e) => setMem(e.currentTarget.value)} /></Field>
        </div>
        {db.has_data ? (
          <Toggle id="db-on" checked={on} onChange={setOn} label="Database container is running" hint="Switching off stops the container; the data is kept." />
        ) : null}
        <SaveBar busy={save.busy || db.busy} error={save.error} label={db.has_data ? 'Save' : 'Set up database'} />
      </form>
    </Panel>
  );
}

function Connection({ id, db, reload }: { id: number; db: Db; reload: () => void }) {
  const [pw, setPw] = useState<string | null>(null);
  const hide = useRef<number | undefined>(undefined);
  const rotate = useSaver(() => {
    setPw(null);
    reload();
  });
  useEffect(() => () => clearTimeout(hide.current), []);
  async function reveal() {
    try {
      const r = await api.get<{ password: string }>(`/api/sites/${id}/database/password`);
      setPw(r.password);
      clearTimeout(hide.current);
      // do not leave the secret on screen
      hide.current = window.setTimeout(() => setPw(null), 30_000);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }
  const row = (k: string, v: string | number | null) => <div><span class="muted">{k}</span><span class="mono">{v ?? '–'}</span></div>;
  return (
    <Panel title="Credentials">
      <div class="rows">
        {row('Host (in the container network)', db.host)}
        {row('Port', db.port)}
        {row('Database', db.name)}
        {row('Users', db.user)}
        <div>
          <span class="muted">Password</span>
          <span class="mono">{pw ?? '••••••••••••'}</span>
        </div>
      </div>
      <div class="row" style={{ marginTop: 'var(--sp-4)' }}>
        {pw === null ? <button class="btn" onClick={reveal}><Icon name="eye" small />Show</button> : (
          <>
            <button class="btn" onClick={() => navigator.clipboard.writeText(pw).then(() => toast('Password copied'), () => toast('Copying not possible', 'err'))}>Copy</button>
            <button class="btn ghost" onClick={() => setPw(null)}>Hide</button>
          </>
        )}
        <ProgressButton
          class="btn ghost"
          busy={rotate.busy}
          progress={rotate.progress}
          onClick={async () => (await askConfirm('Renew database password?', 'Generate a new database password? The website receives it automatically; your own connections using the old password will break.', 'Renew password')) && void rotate.run(() => api.post(`/api/sites/${id}/database/rotate`), 'Password renewed')}
          label="Renew password"
        />
      </div>
      {rotate.error && <Notice tone="err">{rotate.error}</Notice>}
      <p class="muted small" style={{ marginTop: 'var(--sp-3)' }}>
        <Rich text="The website receives the credentials as environment variables: {vars}. Showing the password is logged." with={{ vars: db.env_vars.map((v, i) => <span key={v}><code>{v}</code>{i < db.env_vars.length - 1 ? ', ' : ''}</span>) }} />
      </p>
    </Panel>
  );
}

function Admin({ id, slug, db, reload }: { id: number; slug: string; db: Db; reload: () => void }) {
  const save = useSaver(reload);
  const running = db.admin.running;
  return (
    <Panel title="Management in the browser">
      <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>Briefly starts a web interface (Adminer) to view and edit the tables. It is only reachable with your sign-in and ends by itself.</p>
      <div class="row">
        {running ? (
          <>
            <a class="btn primary" href={`/dbadmin/${slug}/`} target="_blank" rel="noopener noreferrer"><Icon name="external-link" />Open management</a>
            <button class="btn" disabled={save.busy} onClick={() => void save.run(() => api.post(`/api/sites/${id}/database/manage/stop`), 'Management ended')}>End</button>
          </>
        ) : (
          <ProgressButton class="btn primary" busy={save.busy} progress={save.progress} disabled={!db.enabled} onClick={() => void save.run(() => api.post(`/api/sites/${id}/database/manage`), 'Management started')} label="Start management" />
        )}
      </div>
      {save.error && <Notice tone="err">{save.error}</Notice>}
    </Panel>
  );
}

function Dumps({ id, db, reload }: { id: number; db: Db; reload: () => void }) {
  const save = useSaver(reload);
  async function remove(name: string) {
    if (!(await askConfirm('Delete dump?', fill('Delete dump {name}?', { name }), 'Delete'))) return;
    try {
      await api.del(`/api/sites/${id}/database/dumps/${name}`);
      toast('Dump deleted');
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }
  return (
    <Panel title="Backups (dumps)" actions={<ProgressButton busy={save.busy} progress={save.progress} disabled={!db.enabled} onClick={() => void save.run(() => api.post(`/api/sites/${id}/database/dump`), 'Dump created')} label="Create dump" />}>
      {save.error && <Notice tone="err">{save.error}</Notice>}
      <div class="scroll-x">
        <table>
          <thead><tr><th>File</th><th>Size</th><th class="hide-sm">Created</th><th><span class="sr">Actions</span></th></tr></thead>
          <tbody>
            {db.dumps.map((d) => (
              <tr key={d.name}>
                <td class="mono">{d.name}</td>
                <td class="num">{formatBytes(d.size)}</td>
                <td class="hide-sm muted small">{relativeTime(d.createdAt)}</td>
                <td class="num">
                  <div class="row end" style={{ margin: 0 }}>
                    <a class="btn ghost icon" href={`/api/sites/${id}/database/dumps/${d.name}`} aria-label={fill('Download {name}', { name: d.name })} title="Download"><Icon name="archive" small /></a>
                    <button
                      class="btn ghost"
                      disabled={save.busy}
                      onClick={async () => (await askConfirm('Overwrite the database?', fill('Overwrite the database with {name}? The current contents will be lost.', { name: d.name }), 'Restore')) && void save.run(() => api.post(`/api/sites/${id}/database/restore`, { name: d.name, confirm: true }), 'Database restored')}
                    >Restore</button>
                    <button class="btn ghost icon" onClick={() => remove(d.name)} aria-label={fill('Delete {name}', { name: d.name })} title="Delete"><Icon name="trash" small /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {db.dumps.length === 0 && <p class="muted empty">No dumps yet. They are stored outside the web directory and can only be downloaded by you.</p>}
      </div>
    </Panel>
  );
}

function External({ id, db, reload }: { id: number; db: Db; reload: () => void }) {
  const [on, setOn] = useState(db.external);
  const [text, setText] = useState(formatList(db.external_allow));
  const key = db.external_allow.join('\n') + String(db.external);
  useEffect(() => {
    setOn(db.external);
    setText(formatList(db.external_allow));
  }, [key]);
  const save = useSaver(reload);
  return (
    <Panel title="External access">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save.run(() => api.put(`/api/sites/${id}/database/external`, { enabled: on, allow: parseList(text) }), on ? 'External access is enabled' : 'External access is blocked');
        }}
      >
        <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}><Rich text="Allows connections from specific addresses to port {port} of this server (e.g. for DBeaver or a dump to your own PC). All others are rejected. Your address: {ip}" with={{ port: <code>{db.external_port ?? '–'}</code>, ip: <code>{db.your_ip}</code> }} /></p>
        <Toggle id="dx-on" checked={on} onChange={setOn} label="Allow external access" />
        <Field label="Allowed addresses" htmlFor="dx-allow" hint="Addresses or networks (CIDR), one per line, at most 50. The whole internet (0.0.0.0/0) is not allowed."><textarea id="dx-allow" class="input mono" rows={3} spellcheck={false} value={text} onInput={(e) => setText(e.currentTarget.value)} /></Field>
        <SaveBar busy={save.busy} error={save.error} progress={save.progress} />
      </form>
    </Panel>
  );
}

function Purge({ id, siteName, reload }: { id: number; siteName: string; reload: () => void }) {
  const [name, setName] = useState('');
  const save = useSaver(reload);
  return (
    <Panel title="Delete the database permanently">
      <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}><Rich text="Deletes the database container {data}. This cannot be undone; create a dump first." with={{ data: <b>and all data</b> }} /></p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save.run(() => api.post(`/api/sites/${id}/database/purge`, { confirm: name }), 'Database deleted').then((ok) => ok && setName(''));
        }}
      >
        <Field label={fill('To confirm, enter the name of the website: {siteName}', { siteName })} htmlFor="db-purge"><input id="db-purge" class="input" autocomplete="off" value={name} onInput={(e) => setName(e.currentTarget.value)} /></Field>
        {save.error && <Notice tone="err">{save.error}</Notice>}
        <ProgressButton class="btn danger" type="submit" busy={save.busy} progress={save.progress} disabled={name !== siteName} label="Delete permanently" />
      </form>
    </Panel>
  );
}

export function DatabaseSection({ id, slug, siteName, onChanged }: Props) {
  const load = useLoad(() => api.get<Db>(`/api/sites/${id}/database`), 10_000);
  const reload = () => {
    load.reload();
    onChanged();
  };
  return (
    <Loading load={load}>
      {(db) => (
        <div class="stack">
          <Enable id={id} db={db} reload={reload} />
          {db.has_data && (
            <>
              <Connection id={id} db={db} reload={reload} />
              <Admin id={id} slug={slug} db={db} reload={reload} />
              <Dumps id={id} db={db} reload={reload} />
              <External id={id} db={db} reload={reload} />
              <Purge id={id} siteName={siteName} reload={reload} />
            </>
          )}
        </div>
      )}
    </Loading>
  );
}
