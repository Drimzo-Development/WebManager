import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { initLanguage } from './i18n.ts';
import { installTranslation } from './i18nHook.ts';
import { api, setCsrf } from './api.ts';
import { Login } from './Login.tsx';
import { AccountPage } from './pages/Account.tsx';
import { AuditPage } from './pages/Audit.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { JobPage, JobsPage } from './pages/Jobs.tsx';
import { NewSite } from './pages/NewSite.tsx';
import { SitePage } from './pages/Site.tsx';
import { SystemPage } from './pages/System.tsx';
import { Tokens } from './pages/Tokens.tsx';
import { Maintenance } from './pages/Maintenance.tsx';
import { UsersPage } from './pages/Users.tsx';
import { parseSiteRoute } from './routes.ts';
import { useLoad, useRoute } from './runtime.ts';
import { Shell } from './Shell.tsx';
import './styles.css';
import { parseSystemRoute } from './system.ts';
import type { AuthState, Me } from './types.ts';
import { ErrorNote, PageSkeleton } from './ui.tsx';
import { ConfirmHost } from './confirm.tsx';

const NO_RIGHT = <main><ErrorNote message="You do not have permission for this." /></main>;

/** The page for a route. The server decides again on every request; this only keeps people from landing on pages they cannot use. */
function Page({ me, route, reload }: { me: Me; route: string; reload: () => void }) {
  const admin = me.user.role === 'admin';
  if (route === '/sites/new') return <NewSite me={me} />;
  const site = parseSiteRoute(route);
  if (site) return <SitePage key={site.id} me={me} id={site.id} tab={site.tab} sub={site.sub} />;
  const job = /^\/jobs\/([1-9]\d{0,9})$/.exec(route);
  if (job) return <JobPage id={Number(job[1])} />;
  if (route === '/jobs') return <JobsPage />;
  if (route === '/tokens') return <Tokens me={me} />;
  if (route === '/maintenance') return <Maintenance />;
  if (route === '/account') return <AccountPage />;
  if (route === '/users') return admin ? <UsersPage me={me} /> : NO_RIGHT;
  if (route === '/audit') return admin ? <AuditPage /> : NO_RIGHT;
  const sys = parseSystemRoute(route);
  if (sys) return <SystemPage me={me} sub={sys} onBrand={reload} />;
  return <Dashboard me={me} />;
}

/** Signed in: loads the caller and renders the shell. */
function Authed({ onSignedOut }: { onSignedOut: (s: AuthState) => void }) {
  const route = useRoute();
  const me = useLoad(async () => {
    const m = await api.get<Me>('/api/v1/me');
    setCsrf(m.csrf);
    return m;
  });
  if (me.error && !me.data) {
    return (
      <main style={{ margin: '4rem auto', maxWidth: '36rem' }}>
        <ErrorNote message={me.error} onRetry={me.reload} />
      </main>
    );
  }
  if (!me.data) return <PageSkeleton />;
  const m = me.data;
  const logout = async () => onSignedOut(await api.post<AuthState>('/api/auth/logout'));
  // mandatory two-factor setup: until it is done only the account page works
  if (m.two_factor_missing) {
    return (
      <Shell me={m} route="/account" onLogout={logout} only="/account">
        <AccountPage forced />
      </Shell>
    );
  }
  return (
    <Shell me={m} route={route} onLogout={logout}>
      <Page me={m} route={route} reload={me.reload} />
    </Shell>
  );
}

function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [error, setError] = useState('');

  const take = (s: AuthState) => {
    setCsrf(s.csrf);
    setAuth(s);
  };
  const load = () => api.get<AuthState>('/api/auth/state').then(take, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void load();
    // any 401 from a data request: the session ended, ask the server what is left
    const on = () => void load();
    addEventListener('wm:unauthorized', on);
    return () => removeEventListener('wm:unauthorized', on);
  }, []);

  if (error) {
    return (
      <main style={{ margin: '4rem auto', maxWidth: '36rem' }}>
        <ErrorNote message={error} onRetry={() => { setError(''); void load(); }} />
      </main>
    );
  }
  if (!auth) return <div class="boot"><span class="boot-spin" aria-label="Loading" role="status" /></div>;
  if (!auth.authenticated) return <Login state={auth} onState={take} />;
  return <Authed onSignedOut={take} />;
}

// the language is loaded first, so that the first rendered text is already translated
void initLanguage().then(() => {
  installTranslation();
  render(
    <>
      <App />
      <ConfirmHost />
    </>,
    document.getElementById('root')!,
  );
});
