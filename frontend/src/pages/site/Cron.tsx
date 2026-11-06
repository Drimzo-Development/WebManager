import { useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { CRON_PRESETS, cronLabel } from '../../cron.ts';
import { Field, Loading, Notice, Panel, SaveBar, Toggle, useSaver } from '../../forms.tsx';
import { relativeTime } from '../../format.ts';
import { toast, useLoad } from '../../runtime.ts';
import { Icon, Pill } from '../../ui.tsx';
import { fill, locale } from '../../i18n.ts';
import { askConfirm } from '../../confirm.tsx';
import { Rich } from '../../Rich.tsx';

interface CronItem {
  id: number;
  name: string;
  schedule: string;
  command: string;
  timeout_sec: number;
  enabled: boolean;
  notify_fail: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: 'ok' | 'failed' | 'skipped' | null;
  last_exit: number | null;
  last_job_id: number | null;
  last_duration_ms: number | null;
}

interface CronList {
  crons: CronItem[];
  tz: string;
  max: number;
}

type Edit = CronItem | 'new' | null;

const blank = { name: '', schedule: '0 3 * * *', command: '', timeout_sec: 600, enabled: true, notify_fail: true };

function CronForm({ id, item, tz, onDone }: { id: number; item: CronItem | null; tz: string; onDone: (changed: boolean) => void }) {
  const [f, setF] = useState(item ? { name: item.name, schedule: item.schedule, command: item.command, timeout_sec: item.timeout_sec, enabled: item.enabled, notify_fail: item.notify_fail } : blank);
  const patch = (p: Partial<typeof f>) => setF((cur) => ({ ...cur, ...p }));
  const save = useSaver();
  const known = CRON_PRESETS.some((p) => p[0] === f.schedule.trim());
  return (
    <Panel title={item ? fill('Edit cron job: {name}', { name: item.name }) : 'New cron job'}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save.run(() => (item ? api.put(`/api/sites/${id}/cron/${item.id}`, f) : api.post(`/api/sites/${id}/cron`, f)), 'Cron job saved').then((ok) => ok && onDone(true));
        }}
      >
        <Field label="Name" htmlFor="cr-name"><input id="cr-name" class="input" required maxLength={100} placeholder="e.g. Nightly import" value={f.name} onInput={(e) => patch({ name: e.currentTarget.value })} /></Field>
        <div class="form-grid">
          <Field label="Schedule" htmlFor="cr-preset">
            <select id="cr-preset" class="input" value={known ? f.schedule.trim() : ''} onChange={(e) => e.currentTarget.value && patch({ schedule: e.currentTarget.value })}>
              {CRON_PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              <option value="">Custom expression …</option>
            </select>
          </Field>
          <Field label={fill('Expression (server time {tz})', { tz })} htmlFor="cr-expr" hint="Minute hour day month weekday; also @hourly, @daily, @weekly, @monthly.">
            <input id="cr-expr" class="input mono" required spellcheck={false} value={f.schedule} onInput={(e) => patch({ schedule: e.currentTarget.value })} />
          </Field>
        </div>
        <Field label="Command" htmlFor="cr-cmd" hint={'Runs in the project directory in an isolated container with the website\'s environment variables.'}>
          <textarea id="cr-cmd" class="input mono" rows={3} required maxLength={1000} spellcheck={false} placeholder="php artisan schedule:run" value={f.command} onInput={(e) => patch({ command: e.currentTarget.value })} />
        </Field>
        <div class="form-grid">
          <Field label="Time limit (seconds)" htmlFor="cr-timeout" hint="10 to 3600"><input id="cr-timeout" class="input" type="number" min={10} max={3600} value={f.timeout_sec} onInput={(e) => patch({ timeout_sec: Number(e.currentTarget.value) })} /></Field>
          <div>
            <Toggle id="cr-on" checked={f.enabled} onChange={(v) => patch({ enabled: v })} label="Active" />
            <Toggle id="cr-notify" checked={f.notify_fail} onChange={(v) => patch({ notify_fail: v })} label="Send an email on failure" hint="If notifications are set up." />
          </div>
        </div>
        <SaveBar busy={save.busy} error={save.error} progress={save.progress} label={item ? 'Save' : 'Create cron job'}>
          <button class="btn ghost" type="button" onClick={() => onDone(false)}>Cancel</button>
        </SaveBar>
      </form>
    </Panel>
  );
}

