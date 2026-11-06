import { useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { askConfirm } from '../../confirm.tsx';
import { Loading, Notice, Panel, Toggle, useSaver } from '../../forms.tsx';
import { relativeTime, formatBytes } from '../../format.ts';
import { useLoad } from '../../runtime.ts';
import { fill } from '../../i18n.ts';
import { Rich } from '../../Rich.tsx';

interface Session {
  id: string;
  actor: string;
  ip: string;
  startedAt: string;
  idleSec: number;
  bytesIn: number;
  bytesOut: number;
}

interface ConsoleSettings {
  enabled: boolean;
  mode: 'dashboard' | 'worker';
  sessions: Session[];
}

const idle = (s: number) => (s < 60 ? fill('{n} s', { n: s }) : fill('{n} min', { n: Math.round(s / 60) }));

/**
 * Interactive shell inside the running container (administrators only, see ConsoleApi). The terminal lives in its own page, shown
 * here in an iframe: the terminal library needs inline styles, which only that page may use.
 */
export function ConsoleSection({ id, running }: { id: number; running: boolean }) {
  const [key, setKey] = useState(0);
  const info = useLoad(() => api.get<ConsoleSettings>(`/api/sites/${id}/console`), 10_000);
  const save = useSaver(info.reload);
  const end = useSaver(info.reload);
  const src = `/console/${id}`;
  const enabled = info.data?.enabled ?? false;
  return (
    <div class="stack">
      <section class="card card-pad">
        <div class="card-head">
          <h2>Console</h2>
          <div class="row">
            <button class="btn" type="button" onClick={() => setKey((k) => k + 1)}>Reset view</button>
            <a class="btn" href={src} target="_blank" rel="noopener noreferrer">Open in new window</a>
          </div>
        </div>
        <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>
          A shell inside the container of this website, with the same rights as the website itself. Click “Connect” to start. Anything you type is passed through unchanged; only opening and closing of a session is logged (who, from where, how long), never the input. Opening a shell needs your password (and authenticator code) again, and an account with two-factor authentication. Sessions end after 15 minutes without input, after 2 hours, when you sign out or lose the administrator role.
        </p>
        {!running && <Notice tone="warn">The website is not running. Start it first, then connect.</Notice>}
        {info.data && !enabled && <Notice tone="warn">The console is switched off for this website. Switch it on below to connect.</Notice>}
        {enabled && <iframe key={key} title="Console" src={src} class="console-frame" />}
      </section>
      <Panel title="Console settings">
        <Loading load={info}>
          {(d) => (
            <>
              <Toggle
                id="con-on"
                checked={d.enabled}
                onChange={(v) => void save.run(() => api.put(`/api/sites/${id}/console`, { enabled: v }), 'Saved')}
                label="Allow the console for this website"
                hint="Off until you switch it on. Switching it off ends the open sessions of this website at once."
              />
              {d.mode === 'worker' ? <p class="muted small">Tickets are handed over by the worker: the dashboard itself cannot open shells.</p> : <p class="muted small"><Rich text="Tickets are requested by the dashboard ({setting}). Without the setting {worker} a compromised dashboard could open shells." with={{ setting: <code>CONSOLE_TICKETS=dashboard</code>, worker: <code>worker</code> }} /></p>}
              {save.error && <Notice tone="err">{save.error}</Notice>}
              <h3 class="small" style={{ margin: 'var(--sp-4) 0 var(--sp-2)' }}>Open sessions of this website</h3>
              {d.sessions.length === 0 ? <p class="muted small">No session is open.</p> : (
                <div class="scroll-x">
                  <table>
                    <thead><tr><th>User</th><th>From</th><th>Started</th><th class="hide-sm">Idle</th><th class="hide-sm">Data</th><th><span class="sr">End</span></th></tr></thead>
                    <tbody>
                      {d.sessions.map((s) => (
                        <tr key={s.id}>
                          <td>{s.actor || '–'}</td>
                          <td class="mono">{s.ip}</td>
                          <td class="small">{relativeTime(s.startedAt)}</td>
                          <td class="hide-sm small">{idle(s.idleSec)}</td>
                          <td class="hide-sm small">{formatBytes(s.bytesIn + s.bytesOut)}</td>
                          <td class="num">
                            <button
                              class="btn danger"
                              type="button"
                              onClick={() => void askConfirm('End session?', fill('The shell of {user} is closed immediately; running programs in it are stopped.', { user: s.actor || s.ip }), 'End session').then((ok) => ok && end.run(() => api.post(`/api/console/sessions/${s.id}/kill`), 'Ended'))}
                            >
                              End
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {end.error && <Notice tone="err">{end.error}</Notice>}
            </>
          )}
        </Loading>
      </Panel>
    </div>
  );
}
