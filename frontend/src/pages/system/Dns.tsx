import { useEffect, useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { Field, Loading, Notice, Panel, SaveBar, useSaver } from '../../forms.tsx';
import { askConfirm } from '../../confirm.tsx';
import { useLoad } from '../../runtime.ts';
import type { DnsState } from '../../types.ts';
import { JobLog } from '../site/JobLog.tsx';
import { Rich } from '../../Rich.tsx';

const HELP: Record<string, { token: string; link: string }> = {
  cloudflare: { token: 'An API token with the permissions Zone → Zone → Read and Zone → DNS → Edit for the zones you use (My Profile → API Tokens → Create Token → “Edit zone DNS”).', link: 'https://dash.cloudflare.com/profile/api-tokens' },
  hetzner: { token: 'An API token of a project in the Hetzner Console (Security → API tokens) with read & write access. The zone must already be in the Hetzner Console (the former DNS Console zones have to be migrated first).', link: 'https://console.hetzner.com/' },
};

export function DnsSection() {
  const load = useLoad(() => api.get<DnsState>('/api/dns'));
  const [provider, setProvider] = useState('');
  const [token, setToken] = useState('');
  const [wait, setWait] = useState('30');
  const [job, setJob] = useState<number | null>(null);
  const save = useSaver(load.reload);
  const test = useSaver();
  const remove = useSaver(load.reload);

  useEffect(() => {
    if (load.data) {
      setProvider((p) => p || load.data?.provider || 'cloudflare');
      setWait(String(load.data.wait));
    }
  }, [load.data]);

  return (
    <div class="stack">
      <Panel title="DNS provider">
        <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>
          <Rich text="Connects WebManager to the DNS of your domains at Cloudflare or Hetzner. With it, certificates can be validated through DNS ({wild} such as {example}, and for websites that are not yet reachable), and the A/AAAA records of a website can be set to this server with one click. The token is stored encrypted, only the server's own worker hands it on, and it is never shown again." with={{ wild: <b>wildcard certificates</b>, example: <code>*.example.com</code> }} />
        </p>
        <Loading load={load}>
          {(d) => (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save.run(async () => {
                  const r = await api.put<{ job: number }>('/api/dns', { provider, token, wait: Number(wait) });
                  setJob(r.job);
                  setToken('');
                  return r;
                }, 'Saved');
              }}
            >
              {d.configured && <Notice tone="ok">{`Connected: ${d.providers[d.provider ?? ''] ?? d.provider}`}</Notice>}
              <div class="form-grid">
                <Field label="Provider" htmlFor="dns-prov">
                  <select id="dns-prov" class="input" value={provider} onChange={(e) => setProvider(e.currentTarget.value)}>
                    {Object.entries(d.providers).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </Field>
                <Field label="API token" htmlFor="dns-token" hint={d.configured && provider === d.provider ? 'Saved, leave empty to keep.' : (HELP[provider]?.token ?? '')}>
                  <input id="dns-token" class="input" type="password" autocomplete="new-password" spellcheck={false} value={token} onInput={(e) => setToken(e.currentTarget.value)} required={!d.configured || provider !== d.provider} />
                </Field>
                <Field label="Wait for the name servers (seconds)" htmlFor="dns-wait" hint="After a validation record is set, WebManager waits this long before Let's Encrypt looks. 30 is enough for Cloudflare and Hetzner.">
                  <input id="dns-wait" class="input" inputMode="numeric" value={wait} onInput={(e) => setWait(e.currentTarget.value)} />
                </Field>
              </div>
              {HELP[provider] && <p class="small"><a href={HELP[provider].link} target="_blank" rel="noopener noreferrer">{provider === 'cloudflare' ? 'Open the Cloudflare token page' : 'Open the Hetzner Console'}</a></p>}
              <SaveBar busy={save.busy} error={save.error} progress={save.progress} label="Save and test">
                {d.configured && (
                  <>
                    <button class="btn" type="button" disabled={test.busy} onClick={() => void test.run(async () => { const r = await api.post<{ job: number }>('/api/dns/test'); setJob(r.job); return r; }, 'Connection works')}>Test connection</button>
                    <button
                      class="btn danger"
                      type="button"
                      disabled={remove.busy}
                      onClick={async () => {
                        if (await askConfirm('Remove DNS provider?', 'Certificates that were validated through DNS can then no longer be renewed until a provider is set up again.', 'Remove')) {
                          void remove.run(async () => { const r = await api.del<{ job: number }>('/api/dns'); setJob(r.job); return r; }, 'Removed');
                        }
                      }}
                    >
                      Remove
                    </button>
                  </>
                )}
              </SaveBar>
              {test.error && <Notice tone="err">{test.error}</Notice>}
              {job !== null && <JobLog jobId={job} />}
            </form>
          )}
        </Loading>
      </Panel>
      <Panel title="How it is used">
        <p class="muted small">
          <Rich text="Per website ({where}): enter {example} as a domain and issue the certificate – it is validated through DNS automatically. Certificates validated this way are renewed through DNS as well. “Set DNS records” creates the A/AAAA records of the domains with the addresses of this server ({setting} in {file}); other records are left alone, and the records are not proxied." with={{ where: <b>Domains & HTTPS</b>, example: <code>*.example.com</code>, setting: <code>PUBLIC_IPS</code>, file: <code>.env</code> }} />
        </p>
      </Panel>
    </div>
  );
}
