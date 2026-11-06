import { useRef, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { relativeTime } from '../format.ts';
import { toast, useLoad } from '../runtime.ts';
import type { ApiTokenItem, Me } from '../types.ts';
import { ErrorNote, Icon, Pill } from '../ui.tsx';
import { ProgressButton } from '../forms.tsx';
import { fill, locale } from '../i18n.ts';
import { askConfirm } from '../confirm.tsx';
import { Rich } from '../Rich.tsx';

const ROLE_LABEL = { viewer: 'Viewer (read only)', operator: 'Operator (manage websites)', admin: 'Administrator' } as const;
const RANK = { viewer: 1, operator: 2, admin: 3 } as const;

interface ListAnswer {
  tokens: ApiTokenItem[];
  max: number;
}

export function Tokens({ me }: { me: Me }) {
  const list = useLoad(() => api.get<ListAnswer>('/api/account/tokens'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const reveal = useRef<HTMLDialogElement>(null);
  const role = me.user.role as keyof typeof RANK;
  const roles = (Object.keys(RANK) as (keyof typeof RANK)[]).filter((r) => RANK[r] <= (RANK[role] ?? 0));

  async function submit(e: Event) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const f = new FormData(form);
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ token: string }>('/api/account/tokens', {
        name: String(f.get('name') ?? ''),
        role: String(f.get('role') ?? 'viewer'),
        expires_days: Number(f.get('days') ?? 90),
        ip_allow: String(f.get('ip') ?? ''),
      });
      form.reset();
      setCreated(r.token);
      reveal.current?.showModal();
      list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(tk: ApiTokenItem) {
    if (!(await askConfirm('Revoke token?', fill('Revoke token “{name}” ({prefix}…)? Scripts that use it lose access immediately.', { name: tk.name, prefix: tk.prefix }), 'Revoke'))) return;
    try {
      await api.del(`/api/account/tokens/${tk.id}`);
      toast('Revoke token');
      list.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(created ?? '');
      toast('Copied to the clipboard');
    } catch {
      toast('Copying not possible, please select it by hand', 'err');
    }
  }

  const tokens = list.data?.tokens ?? [];
  return (
    <main>
      <div class="page-head">
        <div>
          <p class="crumbs muted">Account</p>
          <h1>API tokens</h1>
          <p class="muted"><Rich text="Access for scripts and automation through the API at {path}." with={{ path: <code>/api/v1</code> }} /></p>
        </div>
      </div>

      <div class="grid-2">
        <section class="card card-pad">
          <div class="card-head"><h2>Active tokens</h2>{list.data && <span class="muted small">{tokens.length} {'of'} {list.data.max}</span>}</div>
          {list.error && <ErrorNote message={list.error} onRetry={list.reload} />}
          <div class="scroll-x">
            <table>
              <thead><tr><th>Name</th><th>Permissions</th><th class="hide-sm">Last used</th><th>Expires</th><th><span class="sr">Action</span></th></tr></thead>
              <tbody>
                {tokens.map((tk) => (
                  <tr key={tk.id}>
                    <td>
                      <span class="strong" translate={false}>{tk.name}</span>
                      <span class="muted small block mono">{tk.prefix}…{tk.ip_allow ? fill(' · only {ip_allow}', { ip_allow: tk.ip_allow }) : ''}</span>
                    </td>
                    <td><span class="tag">{tk.role}</span></td>
                    <td class="hide-sm muted small">{tk.last_used_at ? `${relativeTime(tk.last_used_at)}${tk.last_used_ip ? ` · ${tk.last_used_ip}` : ''}` : 'never'}</td>
                    <td>{tk.expired ? <Pill tone="err">Expired</Pill> : <span class="small">{new Date(tk.expires_at).toLocaleDateString(locale())}</span>}</td>
                    <td class="num"><button class="btn ghost icon" onClick={() => revoke(tk)} aria-label={fill('Revoke {name}', { name: tk.name })} title="Revoke"><Icon name="trash" small /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list.data && tokens.length === 0 && <p class="muted empty">No tokens yet.</p>}
          </div>
        </section>

        <section class="card card-pad">
          <div class="card-head"><h2>New token</h2></div>
          <form onSubmit={submit}>
            <div class="field"><label for="tk-name">Name</label><input id="tk-name" name="name" class="input" required maxLength={80} placeholder="e.g. deploy script" /></div>
            <div class="field">
              <label for="tk-role">Permissions</label>
              <select id="tk-role" name="role" class="input">{roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
              <span class="muted small">A token never has more permissions than your account.</span>
            </div>
            <div class="field">
              <label for="tk-days">Validity</label>
              <select id="tk-days" name="days" class="input" defaultValue="90">
                <option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option><option value="365">365 days (maximum)</option>
              </select>
            </div>
            <div class="field">
              <label for="tk-ip">Allowed IP addresses (optional)</label>
              <input id="tk-ip" name="ip" class="input mono" placeholder="203.0.113.7, 198.51.100.0/24" />
              <span class="muted small">Empty = from anywhere. Recommended for fixed servers.</span>
            </div>
            {error && <ErrorNote message={error} />}
            <ProgressButton class="btn primary block" type="submit" busy={busy} label="Create token" />
          </form>
        </section>
      </div>

      <section class="card card-pad">
        <div class="card-head"><h2>How to use it</h2></div>
        <pre class="log"><span class="t">$</span> curl -H "Authorization: Bearer wmt_…" {location.origin}/api/v1/sites</pre>
        <p class="muted small" style={{ marginTop: 'var(--sp-3)' }}><Rich text="The full description is in {file}. Tokens cannot be managed through the API." with={{ file: <code>docs/openapi.yaml</code> }} /></p>
      </section>

      <dialog ref={reveal} class="reveal" aria-label="New token" onClose={() => setCreated(null)}>
        <div class="reveal-body">
          <h2>Token created</h2>
          <p class="muted small"><Rich text="Copy it now. For security reasons it is shown {once}." with={{ once: <b>this one time only</b> }} /></p>
          <pre class="log token" tabIndex={0}>{created}</pre>
          <div class="row end">
            <button class="btn" onClick={copy}>Copy</button>
            <button class="btn primary" onClick={() => reveal.current?.close()}>Done, I have saved it</button>
          </div>
        </div>
      </dialog>
    </main>
  );
}
