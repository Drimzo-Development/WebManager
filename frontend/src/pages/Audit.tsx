import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { formatDetails, type AuditEntry } from '../auditUtil.ts';
import { Field, Notice, Panel } from '../forms.tsx';
import { locale } from '../i18n.ts';
import { Icon } from '../ui.tsx';

const PAGE = 100;

interface Answer {
  entries: AuditEntry[];
  more: boolean;
}

const query = (q: string, from: string, to: string, extra: Record<string, string> = {}) => {
  const p = new URLSearchParams();
  if (q.trim()) p.set('q', q.trim());
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
};

export function AuditPage() {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const seq = useRef(0);

  // new search (after a short pause while typing): start again at the newest entry
  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      api.get<Answer>(`/api/audit?${query(q, from, to, { limit: String(PAGE) })}`).then(
        (a) => { if (mine === seq.current) { setEntries(a.entries); setMore(a.more); setError(null); setLoading(false); } },
        (e: unknown) => { if (mine === seq.current) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } },
      );
    }, q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [q, from, to, refresh]);

  const loadMore = () => {
    const last = entries[entries.length - 1];
    if (!last) return;
    const mine = seq.current;
    setLoading(true);
    api.get<Answer>(`/api/audit?${query(q, from, to, { limit: String(PAGE), before: String(last.id) })}`).then(
      (a) => { if (mine === seq.current) { setEntries((cur) => [...cur, ...a.entries]); setMore(a.more); setLoading(false); } },
      (e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); },
    );
  };

  return (
    <main>
      <div class="page-head">
        <div>
          <p class="crumbs muted">Administration</p>
          <h1>Audit log</h1>
          <p class="muted">Administrative actions and sign-ins. Secrets are never logged. Entries are kept for one year.</p>
        </div>
        <div class="row">
          <button class="btn" type="button" onClick={() => setRefresh((n) => n + 1)}><Icon name="refresh" small /> Refresh</button>
          <a class="btn" href={`/api/audit/export?${query(q, from, to)}`} download>Export as CSV</a>
        </div>
      </div>
      <Panel title="Entries">
        <div class="form-grid">
          <Field label="Search" htmlFor="au-q" hint="All words must appear.">
            <input id="au-q" class="input" type="search" placeholder="e.g. token.create or admin@example.com" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
          </Field>
          <Field label="From" htmlFor="au-from"><input id="au-from" class="input" type="date" value={from} max={to || undefined} onInput={(e) => setFrom(e.currentTarget.value)} /></Field>
          <Field label="To" htmlFor="au-to"><input id="au-to" class="input" type="date" value={to} min={from || undefined} onInput={(e) => setTo(e.currentTarget.value)} /></Field>
        </div>
        {error && <Notice tone="err">{error}</Notice>}
        <div class="scroll-x" aria-busy={loading}>
          <table>
            <thead><tr><th>Time</th><th>Users</th><th>Action</th><th class="hide-sm">Target</th><th class="hide-sm">IP</th><th class="hide-sm">Details</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td class="small">{new Date(e.created_at).toLocaleString(locale())}</td>
                  <td>{e.actor || '–'}</td>
                  <td><code>{e.action}</code></td>
                  <td class="hide-sm mono wrap">{e.target}</td>
                  <td class="hide-sm mono">{e.ip}</td>
                  <td class="hide-sm small wrap">{formatDetails(e.details)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && entries.length === 0 && <p class="muted empty">{q || from || to ? 'No entry matches the search.' : 'No entries. Administrative actions are logged here.'}</p>}
        </div>
        {more && <div class="row" style={{ marginTop: 'var(--sp-3)' }}><button class="btn" type="button" disabled={loading} onClick={loadMore}>Load older entries</button></div>}
      </Panel>
    </main>
  );
}
