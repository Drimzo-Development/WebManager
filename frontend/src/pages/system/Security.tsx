import { useEffect, useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { Field, Loading, Notice, Panel, SaveBar, Toggle, useDraft, useSaver } from '../../forms.tsx';
import { formatList } from '../../lines.ts';
import { toast, useLoad } from '../../runtime.ts';
import { JobLog } from '../site/JobLog.tsx';
import { fill, locale } from '../../i18n.ts';
import { Rich } from '../../Rich.tsx';

// ---------------------------------------------------------------- sign-in: two-factor policy
interface Login {
  require_2fa: 'off' | 'admins' | 'all';
  without_2fa: number;
  public_url: string;
}

export function LoginSection() {
  const load = useLoad(() => api.get<Login>('/api/settings/login'));
  const [d, patch] = useDraft(load);
  const save = useSaver(load.reload);
  return (
    <div class="stack">
      <Panel title="Two-factor requirement">
        <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>With a requirement, affected people must set up a second factor (authenticator app or passkey) under “My account” on their next visit; until then only that page is reachable. A leaked password alone is then no longer enough.</p>
        <Loading load={load}>
          {(l) => (
            <form onSubmit={(e) => { e.preventDefault(); void save.run(() => api.put('/api/settings/login', { require_2fa: d?.require_2fa }), 'Saved'); }}>
              <Field label="Two-factor authentication" htmlFor="lg-2fa">
                <select id="lg-2fa" class="input" value={d?.require_2fa ?? 'off'} onChange={(e) => patch({ require_2fa: e.currentTarget.value as Login['require_2fa'] })}>
                  <option value="off">Optional (each user decides)</option>
                  <option value="admins">Mandatory for administrators (recommended)</option>
                  <option value="all">Mandatory for all users</option>
                </select>
              </Field>
              {l.require_2fa !== 'off' && <Notice tone={l.without_2fa ? 'warn' : 'ok'}>{l.without_2fa ? fill('{without_2fa} affected user(s) have not set up 2FA yet and will be asked to on their next visit.', { without_2fa: l.without_2fa }) : 'All affected users have set up 2FA.'}</Notice>}
              <SaveBar busy={save.busy} error={save.error} progress={save.progress} />
            </form>
          )}
        </Loading>
      </Panel>
      <Panel title="Emergency access">
        <p class="muted small">{'Authenticator app or passkey lost, only administrator? The requirement can be switched off on the server; administrators can also, under'} <a href="#/users">Users</a> {'reset an account\'s second factor.'}</p>
        <pre class="log compact" tabIndex={0}>docker compose exec -T webmanager php bin/console security:require-2fa off</pre>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- flood protection
interface Protection {
  config: { autoBan: { enabled: boolean; maxRequests: number; maxErrors: number; windowSec: number; banMinutes: number }; whitelist: string[]; manual: string[] };
  bans: { ip: string; reason: string; until: string }[];
  agent_unreachable: boolean;
  your_ip: string;
}

const num = (v: string, fb: number) => (v.trim() === '' || Number.isNaN(Number(v)) ? fb : Number(v));

export function ProtectSection() {
  const load = useLoad(() => api.get<Protection>('/api/protection'), 15_000);
  const [d, patch] = useDraft(load);
  const [lists, setLists] = useState<{ white?: string; manual?: string }>({});
  const save = useSaver(() => { setLists({}); setTimeout(load.reload, 2500); });
  const a = d?.config.autoBan;
  const setA = (p: Partial<Protection['config']['autoBan']>) => patch((cur) => ({ config: { ...cur.config, autoBan: { ...cur.config.autoBan, ...p } } }));
  async function unban(ip: string) {
    try {
      await api.post('/api/protection/unban', { ip });
      toast('Unblocking …');
      setTimeout(load.reload, 2500);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }
  return (
    <div class="stack">
      <Panel title="Automatic blocking">
        <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>Protects all websites from flooding by single addresses: anyone who sends an extreme number of requests, or almost only faulty ones, in a short time is blocked for a while (the proxy no longer answers them). Per website you can also set request and connection limits and country rules.</p>
        <Notice><b>Limits:</b> {'This protects against scrapers, brute force and smaller floods. Against large distributed attacks (DDoS) that already fill the internet connection, only an upstream service helps (for example Cloudflare or your host\'s protection). Behind such a service the proxy only sees its addresses, so please do not enable this feature there.'}</Notice>
        <Loading load={load}>
          {(p) => (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save.run(() => api.put('/api/protection', { autoBan: d?.config.autoBan, whitelist: lists.white ?? formatList(d?.config.whitelist ?? []), manual: lists.manual ?? formatList(d?.config.manual ?? []) }), 'Saved, the settings are being applied');
              }}
            >
              <Toggle id="pr-on" checked={!!a?.enabled} onChange={(v) => setA({ enabled: v })} label="Enable automatic blocking" />
              <div class="form-grid">
                <Field label="Block from … requests in the time window" htmlFor="pr-req"><input id="pr-req" class="input" type="number" min={50} max={100000} value={a?.maxRequests ?? 600} onInput={(e) => setA({ maxRequests: num(e.currentTarget.value, 600) })} /></Field>
                <Field label="… or from … faulty requests (4xx)" htmlFor="pr-err"><input id="pr-err" class="input" type="number" min={10} max={100000} value={a?.maxErrors ?? 150} onInput={(e) => setA({ maxErrors: num(e.currentTarget.value, 150) })} /></Field>
                <Field label="Time window (seconds)" htmlFor="pr-win"><input id="pr-win" class="input" type="number" min={10} max={600} value={a?.windowSec ?? 60} onInput={(e) => setA({ windowSec: num(e.currentTarget.value, 60) })} /></Field>
                <Field label="Block duration (minutes)" htmlFor="pr-min"><input id="pr-min" class="input" type="number" min={1} max={10080} value={a?.banMinutes ?? 60} onInput={(e) => setA({ banMinutes: num(e.currentTarget.value, 60) })} /></Field>
              </div>
              <Field label="Never block (one address or network per line)" htmlFor="pr-white" hint={fill('Your current address: {your_ip}', { your_ip: p.your_ip })}>
                <textarea id="pr-white" class="input mono" rows={3} spellcheck={false} value={lists.white ?? formatList(d?.config.whitelist ?? [])} onInput={(e) => setLists({ ...lists, white: e.currentTarget.value })} />
              </Field>
              <Field label="Block permanently (one address or network per line)" htmlFor="pr-man">
                <textarea id="pr-man" class="input mono" rows={3} spellcheck={false} value={lists.manual ?? formatList(d?.config.manual ?? [])} onInput={(e) => setLists({ ...lists, manual: e.currentTarget.value })} />
              </Field>
              <SaveBar busy={save.busy} error={save.error} progress={save.progress} label="Save and apply" />
            </form>
          )}
        </Loading>
      </Panel>
      <Panel title="Currently blocked automatically">
        {load.data?.agent_unreachable ? <Notice tone="err">The management service is not reachable.</Notice> : !load.data?.bans.length ? <p class="muted small">No automatic blocks active.</p> : (
          <div class="scroll-x">
            <table>
              <thead><tr><th>Address</th><th>Reason</th><th class="hide-sm">Blocked until</th><th><span class="sr">Action</span></th></tr></thead>
              <tbody>{load.data.bans.map((b) => <tr key={b.ip}><td class="mono">{b.ip}</td><td>{b.reason}</td><td class="hide-sm small">{new Date(b.until).toLocaleString(locale())}</td><td class="num"><button class="btn ghost" onClick={() => unban(b.ip)}>Unblock</button></td></tr>)}</tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- dashboard domain, https and public address
interface SystemSettings {
  settings: { dashboard_domain: string; acme_email: string; dashboard_cert: unknown };
  system: null | { dashboardCert?: { exists: boolean; notAfter?: string; daysLeft?: number; expiresSoon?: boolean; staging?: boolean } };
}

export function DomainSection() {
  const sys = useLoad(() => api.get<SystemSettings>('/api/system'));
  const login = useLoad(() => api.get<Login>('/api/settings/login'));
  const [f, setF] = useState<{ domain: string; email: string; cert: boolean; tos: boolean } | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [job, setJob] = useState<number | null>(null);
  const save = useSaver();
  const urlSave = useSaver(login.reload);
  const s = sys.data;
  useEffect(() => {
    if (s && !f) setF({ domain: s.settings.dashboard_domain, email: s.settings.acme_email, cert: true, tos: false });
  }, [s]);
  const cert = s?.system?.dashboardCert;
  return (
    <div class="stack">
      <Panel title="Dashboard domain and HTTPS">
        <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}><Rich text="As long as no domain is set, the dashboard is reachable unencrypted via the server IP. Set a domain and set up HTTPS before the dashboard is used publicly. After setting it, the dashboard is {only}" with={{ only: <b>only reachable through this domain.</b> }} /></p>
        <Loading load={sys}>
          {(x) => (
            <>
              {x.settings.dashboard_domain ? (
                <Notice tone={cert?.exists && !cert.expiresSoon ? 'ok' : 'warn'}>{'Dashboard domain:'} {x.settings.dashboard_domain}. {cert?.exists ? fill('Certificate valid until {toLocaleDateString} ({daysLeft} days){v}.', { toLocaleDateString: new Date(cert.notAfter ?? '').toLocaleDateString(locale()), daysLeft: cert.daysLeft, v: cert.staging ? ', STAGING-Zertifikat' : '' }) : 'No certificate yet, the dashboard is unencrypted.'}</Notice>
              ) : <Notice>No dashboard domain configured. Access is unencrypted via the server IP.</Notice>}
              {f && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save.run(async () => setJob((await api.put<{ job: number }>('/api/settings/dashboard-domain', { domain: f.domain.trim(), email: f.email.trim(), issue_certificate: f.cert && !!f.domain.trim(), accept_tos: f.tos })).job), 'Being set up');
                  }}
                >
                  <div class="form-grid">
                    <Field label="Domain" htmlFor="dd-dom"><input id="dd-dom" class="input" autocomplete="off" placeholder="panel.example.com" value={f.domain} onInput={(e) => setF({ ...f, domain: e.currentTarget.value })} /></Field>
                    <Field label={'Contact email (Let\'s Encrypt)'} htmlFor="dd-mail"><input id="dd-mail" class="input" type="email" autocomplete="email" value={f.email} onInput={(e) => setF({ ...f, email: e.currentTarget.value })} /></Field>
                  </div>
                  <Toggle id="dd-cert" checked={f.cert} onChange={(v) => setF({ ...f, cert: v })} label={'Issue an HTTPS certificate from Let\'s Encrypt'} />
                  <label class="check small"><input type="checkbox" checked={f.tos} onChange={(e) => setF({ ...f, tos: e.currentTarget.checked })} /> {'I accept the'} <a href="https://letsencrypt.org/repository/" target="_blank" rel="noopener noreferrer">{'Let\'s Encrypt terms of service'}</a></label>
                  <div style={{ marginTop: 'var(--sp-3)' }}><SaveBar busy={save.busy} error={save.error} progress={save.progress} label="Save and set up" /></div>
                </form>
              )}
              {job !== null && <div style={{ marginTop: 'var(--sp-3)' }}><Notice>After setting the domain, the dashboard may no longer be reachable at the previous address. Then open it through the new domain.</Notice><JobLog jobId={job} onFinished={() => sys.reload()} /></div>}
            </>
          )}
        </Loading>
      </Panel>
      <Panel title="Public address (for passkeys)">
        <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}><Rich text="The address you use to open the dashboard in the browser, without a path. Passkeys are bound to this domain. {required}, always recommended: with the address entered, a phishing proxy cannot influence the domain. Empty = determined from the request." with={{ required: <b>Required behind an upstream proxy (for example Pangolin, Cloudflare)</b> }} /></p>
        <Loading load={login}>
          {(l) => (
            <form onSubmit={(e) => { e.preventDefault(); void urlSave.run(() => api.put('/api/settings/public-url', { public_url: (url ?? l.public_url).trim() }), 'Saved').then((ok) => ok && setUrl(null)); }}>
              <Field label="Public address" htmlFor="pu-url"><input id="pu-url" class="input mono" autocomplete="off" spellcheck={false} placeholder="https://panel.example.com" value={url ?? l.public_url} onInput={(e) => setUrl(e.currentTarget.value)} /></Field>
              <SaveBar busy={urlSave.busy} error={urlSave.error} progress={urlSave.progress}><button class="btn" type="button" onClick={() => setUrl(location.origin)}>Use current address</button></SaveBar>
            </form>
          )}
        </Loading>
      </Panel>
    </div>
  );
}

