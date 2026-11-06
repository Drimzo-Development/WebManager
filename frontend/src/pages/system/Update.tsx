import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { Field, Notice, Panel, SaveBar, useSaver } from '../../forms.tsx';
import { pollDelay, nextAwaiting } from '../../system.ts';
import { toast, useLoad } from '../../runtime.ts';
import { ErrorNote, Skeleton } from '../../ui.tsx';
import { fill, locale } from '../../i18n.ts';
import { askConfirm } from '../../confirm.tsx';
import { Rich } from '../../Rich.tsx';

interface Release {
  version: string;
  notes?: string;
  publishedAt?: string;
  url?: string;
}

interface Update {
  current: string;
  helperInstalled: boolean;
  canApply: boolean;
  checkedAt: string;
  checkError: string;
  supported: boolean;
  minSupported: string;
  available: boolean;
  latest: string | null;
  releases: Release[];
  state: { state: string; kind?: string; version?: string; at?: string } | null;
  running: boolean;
  requestPending: boolean;
  logTail: string;
  auto: { mode: 'off' | 'patch'; from: number; to: number };
  autoState: { state: string; version?: string; at?: string } | null;
  rollback: { available: boolean; version?: string; dumpAt?: string };
}

const HELPER_CMD = 'sudo /opt/webmanager/scripts/update-helper.sh install';
const dt = (s?: string) => (s ? new Date(s).toLocaleString(locale()) : '–');

