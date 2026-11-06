import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import { Field, Loading, Notice, Panel, SaveBar, Toggle, useSaver } from '../forms.tsx';
import { relativeTime } from '../format.ts';
import { toast, useLoad } from '../runtime.ts';
import type { Me } from '../types.ts';
import { ErrorNote, Icon, Pill } from '../ui.tsx';
import { fill } from '../i18n.ts';
import { askConfirm } from '../confirm.tsx';

interface User {
  id: number;
  email: string;
  name: string;
  /** 'customer' only for old accounts of the removed customer role: they are switched off and cannot sign in */
  role: 'admin' | 'operator' | 'viewer' | 'customer';
  active: boolean;
  two_factor: boolean;
  created_at: string;
  last_login_at: string | null;
  self: boolean;
}

const ROLES: [User['role'], string][] = [
  ['admin', 'Administrator'], ['operator', 'Operator'], ['viewer', 'Viewer'],
];
const ROLE_HINT: Record<'admin' | 'operator' | 'viewer', string> = {
  admin: 'May do everything, including managing users and the system.',
  operator: 'May create and manage websites.',
  viewer: 'May only view websites and tasks.',
};
const label = (r: string) => ROLES.find((x) => x[0] === r)?.[1] ?? (r === 'customer' ? 'Customer (removed)' : r);

type Mode = { kind: 'new' } | { kind: 'edit' | 'password'; user: User } | null;

function NewUser({ onDone }: { onDone: (changed: boolean) => void }) {
  const [f, setF] = useState({ email: '', name: '', password: '', role: 'viewer' });
  const act = useSaver();
  return (
    <Panel title="New user">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(() => api.post('/api/users', f), 'User created').then((ok) => ok && onDone(true));
        }}
      >
        <div class="form-grid">
          <Field label="Email" htmlFor="nu-mail"><input id="nu-mail" class="input" type="email" required autocomplete="off" value={f.email} onInput={(e) => setF({ ...f, email: e.currentTarget.value })} /></Field>
          <Field label="Name (optional)" htmlFor="nu-name"><input id="nu-name" class="input" maxLength={100} value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} /></Field>
          <Field label="Password" htmlFor="nu-pw" hint="At least 12 characters, three of the four character classes. The user can change it under “My account”."><input id="nu-pw" class="input" type="password" required minLength={12} autocomplete="new-password" value={f.password} onInput={(e) => setF({ ...f, password: e.currentTarget.value })} /></Field>
          <Field label="Role" htmlFor="nu-role" hint={ROLE_HINT[f.role as keyof typeof ROLE_HINT]}>
            <select id="nu-role" class="input" value={f.role} onChange={(e) => setF({ ...f, role: e.currentTarget.value })}>{ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </Field>
        </div>
        <SaveBar busy={act.busy} error={act.error} progress={act.progress} label="Create user"><button class="btn ghost" type="button" onClick={() => onDone(false)}>Cancel</button></SaveBar>
      </form>
    </Panel>
  );
}

function Edit({ user, onDone }: { user: User; onDone: (changed: boolean) => void }) {
  const [f, setF] = useState({ name: user.name, role: user.role === 'customer' ? 'viewer' : (user.role as string), active: user.active });
  const act = useSaver();
  const reset = useSaver();
  return (
    <Panel title={fill('Edit: {email}', { email: user.email })}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(() => api.put(`/api/users/${user.id}`, f), 'Saved').then((ok) => ok && onDone(true));
        }}
      >
        <div class="form-grid">
          <Field label="Name" htmlFor="eu-name"><input id="eu-name" class="input" maxLength={100} value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} /></Field>
          <Field label="Role" htmlFor="eu-role" hint={ROLE_HINT[f.role as keyof typeof ROLE_HINT]}>
            <select id="eu-role" class="input" value={f.role} onChange={(e) => setF({ ...f, role: e.currentTarget.value })}>{ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </Field>
        </div>
        <Toggle id="eu-active" checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Account active" hint={user.self ? 'Your own account cannot be deactivated.' : 'Deactivated accounts cannot sign in; their API tokens stop working.'} />
        <SaveBar busy={act.busy} error={act.error} progress={act.progress}><button class="btn ghost" type="button" onClick={() => onDone(false)}>Cancel</button></SaveBar>
      </form>
      <hr />
      <h3 style={{ marginTop: 0 }}>Reset second factor</h3>
      <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>For users who lost their device and the recovery codes: authenticator app, passkeys and codes are removed, afterwards the password is enough to sign in, and the user sets up 2FA again.</p>
      <button class="btn danger" disabled={reset.busy || !user.two_factor} onClick={async () => (await askConfirm('Reset second factor?', fill('Reset the second factor of {email}?', { email: user.email }), 'Reset 2FA')) && void reset.run(() => api.post(`/api/users/${user.id}/2fa/reset`), 'Second factor reset').then((ok) => ok && onDone(true))}>Reset 2FA</button>
      {!user.two_factor && <span class="muted small"> {'This account has no second factor.'}</span>}
      {reset.error && <Notice tone="err">{reset.error}</Notice>}
    </Panel>
  );
}

