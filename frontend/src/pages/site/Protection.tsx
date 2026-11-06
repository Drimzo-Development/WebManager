import { useRef, useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { Field, Loading, Notice, Panel, SaveBar, Toggle, useDraft, useSaver, ProgressButton } from '../../forms.tsx';
import { formatList, parseList } from '../../lines.ts';
import { toast, useLoad } from '../../runtime.ts';
import { Icon } from '../../ui.tsx';
import { fill, locale } from '../../i18n.ts';
import { askConfirm } from '../../confirm.tsx';
import { Rich } from '../../Rich.tsx';

const num = (v: string, fallback: number) => (v.trim() === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

// ---------------------------------------------------------------- maintenance mode
interface Maintenance {
  enabled: boolean;
  title: string;
  message: string;
  allow_ips: string[];
  your_ip: string;
}

export function MaintenanceSection({ id, onChanged }: { id: number; onChanged: () => void }) {
  const load = useLoad(() => api.get<Maintenance>(`/api/sites/${id}/maintenance`));
  const [d, patch] = useDraft(load);
  const [ips, setIps] = useState<string | null>(null);
  const save = useSaver(() => {
    load.reload();
    onChanged();
  });
  const ipText = ips ?? formatList(d?.allow_ips ?? []);
  return (
    <Panel title="Maintenance mode">
      <Loading load={load}>
        {(r) => (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save.run(() => api.put(`/api/sites/${id}/maintenance`, { enabled: d?.enabled, title: d?.title, message: d?.message, allow_ips: parseList(ipText) }), d?.enabled ? 'Maintenance mode is on' : 'Maintenance mode is off');
              setIps(null);
            }}
          >
            <p class="muted small" style={{ marginBottom: 'var(--sp-4)' }}>Visitors see a maintenance page (HTTP 503). The website itself keeps running; allowed IP addresses see it normally.</p>
            <Toggle id="mt-on" checked={!!d?.enabled} onChange={(v) => patch({ enabled: v })} label="Maintenance mode on" />
            <Field label="Title" htmlFor="mt-title"><input id="mt-title" class="input" maxLength={150} value={d?.title ?? ''} onInput={(e) => patch({ title: e.currentTarget.value })} placeholder={'We\'ll be right back'} /></Field>
            <Field label="Text" htmlFor="mt-msg"><textarea id="mt-msg" class="input" rows={3} maxLength={1000} value={d?.message ?? ''} onInput={(e) => patch({ message: e.currentTarget.value })} /></Field>
            <Field label="Allowed IP addresses" htmlFor="mt-ips" hint={<Rich text="One address per line (at most 20). Your current address: {ip}" with={{ ip: <code>{r.your_ip}</code> }} />}>
              <textarea id="mt-ips" class="input mono" rows={3} spellcheck={false} value={ipText} onInput={(e) => setIps(e.currentTarget.value)} />
            </Field>
            <SaveBar busy={save.busy} error={save.error} progress={save.progress}>
              <button class="btn" type="button" onClick={() => !parseList(ipText).includes(r.your_ip) && setIps(formatList([...parseList(ipText), r.your_ip]))}>Add my IP</button>
            </SaveBar>
          </form>
        )}
      </Loading>
    </Panel>
  );
}

// ---------------------------------------------------------------- password gate
interface Gate {
  enabled: boolean;
  ttl_minutes: number;
  title: string;
  text: string;
  bypass_paths: string[];
  has_logo: boolean;
  passwords: { id: number; label: string; created_at: string }[];
  max_passwords: number;
}

const TTL: [number, string][] = [[30, '30 minutes'], [60, '1 hour'], [240, '4 hours'], [480, '8 hours'], [1440, '1 day'], [10080, '7 days'], [43200, '30 days']];

