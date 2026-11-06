import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { Field, Loading, Notice, Panel, SaveBar, useSaver } from '../forms.tsx';
import { relativeTime } from '../format.ts';
import { usePasswordPrompt } from '../prompt.tsx';
import { qrDataUrl } from '../qr.ts';
import { toast, useLoad } from '../runtime.ts';
import { registerMessage, registerPasskey, passkeysSupported } from '../webauthn.ts';
import { ErrorNote, Icon, LanguageSelect } from '../ui.tsx';
import { availableLanguages, fill, locale } from '../i18n.ts';
import { Rich } from '../Rich.tsx';

interface Account {
  email: string;
  name: string;
  role: string;
  two_factor: boolean;
  totp: boolean;
  passkeys: { id: number; name: string; created_at: string; last_used_at: string | null }[];
  passkeys_possible: boolean;
  recovery_left: number;
  two_factor_required: boolean;
}

const ROLE: Record<string, string> = { admin: 'Administrator', operator: 'Operator', viewer: 'Viewer' };
const failure = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Codes({ codes, fresh, onDone }: { codes: string[]; fresh: boolean; onDone: () => void }) {
  return (
    <>
      <Notice tone="ok">{fresh ? 'Two-factor authentication is now active.' : 'New recovery codes were created; the old ones are no longer valid.'}</Notice>
      <p>{'Keep these codes safe (for example in your password manager). Each code works once if you lose your device.'} <b>They will not be shown again.</b></p>
      <pre class="log token" tabIndex={0}>{codes.join('\n')}</pre>
      <div class="row end">
        <button class="btn" onClick={() => navigator.clipboard.writeText(codes.join('\n')).then(() => toast('Copied'), () => toast('Copying not possible', 'err'))}>Copy</button>
        <button class="btn primary" onClick={onDone}>Done, I have saved them</button>
      </div>
    </>
  );
}

function Totp({ a, reload }: { a: Account; reload: () => void }) {
  const pp = usePasswordPrompt();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<{ list: string[]; fresh: boolean } | null>(null);
  const act = useSaver();
  useEffect(() => {
    setQr('');
    if (setup) qrDataUrl(setup.uri).then(setQr, () => setQr(''));
  }, [setup?.uri]);

  const withPassword = async (title: string, text: string, ok: string, fn: (password: string) => Promise<void>) => {
    const r = await pp.prompt(title, text, ok);
    if (r) await fn(r.password);
  };

  if (codes) return <><Codes codes={codes.list} fresh={codes.fresh} onDone={() => { setCodes(null); reload(); }} />{pp.dialog}</>;

  if (setup) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(async () => {
            const r = await api.post<{ recovery_codes: string[] }>('/api/account/2fa/enable', { code });
            setSetup(null);
            setCode('');
            setCodes({ list: r.recovery_codes, fresh: true });
          }, 'Two-factor authentication enabled');
        }}
      >
        <ol class="steps">
          <li>{'Open your authenticator app and scan this QR code:'}{qr ? <div class="qr-box"><img class="qr" src={qr} width={220} height={220} alt="QR code for setting up the authenticator app" /></div> : <p class="muted small">Generating QR code …</p>}</li>
          <li><Rich text="Or enter the key by hand: {key}" with={{ key: <code class="secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code> }} /></li>
          <li>To confirm, enter the 6-digit code currently shown:</li>
        </ol>
        <Field label="Code" htmlFor="tp-code"><input id="tp-code" class="input inline" inputMode="numeric" autocomplete="one-time-code" maxLength={8} placeholder="123456" required autofocus value={code} onInput={(e) => setCode(e.currentTarget.value)} /></Field>
        <SaveBar busy={act.busy} error={act.error} progress={act.progress} label="Activate"><button class="btn ghost" type="button" onClick={() => setSetup(null)}>Cancel</button></SaveBar>
      </form>
    );
  }

  return (
    <>
      {a.totp ? (
        <>
          <Notice tone="ok"><Rich text="Two-factor authentication is active. Recovery codes remaining: {n}." with={{ n: a.recovery_left }} /></Notice>
          <div class="row">
            <button class="btn" onClick={() => withPassword('New recovery codes', 'The previous codes become invalid.', 'Create', async (password) => { try { const r = await api.post<{ recovery_codes: string[] }>('/api/account/2fa/recovery', { password }); setCodes({ list: r.recovery_codes, fresh: false }); } catch (e) { toast(failure(e), 'err'); } })}>New recovery codes</button>
            {!(a.two_factor_required && a.passkeys.length === 0) && (
              <button class="btn danger" onClick={() => withPassword('Remove the authenticator app?', 'Afterwards the account is protected only by the password (and any passkeys).', 'Remove', async (password) => { try { await api.post('/api/account/2fa/disable', { password }); toast('Authenticator app removed'); reload(); } catch (e) { toast(failure(e), 'err'); } })}>Remove authenticator app</button>
            )}
          </div>
        </>
      ) : (
        <>
          <Notice tone={a.passkeys.length ? 'ok' : 'warn'}>{a.passkeys.length ? fill('The authenticator app is not set up, but your account is protected by {v}.', { v: a.passkeys.length === 1 ? 'a passkey' : fill('{length} passkeys', { length: a.passkeys.length }) }) : 'Two-factor authentication is not active.'}</Notice>
          <div class="row"><button class={`btn${a.passkeys.length ? '' : ' primary'}`} onClick={() => withPassword('Set up two-factor authentication', 'For your security, your password is requested.', 'Continue', async (password) => { try { setSetup(await api.post<{ secret: string; uri: string }>('/api/account/2fa/setup', { password })); } catch (e) { toast(failure(e), 'err'); } })}>Set up authenticator app</button></div>
        </>
      )}
      {pp.dialog}
    </>
  );
}

