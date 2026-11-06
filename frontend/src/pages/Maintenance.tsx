import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import { askConfirm } from '../confirm.tsx';
import { ProgressButton } from '../forms.tsx';
import { fill, locale } from '../i18n.ts';
import { REPEAT_LABEL, localToIso, nextFullHour, stateOf, toLocalInput } from '../maintenance.ts';
import { toast, useLoad } from '../runtime.ts';
import type { MaintenanceWindow } from '../types.ts';
import { ErrorNote, Icon, Pill } from '../ui.tsx';

interface ListAnswer {
  windows: MaintenanceWindow[];
  max: number;
}
interface SiteOption {
  id: number;
  name: string;
}

const when = (iso: string) => new Date(iso).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });

export function Maintenance() {
  const list = useLoad(() => api.get<ListAnswer>('/api/maintenance'), 60000);
  const sites = useLoad(() => api.get<{ sites: SiteOption[] }>('/api/overview'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [start, setStart] = useState(() => toLocalInput(nextFullHour(new Date())));
  const [end, setEnd] = useState(() => toLocalInput(new Date(nextFullHour(new Date()).getTime() + 3600000)));

  async function submit(e: Event) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const f = new FormData(form);
    const starts = localToIso(start);
    const ends = localToIso(end);
    if (!starts || !ends) {
      setError('Please enter a valid start and end.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post('/api/maintenance', {
        title: String(f.get('title') ?? ''),
        site_id: String(f.get('site') ?? '') || null,
        starts_at: starts,
        ends_at: ends,
        repeat: String(f.get('repeat') ?? 'none'),
      });
      form.reset();
      toast('Maintenance window created');
      list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(w: MaintenanceWindow) {
    const text = w.active ? fill('“{title}” is running now. Deleting it ends the muting at once.', { title: w.title }) : fill('Delete the maintenance window “{title}”?', { title: w.title });
    if (!(await askConfirm('Delete maintenance window?', text, 'Delete'))) return;
    try {
      await api.del(`/api/maintenance/${w.id}`);
      toast('Maintenance window deleted');
      list.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  const windows = list.data?.windows ?? [];
  return (
    <main>
      <div class="page-head">
        <div>
          <p class="crumbs muted">Hosting</p>
          <h1>Maintenance windows</h1>
          <p class="muted">During a window the notifications about the website (or about everything) are muted: no outage, memory or restart messages. The website is not touched; it keeps running and is still checked.</p>
        </div>
      </div>

      <div class="grid-2">
        <section class="card card-pad">
          <div class="card-head"><h2>Windows</h2>{list.data && <span class="muted small">{windows.length} {'of'} {list.data.max}</span>}</div>
          {list.error && <ErrorNote message={list.error} onRetry={list.reload} />}
          <div class="scroll-x">
            <table>
              <thead><tr><th>Window</th><th>Applies to</th><th>When</th><th><span class="sr">Action</span></th></tr></thead>
              <tbody>
                {windows.map((w) => {
                  const state = stateOf(w);
                  return (
                    <tr key={w.id}>
                      <td>
                        <span class="strong" translate={false}>{w.title}</span>
                        <span class="block">{state === 'active' ? <Pill tone="warn" live>Running</Pill> : state === 'upcoming' ? <Pill>Planned</Pill> : <Pill tone="">Over</Pill>}</span>
                      </td>
                      <td>{w.site_name !== null ? <span translate={false}>{w.site_name}</span> : <span class="muted">All websites</span>}</td>
                      <td class="small">
                        {when(w.starts_at)} – {when(w.ends_at)}
                        <span class="muted block">{REPEAT_LABEL[w.repeat]}{w.active && w.current_end ? fill(' · until {end}', { end: when(w.current_end) }) : ''}{!w.active && w.next_start ? fill(' · next: {start}', { start: when(w.next_start) }) : ''}</span>
                      </td>
                      <td class="num"><button class="btn ghost icon" onClick={() => remove(w)} aria-label={fill('Delete {title}', { title: w.title })} title="Delete"><Icon name="trash" small /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {list.data && windows.length === 0 && <p class="muted empty">No maintenance windows yet.</p>}
          </div>
        </section>

        <section class="card card-pad">
          <div class="card-head"><h2>New window</h2></div>
          <form onSubmit={submit}>
            <div class="field"><label for="mw-title">Title</label><input id="mw-title" name="title" class="input" required maxLength={80} placeholder="e.g. Server update" /></div>
            <div class="field">
              <label for="mw-site">Applies to</label>
              <select id="mw-site" name="site" class="input">
                <option value="">All websites and system messages</option>
                {(sites.data?.sites ?? []).map((s) => <option key={s.id} value={String(s.id)} translate={false}>{s.name}</option>)}
              </select>
            </div>
            <div class="field"><label for="mw-start">Start</label><input id="mw-start" class="input" type="datetime-local" required value={start} onInput={(e) => setStart(e.currentTarget.value)} /></div>
            <div class="field"><label for="mw-end">End</label><input id="mw-end" class="input" type="datetime-local" required value={end} onInput={(e) => setEnd(e.currentTarget.value)} /></div>
            <div class="field">
              <label for="mw-repeat">Repeat</label>
              <select id="mw-repeat" name="repeat" class="input" defaultValue="none">
                <option value="none">{REPEAT_LABEL.none}</option><option value="daily">{REPEAT_LABEL.daily}</option><option value="weekly">{REPEAT_LABEL.weekly}</option>
              </select>
              <span class="muted small">Times are your local time and are stored as UTC. A repeating window keeps the same UTC time: after a change between summer and winter time it shifts by an hour.</span>
            </div>
            {error && <ErrorNote message={error} />}
            <ProgressButton class="btn primary block" type="submit" busy={busy} label="Create window" />
          </form>
        </section>
      </div>
    </main>
  );
}
