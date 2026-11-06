import { useEffect, useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { Field, Loading, Notice, Panel, SaveBar, useSaver, ProgressButton } from '../../forms.tsx';
import { formatList, parseList } from '../../lines.ts';
import { useLoad } from '../../runtime.ts';
import { ErrorNote } from '../../ui.tsx';
import { fill, locale } from '../../i18n.ts';
import type { DnsState } from '../../types.ts';
import { JobLog } from './JobLog.tsx';
import { Rich } from '../../Rich.tsx';

interface DnsResult {
  ok: boolean;
  matches?: boolean;
  message: string;
}

interface CertAnswer {
  cert: { exists: boolean; error?: string; expired?: boolean; expiresSoon?: boolean; daysLeft?: number; names?: string[]; notAfter?: string; staging?: boolean };
  verify: { ok: boolean; domain: string; error?: string }[];
  db: { status: string; last_error?: string } | null;
}

const date = (s?: string) => (s ? new Date(s).toLocaleDateString(locale()) : '–');

function DomainList({ id, domains, onChanged }: { id: number; domains: string[]; onChanged: () => void }) {
  const [text, setText] = useState(formatList(domains));
  const key = domains.join('\n');
  useEffect(() => setText(formatList(domains)), [key]);
  const save = useSaver(onChanged);
  const [dns, setDns] = useState<DnsResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [dnsError, setDnsError] = useState('');
  const provider = useLoad(() => api.get<DnsState>('/api/dns'));
  const records = useSaver();
  const [recordsJob, setRecordsJob] = useState<number | null>(null);

  async function check() {
    setChecking(true);
    setDnsError('');
    try {
      setDns((await api.post<{ results: DnsResult[] }>(`/api/sites/${id}/dns-check`)).results);
    } catch (e) {
      setDnsError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <Panel title="Domains">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save.run(() => api.put(`/api/sites/${id}/domains`, { domains: parseList(text) }), 'Domains saved, the proxy is updated');
        }}
      >
        <Field label="Domains" htmlFor="dom-text" hint={'One domain per line. The proxy forwards them to this website\'s container. A wildcard such as *.example.com needs a DNS provider (System → DNS provider).'}>
          <textarea id="dom-text" class="input mono" rows={5} spellcheck={false} value={text} onInput={(e) => setText(e.currentTarget.value)} />
        </Field>
        <SaveBar busy={save.busy} error={save.error} progress={save.progress} label="Save domains">
          <ProgressButton busy={checking} onClick={check} label="Check DNS" />
          {provider.data?.configured && domains.length > 0 && (
            <button
              class="btn"
              type="button"
              disabled={records.busy}
              title={`Creates the A/AAAA records of the saved domains at ${provider.data.providers[provider.data.provider ?? ''] ?? 'the DNS provider'}`}
              onClick={() => void records.run(async () => { const r = await api.post<{ job: number }>(`/api/sites/${id}/dns-records`); setRecordsJob(r.job); return r; }, 'DNS records set')}
            >
              Set DNS records
            </button>
          )}
        </SaveBar>
        {records.error && <Notice tone="err">{records.error}</Notice>}
        {recordsJob !== null && <JobLog jobId={recordsJob} />}
      </form>
      {dnsError && <ErrorNote message={dnsError} />}
      {dns && (
        <div class="stack" style={{ marginTop: 'var(--sp-4)' }}>
          {dns.length === 0 && <Notice>No domains saved.</Notice>}
          {dns.map((r, i) => <Notice key={i} tone={r.ok && r.matches !== false ? 'ok' : 'err'}>{r.message}</Notice>)}
        </div>
      )}
    </Panel>
  );
}