function Passkeys({ a, reload }: { a: Account; reload: () => void }) {
  const pp = usePasswordPrompt();
  const [codes, setCodes] = useState<string[] | null>(null);
  const supported = passkeysSupported() && a.passkeys_possible;

  async function add() {
    const r = await pp.prompt('Add a passkey', 'Afterwards the browser opens your device or password manager dialog for confirmation.', 'Continue', { label: 'Name of the passkey', placeholder: 'e.g. laptop, iPhone, security key' });
    if (!r) return;
    try {
      const res = await registerPasskey(r.field.trim(), r.password);
      toast('Passkey set up');
      if (res.recovery_codes) setCodes(res.recovery_codes);
      else reload();
    } catch (e) {
      toast(registerMessage(e), 'err');
    }
  }
  async function remove(p: Account['passkeys'][number]) {
    const r = await pp.prompt('Remove the passkey?', fill('“{name}” can no longer be used to sign in afterwards.', { name: p.name }), 'Remove');
    if (!r) return;
    try {
      await api.post(`/api/account/passkeys/${p.id}/remove`, { password: r.password });
      toast('Passkey removed');
      reload();
    } catch (e) {
      toast(failure(e), 'err');
    }
  }

  if (codes) return <Codes codes={codes} fresh onDone={() => { setCodes(null); reload(); }} />;
  return (
    <>
      {a.passkeys.length > 0 ? (
        <div class="scroll-x">
          <table>
            <thead><tr><th>Name</th><th class="hide-sm">Set up</th><th class="hide-sm">Last used</th><th><span class="sr">Action</span></th></tr></thead>
            <tbody>
              {a.passkeys.map((p) => (
                <tr key={p.id}>
                  <td class="strong">{p.name}</td>
                  <td class="hide-sm muted small">{new Date(p.created_at).toLocaleDateString(locale())}</td>
                  <td class="hide-sm muted small">{p.last_used_at ? relativeTime(p.last_used_at) : 'never'}</td>
                  <td class="num"><button class="btn ghost icon" aria-label={fill('Remove {name}', { name: p.name })} title="Remove" onClick={() => remove(p)}><Icon name="trash" small /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p class="muted small">No passkey set up yet.</p>}
      {!supported ? (
        <Notice>{'Passkeys can only be set up through a domain with HTTPS (not through the IP address) and need a current browser. If the dashboard runs behind an upstream proxy, administrators enter the public address under System → Sign-in.'}</Notice>
      ) : (
        <div class="row" style={{ marginTop: 'var(--sp-3)' }}><button class={`btn${a.passkeys.length ? '' : ' primary'}`} onClick={add}>Add a passkey</button></div>
      )}
      {pp.dialog}
    </>
  );
}

function PasswordForm() {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const act = useSaver();
  const mismatch = f.again !== '' && f.next !== f.again;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (mismatch) return toast('The passwords do not match.', 'err');
        void act.run(() => api.post('/api/account/password', { current: f.current, new: f.next }), 'Password changed').then((ok) => ok && setF({ current: '', next: '', again: '' }));
      }}
    >
      <Field label="Current password" htmlFor="pw-cur"><input id="pw-cur" class="input" type="password" autocomplete="current-password" required value={f.current} onInput={(e) => setF({ ...f, current: e.currentTarget.value })} /></Field>
      <div class="form-grid">
        <Field label="New password" htmlFor="pw-new" hint="At least 12 characters, three of the four character classes."><input id="pw-new" class="input" type="password" autocomplete="new-password" minLength={12} required value={f.next} onInput={(e) => setF({ ...f, next: e.currentTarget.value })} /></Field>
        <Field label="Repeat" htmlFor="pw-again" hint={mismatch ? 'Does not match.' : undefined}><input id="pw-again" class="input" type="password" autocomplete="new-password" minLength={12} required value={f.again} onInput={(e) => setF({ ...f, again: e.currentTarget.value })} /></Field>
      </div>
      <SaveBar busy={act.busy} error={act.error} progress={act.progress} label="Change password" />
    </form>
  );
}

export function AccountPage({ forced }: { forced?: boolean }) {
  const load = useLoad(() => api.get<Account>('/api/account'));
  const a = load.data;
  return (
    <main>
      <div class="page-head">
        <div>
          <p class="crumbs muted">Account</p>
          <h1>My account</h1>
          <p class="muted">{a ? `${a.name ? `${a.name} · ` : ''}${a.email} · ${ROLE[a.role] ?? a.role}` : 'Sign-in details and security.'}</p>
        </div>
      </div>
      {(forced || (a?.two_factor_required && !a.two_factor)) && <Notice tone="err">Two-factor authentication is mandatory for your role. Please set it up now to keep using the dashboard.</Notice>}
      {load.error && !a && <ErrorNote message={load.error} onRetry={load.reload} />}
      <Loading load={load}>
        {(acc) => (
          <>
            <Panel title="Authenticator app (2FA)">
              <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>In addition to the password, a code from an authenticator app is requested at sign-in (for example Aegis, Google Authenticator, Microsoft Authenticator, 1Password). A stolen or guessed password is then no longer enough.</p>
              <Totp a={acc} reload={load.reload} />
            </Panel>
            <Panel title="Passkeys">
              <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>A passkey replaces the authenticator code as the second factor: you confirm the sign-in with a fingerprint, face recognition, device PIN or a security key. Passkeys are bound to the dashboard domain and cannot be used on fake sites. Ideally set up two and keep the recovery codes.</p>
              <Passkeys a={acc} reload={load.reload} />
            </Panel>
          </>
        )}
      </Loading>
      <Panel title="Change password"><PasswordForm /></Panel>
      {availableLanguages().length > 1 && (
        <Panel title="Language">
          <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>The language is saved in this browser. Texts without a translation stay English.</p>
          <LanguageSelect />
        </Panel>
      )}
    </main>
  );
}
