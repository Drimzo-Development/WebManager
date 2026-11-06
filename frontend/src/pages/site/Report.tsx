import { useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { Field, Loading, Notice, Panel, SaveBar, Toggle, useDraft, useSaver, ProgressButton } from '../../forms.tsx';
import { relativeTime } from '../../format.ts';
import { useLoad } from '../../runtime.ts';
import { fill } from '../../i18n.ts';

interface Report {
  enabled: boolean;
  recipients: string;
  weekday: number;
  hour: number;
  last_sent_at: string | null;
  tz: string;
  smtp_ready: boolean;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function ReportSection({ id }: { id: number }) {
  const load = useLoad(() => api.get<Report>(`/api/sites/${id}/report`));
  const [d, patch] = useDraft(load);
  const [list, setList] = useState<string | null>(null);
  const save = useSaver(() => {
    setList(null);
    load.reload();
  });
  const send = useSaver(load.reload);
  const recipients = list ?? (d?.recipients ?? '');
  return (
    <Panel title="Weekly report by email">
      <Loading load={load}>
        {(r) => (
          <>
            {!r.smtp_ready && <Notice>{'No SMTP server is set up yet (System → Email & notifications). Without one, no reports can be sent.'}</Notice>}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save.run(() => api.put(`/api/sites/${id}/report`, { enabled: d?.enabled, recipients, weekday: d?.weekday, hour: d?.hour }), d?.enabled ? 'Report is on' : 'Report is off');
              }}
            >
              <p class="muted small" style={{ marginBottom: 'var(--sp-4)' }}>A summary of the last seven days compared to the previous week: requests, visitors, error rate, load, most visited pages and WAF hits. No tracking scripts, no IP addresses.</p>
              <Toggle id="rp-on" checked={!!d?.enabled} onChange={(v) => patch({ enabled: v })} label="Report on" />
              <Field label="Recipients" htmlFor="rp-to" hint="One address per line or separated by commas, at most 10.">
                <textarea id="rp-to" class="input" rows={3} spellcheck={false} value={recipients} onInput={(e) => setList(e.currentTarget.value)} />
              </Field>
              <div class="form-grid">
                <Field label="Weekday" htmlFor="rp-day">
                  <select id="rp-day" class="input" value={String(d?.weekday ?? 1)} onChange={(e) => patch({ weekday: Number(e.currentTarget.value) })}>
                    {DAYS.map((n, i) => <option key={n} value={i}>{n}</option>)}
                  </select>
                </Field>
                <Field label={fill('Time (server time {tz})', { tz: r.tz })} htmlFor="rp-hour">
                  <select id="rp-hour" class="input" value={String(d?.hour ?? 8)} onChange={(e) => patch({ hour: Number(e.currentTarget.value) })}>
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                  </select>
                </Field>
              </div>
              <SaveBar busy={save.busy} error={save.error} progress={save.progress}>
                <ProgressButton busy={send.busy} progress={send.progress} disabled={!r.smtp_ready || !r.recipients} title={!r.recipients ? 'Save recipients first' : undefined} onClick={() => void send.run(() => api.post(`/api/sites/${id}/report/send`), 'Report was sent')} label="Send now" />
              </SaveBar>
              {send.error && <Notice tone="err">{send.error}</Notice>}
              <p class="muted small" style={{ marginTop: 'var(--sp-3)' }}>{r.last_sent_at ? fill('Last sent: {v}.', { v: relativeTime(r.last_sent_at) }) : 'Not sent yet.'}</p>
            </form>
          </>
        )}
      </Loading>
    </Panel>
  );
}