function Passwords({ id, gate, reload }: { id: number; gate: Gate; reload: () => void }) {
  const [label, setLabel] = useState('');
  const [pw, setPw] = useState('');
  const add = useSaver(reload);
  async function remove(pid: number, name: string) {
    if (!(await askConfirm('Delete password?', fill('Delete password “{v}”? Visitors who used it have to sign in again.', { v: name || 'no label' }), 'Delete'))) return;
    try {
      await api.del(`/api/sites/${id}/gate/passwords/${pid}`);
      toast('Password deleted');
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }
  return (
    <Panel title="Passwords">
      <div class="rows">
        {gate.passwords.map((p) => (
          <div key={p.id}>
            <span>{p.label || <span class="muted">no label</span>}<span class="muted small"> {'· created'} {new Date(p.created_at).toLocaleDateString(locale())}</span></span>
            <button class="btn ghost icon" aria-label={fill('Delete {v}', { v: p.label || 'password' })} onClick={() => remove(p.id, p.label)}><Icon name="trash" small /></button>
          </div>
        ))}
        {gate.passwords.length === 0 && <p class="muted small">No password yet.</p>}
      </div>
      <form
        style={{ marginTop: 'var(--sp-4)' }}
        onSubmit={(e) => {
          e.preventDefault();
          void add.run(() => api.post(`/api/sites/${id}/gate/passwords`, { label, password: pw }), 'Password created').then((ok) => {
            if (ok) {
              setLabel('');
              setPw('');
            }
          });
        }}
      >
        <div class="form-grid">
          <Field label="Label (optional)" htmlFor="gp-label"><input id="gp-label" class="input" maxLength={100} value={label} onInput={(e) => setLabel(e.currentTarget.value)} placeholder="e.g. Customer Smith" /></Field>
          <Field label="Password" htmlFor="gp-pw" hint={fill('8 to 200 characters, at most {max_passwords} passwords.', { max_passwords: gate.max_passwords })}><input id="gp-pw" class="input" type="password" minLength={8} maxLength={200} required autocomplete="new-password" value={pw} onInput={(e) => setPw(e.currentTarget.value)} /></Field>
        </div>
        <SaveBar busy={add.busy} error={add.error} progress={add.progress} label="Add password" disabled={gate.passwords.length >= gate.max_passwords} />
      </form>
    </Panel>
  );
}

function Logo({ id, gate, reload }: { id: number; gate: Gate; reload: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const save = useSaver(reload);
  return (
    <Panel title="Logo of the sign-in page">
      <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>{'PNG, JPEG or WebP, at most 512 KB and 4000 × 4000 pixels.'}</p>
      <div class="row">
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose logo" />
        <button
          class="btn"
          disabled={save.busy}
          onClick={() => {
            const f = input.current?.files?.[0];
            if (!f) return toast('Please choose an image file first.', 'err');
            const body = new FormData();
            body.append('logo', f);
            void save.run(() => api.post(`/api/sites/${id}/gate/logo`, body), 'Logo saved');
          }}
        >Upload</button>
        {gate.has_logo && <button class="btn ghost" disabled={save.busy} onClick={() => void save.run(() => api.del(`/api/sites/${id}/gate/logo`), 'Logo removed')}>Remove logo</button>}
      </div>
      {save.error && <Notice tone="err">{save.error}</Notice>}
    </Panel>
  );
}

export function GateSection({ id, onChanged }: { id: number; onChanged: () => void }) {
  const load = useLoad(() => api.get<Gate>(`/api/sites/${id}/gate`));
  const [d, patch] = useDraft(load);
  const [paths, setPaths] = useState<string | null>(null);
  const reload = () => {
    load.reload();
    onChanged();
  };
  const save = useSaver(reload);
  return (
    <div class="stack">
      <Loading load={load}>
        {(g) => (
          <>
            <Panel title="Password protection">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void save.run(
                    () => api.put(`/api/sites/${id}/gate`, { enabled: d?.enabled, ttl_minutes: d?.ttl_minutes, title: d?.title, text: d?.text, bypass_paths: parseList(paths ?? formatList(d?.bypass_paths ?? [])) }),
                    d?.enabled ? 'Password protection is on' : 'Password protection is off',
                  );
                  setPaths(null);
                }}
              >
                <p class="muted small" style={{ marginBottom: 'var(--sp-4)' }}>Visitors first see a sign-in page and need one of the passwords. This protects the website even if it has no sign-in of its own.</p>
                <Toggle id="gt-on" checked={!!d?.enabled} onChange={(v) => patch({ enabled: v })} label="Password protection on" hint={g.passwords.length === 0 ? 'First create a password below.' : undefined} />
                <Field label="Stay signed in" htmlFor="gt-ttl">
                  <select id="gt-ttl" class="input" value={String(d?.ttl_minutes ?? 480)} onChange={(e) => patch({ ttl_minutes: Number(e.currentTarget.value) })}>
                    {TTL.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
                  </select>
                </Field>
                <Field label="Title of the sign-in page" htmlFor="gt-title"><input id="gt-title" class="input" maxLength={150} value={d?.title ?? ''} onInput={(e) => patch({ title: e.currentTarget.value })} /></Field>
                <Field label="Text" htmlFor="gt-text"><textarea id="gt-text" class="input" rows={2} maxLength={500} value={d?.text ?? ''} onInput={(e) => patch({ text: e.currentTarget.value })} /></Field>
                <Field label="Paths without password" htmlFor="gt-paths" hint="One path per line, e.g. /api/webhook (at most 20). These paths are reachable by everyone.">
                  <textarea id="gt-paths" class="input mono" rows={3} spellcheck={false} value={paths ?? formatList(d?.bypass_paths ?? [])} onInput={(e) => setPaths(e.currentTarget.value)} />
                </Field>
                <SaveBar busy={save.busy} error={save.error} progress={save.progress} />
              </form>
            </Panel>
            <Passwords id={id} gate={g} reload={reload} />
            <Logo id={id} gate={g} reload={reload} />
          </>
        )}
      </Loading>
    </div>
  );
}

// ---------------------------------------------------------------- IP rules, rate limit, countries
interface Rules {
  allow: string[];
  deny: string[];
  rate_rps: number;
  rate_burst: number;
  conn_limit: number;
  geo_mode: 'off' | 'block' | 'allow';
  geo_countries: string[];
  geo: { ready?: boolean; updatedAt?: string | null; countries?: number; ranges?: number; unreachable?: boolean };
  your_ip: string;
}

export function RulesSection({ id, onChanged }: { id: number; onChanged: () => void }) {
  const load = useLoad(() => api.get<Rules>(`/api/sites/${id}/rules`));
  const [d, patch] = useDraft(load);
  const [edit, setEdit] = useState<{ allow?: string; deny?: string; countries?: string }>({});
  const save = useSaver(() => {
    load.reload();
    onChanged();
  });
  const geoJob = useSaver(load.reload);
  return (
    <Panel title="Access rules">
      <Loading load={load}>
        {(r) => (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save.run(
                () =>
                  api.put(`/api/sites/${id}/rules`, {
                    allow: parseList(edit.allow ?? formatList(d?.allow ?? [])),
                    deny: parseList(edit.deny ?? formatList(d?.deny ?? [])),
                    rate_rps: d?.rate_rps,
                    rate_burst: d?.rate_burst,
                    conn_limit: d?.conn_limit,
                    geo_mode: d?.geo_mode,
                    geo_countries: parseList(edit.countries ?? formatList(d?.geo_countries ?? [])),
                  }),
                'Access rules applied',
              ).then((ok) => ok && setEdit({}));
            }}
          >
            <p class="muted small" style={{ marginBottom: 'var(--sp-4)' }}><Rich text="Your current address is {ip}. Careful: with an allow list you lock yourself out if your address is missing." with={{ ip: <code>{r.your_ip}</code> }} /></p>
            <div class="form-grid">
              <Field label="Allow only these addresses" htmlFor="ru-allow" hint="Empty = all. Addresses or networks (CIDR), one per line."><textarea id="ru-allow" class="input mono" rows={4} spellcheck={false} value={edit.allow ?? formatList(d?.allow ?? [])} onInput={(e) => setEdit({ ...edit, allow: e.currentTarget.value })} /></Field>
              <Field label="Block these addresses" htmlFor="ru-deny" hint="Addresses or networks (CIDR), one per line."><textarea id="ru-deny" class="input mono" rows={4} spellcheck={false} value={edit.deny ?? formatList(d?.deny ?? [])} onInput={(e) => setEdit({ ...edit, deny: e.currentTarget.value })} /></Field>
            </div>
            <div class="form-grid three">
              <Field label="Requests per second and IP" htmlFor="ru-rps" hint="0 = unlimited"><input id="ru-rps" class="input" type="number" min={0} max={1000} value={d?.rate_rps ?? 0} onInput={(e) => patch({ rate_rps: num(e.currentTarget.value, 0) })} /></Field>
              <Field label="Burst" htmlFor="ru-burst" hint="Short bursts"><input id="ru-burst" class="input" type="number" min={0} max={5000} value={d?.rate_burst ?? 50} onInput={(e) => patch({ rate_burst: num(e.currentTarget.value, 50) })} /></Field>
              <Field label="Connections per IP" htmlFor="ru-conn" hint="0 = unlimited"><input id="ru-conn" class="input" type="number" min={0} max={10000} value={d?.conn_limit ?? 0} onInput={(e) => patch({ conn_limit: num(e.currentTarget.value, 0) })} /></Field>
            </div>
            <h3>Countries</h3>
            <div class="form-grid">
              <Field label="Mode" htmlFor="ru-geo">
                <select id="ru-geo" class="input" value={d?.geo_mode ?? 'off'} onChange={(e) => patch({ geo_mode: e.currentTarget.value as Rules['geo_mode'] })}>
                  <option value="off">Off</option>
                  <option value="block">Block these countries</option>
                  <option value="allow">Allow only these countries</option>
                </select>
              </Field>
              <Field label="Countries (country codes)" htmlFor="ru-cc" hint="Two letters, e.g. DE AT CH.">
                <input id="ru-cc" class="input mono" value={edit.countries ?? (d?.geo_countries ?? []).join(' ')} onInput={(e) => setEdit({ ...edit, countries: e.currentTarget.value })} />
              </Field>
            </div>
            <p class="small muted" style={{ margin: 'var(--sp-2) 0 var(--sp-4)' }}>
              {r.geo.ready ? fill('Country data loaded ({v} countries, as of {v2}).', { v: r.geo.countries ?? 0, v2: r.geo.updatedAt ? new Date(r.geo.updatedAt).toLocaleDateString(locale()) : '–' }) : 'The country data is not loaded yet.'}{' '}
              <ProgressButton class="link" busy={geoJob.busy} progress={geoJob.progress} onClick={() => void geoJob.run(() => api.post('/api/geo/update'), 'Country data updated')} label="Load country data" />
            </p>
            {geoJob.error && <Notice tone="err">{geoJob.error}</Notice>}
            <SaveBar busy={save.busy} error={save.error} progress={save.progress} label="Save and apply" />
          </form>
        )}
      </Loading>
    </Panel>
  );
}