export function UpdateSection() {
  const [every, setEvery] = useState(30_000);
  const [awaiting, setAwaiting] = useState<{ since: number; seenRunning: boolean; version?: string } | null>(null);
  const shown = useRef('');
  const load = useLoad(() => api.get<Update>('/api/update'), every);
  const d = load.data;

  // follow what the host does with a request, and notice when the server came back in a new version
  useEffect(() => {
    if (!d) return;
    if (!shown.current) shown.current = d.current;
    if (d.current !== shown.current) {
      toast(fill('Update to version {current} complete. The page is reloading.', { current: d.current }));
      setTimeout(() => location.reload(), 2500);
      setAwaiting(null);
      return;
    }
    const n = nextAwaiting(awaiting, d, Date.now());
    if (n.timedOut) toast('The server did not pick up the request. Please check the update helper (systemctl status webmanager-update.path).', 'err');
    if (n.awaiting !== awaiting) setAwaiting(n.awaiting);
    setEvery(pollDelay({ running: d.running, pending: d.requestPending, awaiting: !!n.awaiting, failed: false }));
  }, [d]);
  useEffect(() => {
    if (load.error) setEvery(pollDelay({ running: false, pending: false, awaiting: true, failed: true }));
  }, [load.error]);

  const apply = useSaver();
  const check = useSaver(() => setTimeout(load.reload, 4000));
  const auto = useSaver(() => setTimeout(load.reload, 3000));
  const rb = useSaver();
  const [af, setAf] = useState<{ mode: string; from: number; to: number } | null>(null);
  const [word, setWord] = useState('');
  useEffect(() => {
    if (d && !af) setAf({ mode: d.auto.mode, from: d.auto.from, to: d.auto.to });
  }, [d]);

  if (!d) return load.error ? <ErrorNote message={load.error} onRetry={load.reload} /> : <Skeleton lines={4} />;
  const busy = d.running || d.requestPending || !!awaiting;
  const st = d.state;
  const failedUpdate = !busy && st?.state === 'failed' && !!st.version && d.releases.some((r) => r.version === st.version);
  const failedRollback = !busy && st?.kind === 'rollback' && st.state === 'failed';

  return (
    <div class="stack">
      {load.error && <Notice>The dashboard is restarting or briefly unreachable. This page refreshes automatically …</Notice>}
      <Panel title="Version and update">
        <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>The server checks for new versions every 2 hours. An update first backs up configuration and database, verifies the download (SHA-256, GPG on request) and restores the previous state automatically on error. Websites, domains, certificates and data stay untouched; the dashboard is unreachable for about a minute.</p>
        <div class="rows">
          <div><span class="muted">Installed version</span><b>v{d.current}</b></div>
          <div><span class="muted">Available</span>{d.available ? <b>v{d.latest}</b> : <span class="muted">no newer version</span>}</div>
          <div><span class="muted">Last checked</span><span>{d.checkedAt ? dt(d.checkedAt) : 'not yet'}</span></div>
        </div>
        {!d.helperInstalled && <Notice><Rich text="The update helper is not set up on the server yet (needed once after the first update to this version). Run on the server: {cmd}" with={{ cmd: <code>{HELPER_CMD}</code> }} /></Notice>}
        {d.helperInstalled && !d.canApply && <Notice><Rich text="The automatic update feature is switched off on the server. Keep updating with {cmd}." with={{ cmd: <code>sudo /opt/webmanager/update.sh</code> }} /></Notice>}
        {!d.supported && <Notice tone="err"><Rich text="Version {current} is no longer supported (oldest supported version: {min}). It receives no further fixes, including security fixes. Please update to the newest version." with={{ current: <b>v{d.current}</b>, min: <b>v{d.minSupported}</b> }} /></Notice>}
        {d.checkError && <Notice><Rich text="The last check failed: {error}" with={{ error: d.checkError }} /></Notice>}
        {busy ? (
          <Notice tone="ok">{d.running ? (st?.kind === 'rollback' ? 'Rolling back to the previous version …' : fill('Update to version {v} in progress …', { v: st?.version ?? '' })) : 'The request was handed over and starts shortly …'}</Notice>
        ) : (
          <>
            {failedRollback && <Notice tone="err">The rollback failed; the state from before the rollback was restored. Excerpt from the log:</Notice>}
            {failedUpdate && <Notice tone="err"><Rich text="The last update to version {version} failed; the previous state was restored. Excerpt from the log:" with={{ version: st?.version }} /></Notice>}
            <Notice tone="ok">{d.available ? <b><Rich text="Version {version} is available." with={{ version: d.latest }} /></b> : 'WebManager is up to date.'}</Notice>
          </>
        )}
        {d.logTail && (busy || failedUpdate || failedRollback) && <pre class="log compact" tabIndex={0}>{d.logTail}</pre>}
        <div class="row" style={{ marginTop: 'var(--sp-3)' }}>
          {d.available && !busy && (
            <button class="btn primary" disabled={!d.canApply || apply.busy} onClick={async () => (await askConfirm('Update WebManager?', fill('WebManager will be updated from version {current} to {latest}. Configuration and database are backed up first, and it is rolled back automatically on error. The dashboard is unreachable for about a minute meanwhile; websites keep running. Continue?', { current: d.current, latest: d.latest }), 'Update now', false)) && void apply.run(async () => { await api.post('/api/update/apply', { version: d.latest }); setAwaiting({ since: Date.now(), seenRunning: false, version: d.latest ?? undefined }); setEvery(4000); load.reload(); }, 'Update was requested')}>Update now</button>
          )}
          <button class="btn" disabled={busy || !d.canApply || check.busy} onClick={() => void check.run(() => api.post('/api/update/check'), 'Check requested')}>Check for new versions now</button>
        </div>
        {(apply.error || check.error) && <Notice tone="err">{apply.error || check.error}</Notice>}
      </Panel>

      {d.available && (
        <Panel title="Changes">
          {d.releases.map((r) => (
            <details key={r.version} open class="release">
              <summary><b>Version {r.version}</b>{r.publishedAt && <span class="muted small"> · {dt(r.publishedAt)}</span>}</summary>
              <pre class="log compact" tabIndex={0}>{r.notes || 'No release notes published.'}</pre>
              {r.url && <a class="small" href={r.url} target="_blank" rel="noopener noreferrer">View in the repository</a>}
            </details>
          ))}
        </Panel>
      )}

      <Panel title="Automatic updates">
        <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}><Rich text="Optionally the server installs new {patch} (same major version, for example 0.7.1 → 0.7.4) on its own within the configured time window. New feature versions always need your click. If an automatic update fails, it is {paused} for this version and reported by email until you save the setting again. At most one attempt per day." with={{ patch: <b>patch versions</b>, paused: <b>paused</b> }} /></p>
        {af && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void auto.run(() => api.post('/api/update/auto', af), 'Saved');
            }}
          >
            <Field label="Mode" htmlFor="au-mode">
              <select id="au-mode" class="input" value={af.mode} onChange={(e) => setAf({ ...af, mode: e.currentTarget.value })}>
                <option value="off">Off (updates only by click)</option>
                <option value="patch">Install patch versions automatically</option>
              </select>
            </Field>
            <div class="form-grid">
              <Field label="Time window from (hour, server time)" htmlFor="au-from"><input id="au-from" class="input" type="number" min={0} max={23} value={af.from} onInput={(e) => setAf({ ...af, from: Number(e.currentTarget.value) })} /></Field>
              <Field label="to (hour, exclusive)" htmlFor="au-to"><input id="au-to" class="input" type="number" min={0} max={23} value={af.to} onInput={(e) => setAf({ ...af, to: Number(e.currentTarget.value) })} /></Field>
            </div>
            {d.auto.mode === 'patch' && d.autoState?.state === 'failed' && <Notice tone="err"><Rich text="Automatic update paused: the attempt for version {version} failed and was rolled back ({at}). Check the log and save the setting again to retry." with={{ version: d.autoState.version, at: dt(d.autoState.at) }} /></Notice>}
            {d.auto.mode === 'patch' && d.autoState?.state !== 'failed' && <Notice tone="ok"><Rich text="Active: patch versions are installed between {from}:00 and {to}:00 (server time)." with={{ from: d.auto.from, to: d.auto.to }} /></Notice>}
            <SaveBar busy={auto.busy} error={auto.error} progress={auto.progress} />
          </form>
        )}
      </Panel>

      {!busy && d.rollback.available && (
        <Panel title="Back to the previous version">
          <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}><Rich text="Reverts the last update: program files and database are reset to the state before the update (version {version}). Websites, their files, certificates and domains stay untouched." with={{ version: d.rollback.version }} /></p>
          <Notice><Rich text="{lost} (task history, log, settings, new users). A dump of the current state is created and kept beforehand. On an error the server restores the current state." with={{ lost: <b><Rich text="Database changes since {when} are lost" with={{ when: dt(d.rollback.dumpAt) }} /></b> }} /></Notice>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void rb.run(async () => { await api.post('/api/update/rollback', { confirm: word.trim() }); setAwaiting({ since: Date.now(), seenRunning: false }); setEvery(4000); load.reload(); }, 'Rollback was requested');
            }}
          >
            <Field label="To confirm, type ZURUECKSETZEN" htmlFor="rb-word"><input id="rb-word" class="input" autocomplete="off" spellcheck={false} placeholder="ZURUECKSETZEN" value={word} onInput={(e) => setWord(e.currentTarget.value)} /></Field>
            {rb.error && <Notice tone="err">{rb.error}</Notice>}
            <button class="btn danger" type="submit" disabled={rb.busy || !d.canApply || word.trim() !== 'ZURUECKSETZEN'}>{'Roll back to version'} {d.rollback.version} {''}</button>
          </form>
        </Panel>
      )}
    </div>
  );
}