function SetPassword({ user, onDone }: { user: User; onDone: (changed: boolean) => void }) {
  const [pw, setPw] = useState('');
  const act = useSaver();
  return (
    <Panel title={fill('New password for {email}', { email: user.email })}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(() => api.post(`/api/users/${user.id}/password`, { password: pw }), 'Password set').then((ok) => ok && onDone(true));
        }}
      >
        <Field label="New password" htmlFor="sp-pw" hint="At least 12 characters, three of the four character classes."><input id="sp-pw" class="input" type="password" required minLength={12} autocomplete="new-password" value={pw} onInput={(e) => setPw(e.currentTarget.value)} /></Field>
        <SaveBar busy={act.busy} error={act.error} progress={act.progress} label="Set password"><button class="btn ghost" type="button" onClick={() => onDone(false)}>Cancel</button></SaveBar>
      </form>
    </Panel>
  );
}

export function UsersPage({ me }: { me: Me }) {
  const load = useLoad(() => api.get<{ users: User[] }>('/api/users'));
  const [mode, setMode] = useState<Mode>(null);
  const done = (changed: boolean) => {
    setMode(null);
    if (changed) load.reload();
  };
  async function remove(u: User) {
    if (!(await askConfirm('Delete user?', fill('Delete user {email} permanently?', { email: u.email }), 'Delete'))) return;
    try {
      await api.del(`/api/users/${u.id}`);
      toast('User deleted');
      load.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }
  if (me.user.role !== 'admin') return <main><ErrorNote message="You do not have permission for this." /></main>;
  return (
    <main>
      <div class="page-head">
        <div>
          <p class="crumbs muted">Administration</p>
          <h1>Users</h1>
          <p class="muted">Who may sign in and what they can see and do.</p>
        </div>
        <button class="btn primary" disabled={mode !== null} onClick={() => setMode({ kind: 'new' })}><Icon name="plus" />New user</button>
      </div>
      {mode?.kind === 'new' && <NewUser onDone={done} />}
      {mode && mode.kind === 'edit' && <Edit key={mode.user.id} user={mode.user} onDone={done} />}
      {mode && mode.kind === 'password' && <SetPassword key={mode.user.id} user={mode.user} onDone={done} />}
      <Panel title="Accounts">
        <Loading load={load}>
          {(d) => (
            <div class="scroll-x">
              <table>
                <thead><tr><th>Users</th><th>Role</th><th class="hide-sm">2FA</th><th class="hide-sm hide-md">Last sign-in</th><th><span class="sr">Actions</span></th></tr></thead>
                <tbody>
                  {d.users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <span class="strong"><span translate={false}>{u.name || u.email}</span>{u.self && <span class="muted small"> {'(you)'}</span>}</span>
                        {u.name && <span class="muted small block">{u.email}</span>}
                        {!u.active && <Pill tone="err">deactivated</Pill>}
                      </td>
                      <td><span class="tag">{label(u.role)}</span></td>
                      <td class="hide-sm">{u.two_factor ? <Pill tone="ok">active</Pill> : <span class="muted small">off</span>}</td>
                      <td class="hide-sm hide-md muted small">{u.last_login_at ? relativeTime(u.last_login_at) : 'never'}</td>
                      <td class="num">
                        <div class="row end" style={{ margin: 0 }}>
                          <button class="btn ghost" onClick={() => setMode({ kind: 'edit', user: u })}>Edit</button>
                          <button class="btn ghost" onClick={() => setMode({ kind: 'password', user: u })}>Password</button>
                          <button class="btn ghost icon" aria-label={fill('Delete {email}', { email: u.email })} title="Delete" disabled={u.self} onClick={() => remove(u)}><Icon name="trash" small /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Loading>
      </Panel>
    </main>
  );
}