function Last({ c }: { c: CronItem }) {
  if (!c.enabled) return <span class="muted">paused</span>;
  if (!c.last_status) return <span class="muted">not run yet</span>;
  const tone = c.last_status === 'ok' ? 'ok' : c.last_status === 'failed' ? 'err' : 'warn';
  const text = { ok: 'Succeeded', failed: fill('Failed{v}', { v: c.last_exit !== null ? ` (Exit ${c.last_exit})` : '' }), skipped: 'Skipped' }[c.last_status];
  return (
    <span>
      <Pill tone={tone}>{text}</Pill>
      <span class="muted small block">
        {c.last_run_at ? relativeTime(c.last_run_at) : ''}{c.last_duration_ms !== null ? `, ${(c.last_duration_ms / 1000).toFixed(1)} s` : ''}{' '}
        {c.last_job_id && <a href={`#/jobs/${c.last_job_id}`}>Audit log</a>}
      </span>
    </span>
  );
}

export function CronSection({ id }: { id: number }) {
  const load = useLoad(() => api.get<CronList>(`/api/sites/${id}/cron`), 15_000);
  const [edit, setEdit] = useState<Edit>(null);

  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast(ok);
      load.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  return (
    <Loading load={load}>
      {(d) => (
        <div class="stack">
          {edit !== null && <CronForm key={edit === 'new' ? 'new' : edit.id} id={id} item={edit === 'new' ? null : edit} tz={d.tz} onDone={(changed) => { setEdit(null); if (changed) load.reload(); }} />}
          <Panel title="Cron jobs" actions={<button class="btn primary" disabled={d.crons.length >= d.max || edit !== null} onClick={() => setEdit('new')}><Icon name="plus" small />Add cron job</button>}>
            <div class="scroll-x">
              <table>
                <thead><tr><th>Name</th><th>Schedule</th><th class="hide-sm">Last run</th><th class="hide-sm">Next run</th><th><span class="sr">Actions</span></th></tr></thead>
                <tbody>
                  {d.crons.map((c) => (
                    <tr key={c.id}>
                      <td><span class="strong">{c.name}</span><span class="muted small mono block cron-cmd">{c.command}</span></td>
                      <td><code>{c.schedule}</code>{cronLabel(c.schedule) && <span class="muted small block">{cronLabel(c.schedule)}</span>}</td>
                      <td class="hide-sm"><Last c={c} /></td>
                      <td class="hide-sm small">{c.enabled ? (c.next_run_at ? new Date(c.next_run_at).toLocaleString(locale()) : 'being calculated …') : '–'}</td>
                      <td class="num">
                        <div class="row end" style={{ margin: 0 }}>
                          <button class="btn ghost" onClick={() => act(() => api.post(`/api/sites/${id}/cron/${c.id}/run`), 'Run started, the log is under “Tasks”')}>Run now</button>
                          <button class="btn ghost icon" aria-label={fill('Edit {name}', { name: c.name })} title="Edit" onClick={() => setEdit(c)}><Icon name="edit" small /></button>
                          <button class="btn ghost" onClick={() => act(() => api.put(`/api/sites/${id}/cron/${c.id}`, { name: c.name, schedule: c.schedule, command: c.command, timeout_sec: c.timeout_sec, notify_fail: c.notify_fail, enabled: !c.enabled }), c.enabled ? 'Paused' : 'Resumed')}>{c.enabled ? 'Pause' : 'Resume'}</button>
                          <button class="btn ghost icon" aria-label={fill('Delete {name}', { name: c.name })} title="Delete" onClick={async () => (await askConfirm('Delete cron job?', fill('“{name}” will no longer run. Earlier logs stay under “Tasks”. Delete it?', { name: c.name }), 'Delete')) && void act(() => api.del(`/api/sites/${id}/cron/${c.id}`), 'Cron job deleted')}><Icon name="trash" small /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {d.crons.length === 0 && <p class="muted empty">No cron jobs yet.</p>}
            </div>
            <Notice tone="ok"><Rich text="Times use the server time ({tz}). Up to {max} cron jobs per website." with={{ tz: d.tz, max: d.max }} /></Notice>
          </Panel>
        </div>
      )}
    </Loading>
  );
}
