import { useState } from 'preact/hooks';
import { api } from './api.ts';
import { getTheme, useTheme } from './runtime.ts';
import type { AuthState } from './types.ts';
import { passkeyMessage, passkeySecondFactor, passkeySignIn, passkeysSupported } from './webauthn.ts';
import { ErrorNote, Icon, LanguageSelect } from './ui.tsx';
import { ProgressButton } from './forms.tsx';

interface Props {
  state: AuthState;
  /** called with the new state after every step; `authenticated` flips the app over */
  onState: (s: AuthState) => void;
}

function Brand({ state }: { state: AuthState }) {
  return (
    <div class="brand">
      <img src={state.brand.logo} alt="" />
      <span>
        {state.brand.name}
        <small>{state.brand.product}</small>
      </span>
    </div>
  );
}

/** Runs `fn`, shows its error, keeps the buttons disabled while it runs. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(passkeyMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, clear: () => setError('') };
}

export function Login({ state, onState }: Props) {
  const [, toggleTheme] = useTheme();
  const second = state.pending_2fa;
  const act = useAction();
  const passkeyOk = state.passkeys_possible && passkeysSupported();

  const refresh = async () => onState(await api.get<AuthState>('/api/auth/state'));

  async function submitCredentials(e: Event) {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    await act.run(async () => {
      onState(await api.post<AuthState>('/api/auth/login', { email: String(f.get('email') ?? ''), password: String(f.get('password') ?? '') }));
    });
  }

  async function submitCode(e: Event) {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    await act.run(async () => {
      onState(await api.post<AuthState>('/api/auth/2fa', { code: String(f.get('code') ?? '') }));
    });
  }

  return (
    <div class="auth">
      <div class="auth-theme">
        <LanguageSelect />
        <button class="btn ghost icon" onClick={toggleTheme} aria-label="Switch theme">
          <Icon name={getTheme() === 'dark' ? 'sun' : 'moon'} />
        </button>
      </div>
      <div class="auth-form">
        <Brand state={state} />
        {second ? (
          <>
            <h1>Confirmation</h1>
            <p class="muted">
              {second.totp ? 'Enter the 6-digit code from your authenticator app.' : 'Confirm the sign-in with your passkey.'} {'Without your device, a recovery code works too.'}
            </p>
            {second.passkey && passkeyOk && (
              <>
                <button class="btn primary block" type="button" disabled={act.busy} onClick={() => act.run(async () => { await passkeySecondFactor(); await refresh(); })}>
                  <Icon name="key" />{'Confirm with passkey'}
                </button>
                <div class="divider">or with a code</div>
              </>
            )}
            <form onSubmit={submitCode} autocomplete="off">
              <div class="field">
                <label for="code">Code</label>
                <input id="code" name="code" class="input" required autofocus inputMode="numeric" autocomplete="one-time-code" maxLength={24} spellcheck={false} />
              </div>
              {act.error && <ErrorNote message={act.error} />}
              <button class="btn primary block" type="submit" disabled={act.busy}>Confirm</button>
            </form>
            <p class="small" style={{ marginTop: 'var(--sp-4)' }}>
              <button class="link" onClick={() => act.run(async () => onState(await api.post<AuthState>('/api/auth/cancel')))}>Cancel</button>
            </p>
          </>
        ) : (
          <>
            <h1>Welcome back</h1>
            <p class="muted">Sign in to manage your websites.</p>
            {passkeyOk && (
              <>
                <button class="btn block" type="button" disabled={act.busy} onClick={() => act.run(async () => { await passkeySignIn(); await refresh(); })}>
                  <Icon name="key" />{'Sign in with a passkey'}
                </button>
                <div class="divider">or with email</div>
              </>
            )}
            <form onSubmit={submitCredentials}>
              <div class="field">
                <label for="em">Email</label>
                <input id="em" name="email" class="input" type="email" required autofocus autocomplete="username" />
              </div>
              <div class="field">
                <label for="pw">Password</label>
                <input id="pw" name="password" class="input" type="password" required autocomplete="current-password" />
              </div>
              {act.error && <ErrorNote message={act.error} />}
              <ProgressButton class="btn primary block" type="submit" busy={act.busy} label="Sign in" />
            </form>
          </>
        )}
      </div>
      <aside class="auth-side">
        <h2>Your websites. One place. Securely isolated.</h2>
        <ul>
          <li><Icon name="shield-check" />Every website in its own hardened container</li>
          <li><Icon name="key" />Passkeys and two-factor sign-in</li>
          <li><Icon name="archive" />Backups with restore testing</li>
        </ul>
      </aside>
    </div>
  );
}
