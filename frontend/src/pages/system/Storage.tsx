import { useEffect, useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { Bar } from '../../ui.tsx';
import { Loading, Notice, Panel, useSaver, ProgressButton } from '../../forms.tsx';
import { formatBytes } from '../../format.ts';
import { diskInfo } from '../../system.ts';
import { useLoad } from '../../runtime.ts';
import { JobLog } from '../site/JobLog.tsx';
import { fill } from '../../i18n.ts';
import { Rich } from '../../Rich.tsx';

interface Category {
  id: string;
  label: string;
  description: string;
  bytes: number;
  cleanable: number;
  count: number;
  risk?: string;
  items: { name: string; bytes?: number; detail?: string }[];
}

interface Plan {
  disk?: { totalBytes: number; freeBytes: number };
  categories: Category[];
  info: { localBackupCount: number; localBackupBytes: number };
}

const size = (n: number) => (n > 0 ? formatBytes(n) : '–');

export function StorageSection() {
  const load = useLoad(() => api.get<Plan>('/api/storage'));
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState(false);
  const [job, setJob] = useState<number | null>(null);
  const [sites, setSites] = useState<{ site: string; bytes: number }[] | null>(null);
  const run = useSaver(() => setTimeout(load.reload, 2000));
  const sitesAct = useSaver();

  // drop selections that are no longer cleanable after a recalculation
  useEffect(() => {
    if (!load.data) return;
    setSel((cur) => new Set([...cur].filter((id) => (load.data!.categories.find((c) => c.id === id)?.cleanable ?? 0) > 0)));
  }, [load.data]);

  return (
    <div class="stack">
      <Panel title="Clean up storage">
        <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>Shows what takes up space on the server and what can safely be removed. Fixed rules apply: websites, databases, current backups and the running and previous program versions are always kept. Before cleaning up you see exactly what will be removed.</p>
        <Loading load={load}>
          {(p) => {
            const disk = p.disk ? diskInfo(p.disk.totalBytes, p.disk.freeBytes) : null;
            const chosen = p.categories.filter((c) => sel.has(c.id));
            const total = chosen.reduce((a, c) => a + c.cleanable, 0);
            return (
              <>
                {disk && p.disk && (
                  <div style={{ marginBottom: 'var(--sp-4)' }}>
                    <Bar percent={disk.pct} label="Disk used" />
                    <span class="muted small">{formatBytes(disk.used)} {'of'} {formatBytes(p.disk.totalBytes)} {'used ('}{disk.pct} %), {formatBytes(p.disk.freeBytes)} {'free'}</span>
                  </div>
                )}
                <div class="scroll-x">
                  <table>
                    <thead><tr><th><span class="sr">Selection</span></th><th>Category</th><th class="num">Used</th><th class="num">Removable</th></tr></thead>
                    <tbody>
                      {p.categories.map((c) => (
                        <tr key={c.id}>
                          <td><input type="checkbox" aria-label={c.label} disabled={c.cleanable <= 0} checked={sel.has(c.id)} onChange={(e) => { const next = new Set(sel); e.currentTarget.checked ? next.add(c.id) : next.delete(c.id); setSel(next); setPreview(false); }} /></td>
                          <td>
                            <span class="strong">{c.label}</span>{c.risk && <span class="pill warn" style={{ marginLeft: '.5rem' }}>{c.risk}</span>}
                            <span class="muted small block">{c.description}</span>
                            {c.items.length > 0 && <details><summary class="small">{c.items.length} {'Show entries'}</summary><ul class="small mono">{c.items.map((i) => <li key={i.name}>{i.name}{i.bytes ? ` – ${formatBytes(i.bytes)}` : ''}{i.detail ? ` (${i.detail})` : ''}</li>)}</ul></details>}
                          </td>
                          <td class="num">{size(c.bytes)}</td>
                          <td class="num strong">{size(c.cleanable)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div class="row" style={{ marginTop: 'var(--sp-3)' }}>
                  <button class="btn primary" disabled={chosen.length === 0 || total <= 0} onClick={() => setPreview(true)}>{chosen.length ? fill('Clean up … (approx. {v})', { v: formatBytes(total) }) : 'Clean up …'}</button>
                  <button class="btn" onClick={() => { setSel(new Set(p.categories.filter((c) => c.cleanable > 0 && !c.risk).map((c) => c.id))); setPreview(false); }}>Select everything non-critical</button>
                  <button class="btn ghost" onClick={load.reload}>Recalculate</button>
                </div>
                {preview && chosen.length > 0 && (
                  <Notice>
                    <b>{'Will be removed (approx.'} {formatBytes(total)}):</b>
                    <ul>{chosen.map((c) => <li key={c.id}><b>{c.label}</b> – {c.count ? fill('{count} entry/entries, ', { count: c.count }) : ''}{size(c.cleanable)}</li>)}</ul>
                    {chosen.some((c) => c.risk) && <p><b>The trash is emptied permanently.</b> {'These files cannot be restored afterwards.'}</p>}
                    <p class="muted small">The selection is checked once more against the same rules when it runs.</p>
                    <div class="row">
                      <button class="btn danger" disabled={run.busy} onClick={() => void run.run(async () => { const r = await api.post<{ job: number }>('/api/storage/cleanup', { categories: [...sel] }); setJob(r.job); setPreview(false); }, 'Cleanup started')}>Clean up now</button>
                      <button class="btn ghost" onClick={() => setPreview(false)}>Cancel</button>
                    </div>
                  </Notice>
                )}
                {run.error && <Notice tone="err">{run.error}</Notice>}
                {job !== null && <div style={{ marginTop: 'var(--sp-3)' }}><JobLog jobId={job} onFinished={() => load.reload()} /></div>}
                <p class="muted small" style={{ marginTop: 'var(--sp-4)' }}><Rich text="Not offered, but taking up space: {count} local backup(s) with {size} (retention can be set under Backups) as well as websites and databases." with={{ count: p.info.localBackupCount, size: formatBytes(p.info.localBackupBytes) }} /></p>
              </>
            );
          }}
        </Loading>
      </Panel>
      <Panel title="Usage per website">
        <ProgressButton busy={sitesAct.busy} progress={sitesAct.progress} onClick={() => void sitesAct.run(async () => setSites((await api.get<{ sites: { site: string; bytes: number }[] }>('/api/storage/sites')).sites), 'Calculated')} label="Show usage (may take a while)" />
        {sitesAct.error && <Notice tone="err">{sitesAct.error}</Notice>}
        {sites && (
          <div class="scroll-x" style={{ marginTop: 'var(--sp-3)' }}>
            <table><tbody>{sites.map((s) => <tr key={s.site}><td>{s.site}</td><td class="num">{formatBytes(s.bytes)}</td></tr>)}</tbody></table>
          </div>
        )}
      </Panel>
    </div>
  );
}