// ---------------------------------------------------------------- security headers and WAF
interface Security {
  headers: { hsts: boolean; xfo: string; nosniff: boolean; referrer: string; permissions: boolean; csp: string; cspReportOnly: boolean };
  waf_mode: 'off' | 'detect' | 'block';
  waf_categories: string[];
  waf_exempt: string[];
  waf_labels: Record<string, string>;
}

export function SecuritySection({ id, onChanged }: { id: number; onChanged: () => void }) {
  const load = useLoad(() => api.get<Security>(`/api/sites/${id}/security`));
  const [d, patch] = useDraft(load);
  const [exempt, setExempt] = useState<string | null>(null);
  const save = useSaver(() => {
    load.reload();
    onChanged();
  });
  const h = d?.headers;
  const setH = (p: Partial<Security['headers']>) => patch((cur) => ({ headers: { ...cur.headers, ...p } }));
  return (
    <Panel title="Security and WAF">
      <Loading load={load}>
        {(s) => (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save.run(() => api.put(`/api/sites/${id}/security`, { headers: d?.headers, waf_mode: d?.waf_mode, waf_categories: d?.waf_categories, waf_exempt: parseList(exempt ?? formatList(d?.waf_exempt ?? [])) }), 'Security settings applied').then((ok) => ok && setExempt(null));
            }}
          >
            <h3 style={{ marginTop: 0 }}>Security headers</h3>
            <div class="form-grid">
              <Toggle id="sh-hsts" checked={!!h?.hsts} onChange={(v) => setH({ hsts: v })} label="HSTS" hint="Browsers use only HTTPS from then on. Only enable if HTTPS works reliably." />
              <Toggle id="sh-nosniff" checked={!!h?.nosniff} onChange={(v) => setH({ nosniff: v })} label="X-Content-Type-Options: nosniff" />
              <Toggle id="sh-perm" checked={!!h?.permissions} onChange={(v) => setH({ permissions: v })} label="Permissions-Policy (camera, microphone, location off)" />
              <Field label="Embedding in frames (X-Frame-Options)" htmlFor="sh-xfo">
                <select id="sh-xfo" class="input" value={h?.xfo ?? 'off'} onChange={(e) => setH({ xfo: e.currentTarget.value })}>
                  <option value="off">Do not set</option><option value="sameorigin">Own domain only</option><option value="deny">Never</option>
                </select>
              </Field>
              <Field label="Referrer-Policy" htmlFor="sh-ref">
                <select id="sh-ref" class="input" value={h?.referrer ?? 'off'} onChange={(e) => setH({ referrer: e.currentTarget.value })}>
                  {['off', 'no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin'].map((v) => <option key={v} value={v}>{v === 'off' ? 'Do not set' : v}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Content-Security-Policy" htmlFor="sh-csp" hint="Empty = do not set. Letters, digits and the usual characters of CSP values are allowed.">
              <textarea id="sh-csp" class="input mono" rows={3} spellcheck={false} maxLength={1500} value={h?.csp ?? ''} onInput={(e) => setH({ csp: e.currentTarget.value })} />
            </Field>
            <Toggle id="sh-cspro" checked={!!h?.cspReportOnly} onChange={(v) => setH({ cspReportOnly: v })} label="Report CSP only, do not enforce (report-only)" />

            <h3>Web application firewall (WAF)</h3>
            <Field label="Mode" htmlFor="wf-mode" hint="Detect only writes to the log; block rejects suspicious requests (HTTP 403).">
              <select id="wf-mode" class="input" value={d?.waf_mode ?? 'off'} onChange={(e) => patch({ waf_mode: e.currentTarget.value as Security['waf_mode'] })}>
                <option value="off">Off</option><option value="detect">Detect only</option><option value="block">Detect and block</option>
              </select>
            </Field>
            <fieldset class="cats">
              <legend class="small strong">Categories</legend>
              {Object.entries(s.waf_labels).map(([k, label]) => (
                <label key={k} class="check small">
                  <input type="checkbox" checked={!!d?.waf_categories.includes(k)} onChange={(e) => { const on = e.currentTarget.checked; patch((cur) => ({ waf_categories: on ? [...cur.waf_categories, k] : cur.waf_categories.filter((x) => x !== k) })); }} /> {label}
                </label>
              ))}
            </fieldset>
            <Field label="Paths without WAF" htmlFor="wf-ex" hint="One path per line (at most 20), e.g. /admin/editor for pages that legitimately submit code.">
              <textarea id="wf-ex" class="input mono" rows={3} spellcheck={false} value={exempt ?? formatList(d?.waf_exempt ?? [])} onInput={(e) => setExempt(e.currentTarget.value)} />
            </Field>
            <SaveBar busy={save.busy} error={save.error} progress={save.progress} label="Save and apply" />
          </form>
        )}
      </Loading>
    </Panel>
  );
}