function Https({ id, hasDomains, wildcard, onChanged }: { id: number; hasDomains: boolean; wildcard: boolean; onChanged: () => void }) {
  const [verify, setVerify] = useState(false);
  const cert = useLoad(() => api.get<CertAnswer>(`/api/sites/${id}/cert${verify ? '?verify=1' : ''}`));
  useEffect(() => cert.reload(), [verify]);
  const sys = useLoad(() => api.get<{ settings: { acme_email?: string } }>('/api/system'));
  const [email, setEmail] = useState('');
  const [tos, setTos] = useState(false);
  const [viaDns, setViaDns] = useState(false);
  const provider = useLoad(() => api.get<DnsState>('/api/dns'));
  const dnsReady = !!provider.data?.configured;
  useEffect(() => {
    if (!email && sys.data?.settings.acme_email) setEmail(sys.data.settings.acme_email);
  }, [sys.data]);
  const issue = useSaver(() => {
    cert.reload();
    onChanged();
  });
  const c = cert.data?.cert;

  return (
    <Panel title={'HTTPS (Let\'s Encrypt)'}>
      <Loading load={cert}>
        {(r) => (
          <>
            {r.cert.exists && !r.cert.error ? (
              <Notice tone={r.cert.expired ? 'err' : r.cert.expiresSoon ? 'warn' : 'ok'}>
                {r.cert.expired ? 'The certificate has expired! ' : r.cert.expiresSoon ? fill('The certificate expires in {daysLeft} days. ', { daysLeft: r.cert.daysLeft ?? 0 }) : fill('Certificate present, valid for {daysLeft} more days. ', { daysLeft: r.cert.daysLeft ?? 0 })}
                <span class="muted">{'Names:'} {(r.cert.names ?? []).join(', ')} {'· valid until'} {date(r.cert.notAfter)}{r.cert.staging ? ' · STAGING (not trusted)' : ''}</span>
              </Notice>
            ) : r.cert.error ? (
              <Notice tone="err">{r.cert.error}</Notice>
            ) : (
              <Notice>No certificate present. This website is only reachable over HTTP.</Notice>
            )}
            {verify && r.verify.map((v) => <Notice key={v.domain} tone={v.ok ? 'ok' : 'err'}>{v.ok ? fill('{domain}: The proxy serves a valid, matching certificate.', { domain: v.domain }) : `${v.domain}: ${v.error ?? 'Check failed'}`}</Notice>)}
            {r.cert.exists && !verify && (
              <p class="small" style={{ margin: 'var(--sp-3) 0' }}>
                <button class="link" onClick={() => setVerify(true)}>Check the served certificate now</button>
              </p>
            )}
            {r.db?.status === 'failed' && r.db.last_error && <Notice tone="err"><Rich text="Last attempt failed ({error}). Details under “Operations → Tasks”." with={{ error: r.db.last_error }} /></Notice>}
          </>
        )}
      </Loading>
      <form
        style={{ marginTop: 'var(--sp-4)' }}
        onSubmit={(e) => {
          e.preventDefault();
          void issue.run(() => api.post(`/api/sites/${id}/cert`, { email: email.trim(), accept_tos: tos, dns: viaDns || wildcard }), 'Certificate set up');
        }}
      >
        <Field label="Contact email" htmlFor="acme-mail" hint={'Let\'s Encrypt sends notices about expiring certificates to this address.'}>
          <input id="acme-mail" class="input" type="email" required placeholder="admin@example.com" value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
        </Field>
        <label class="check small">
          <input type="checkbox" checked={tos} onChange={(e) => setTos(e.currentTarget.checked)} />{' '}
          <Rich text="I accept the {terms}" with={{ terms: <a href="https://letsencrypt.org/repository/" target="_blank" rel="noopener noreferrer">{'Let\'s Encrypt terms of service'}</a> }} />
        </label>
        {dnsReady && !wildcard && (
          <label class="check small" style={{ display: 'block', marginTop: 'var(--sp-2)' }}>
            <input type="checkbox" checked={viaDns} onChange={(e) => setViaDns(e.currentTarget.checked)} /> {'Validate through DNS (the website does not have to be reachable yet)'}
          </label>
        )}
        {wildcard && <Notice tone={dnsReady ? 'ok' : 'warn'}>{dnsReady ? 'A wildcard domain is validated through DNS automatically.' : 'A wildcard domain needs a DNS provider. An administrator can set one up under System → DNS provider.'}</Notice>}
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <SaveBar busy={issue.busy} error={issue.error} progress={issue.progress} label={c?.exists ? 'Renew or extend certificate' : 'Issue certificate'} disabled={!tos || !hasDomains || (wildcard && !dnsReady)} />
        </div>
        {!hasDomains && <p class="muted small">First enter at least one domain.</p>}
      </form>
    </Panel>
  );
}

export function DomainsSection({ id, domains, onChanged }: { id: number; domains: string[]; onChanged: () => void }) {
  return (
    <div class="stack">
      <DomainList id={id} domains={domains} onChanged={onChanged} />
      <Https id={id} hasDomains={domains.length > 0} wildcard={domains.some((d) => d.startsWith('*.'))} onChanged={onChanged} />
    </div>
  );
}

// ---------------------------------------------------------------- web server configuration
interface WebserverAnswer {
  supported: boolean;
  engine: string;
  default: string | null;
  custom: string | null;
}

export function WebserverSection({ id }: { id: number }) {
  const load = useLoad(() => api.get<WebserverAnswer>(`/api/sites/${id}/webserver`));
  const [text, setText] = useState('');
  useEffect(() => {
    if (load.data) setText(load.data.custom || load.data.default || '');
  }, [load.data]);
  const save = useSaver(load.reload);
  return (
    <Panel title="Nginx configuration">
      <Loading load={load}>
        {(r) =>
          !r.supported ? (
            <p class="muted">This website type (Node.js, Custom) has no web server configuration: the application runs directly behind the proxy.</p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const same = text.trim() === (r.default ?? '').trim();
                void save.run(() => api.put(`/api/sites/${id}/webserver`, { config: same ? '' : text }), 'Configuration checked and applied');
              }}
            >
              <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>
                {r.custom ? 'Your own configuration is in use.' : 'The default configuration is in use; changes create your own.'}{' '}
                <Rich text="Before applying, nginx checks it ({cmd}); on errors the running website stays unchanged. The web server listens on port 8080; logs belong in {dir}." with={{ cmd: <code>nginx -t</code>, dir: <code>/var/log/site/</code> }} />
              </p>
              <textarea class="input mono tall-edit" rows={22} spellcheck={false} aria-label="Nginx configuration" value={text} onInput={(e) => setText(e.currentTarget.value)} />
              <div style={{ marginTop: 'var(--sp-4)' }}>
                <SaveBar busy={save.busy} error={save.error} progress={save.progress} label="Save and apply">
                  <button class="btn" type="button" onClick={() => setText(r.default ?? '')}>Reset to default</button>
                </SaveBar>
              </div>
            </form>
          )
        }
      </Loading>
    </Panel>
  );
}
