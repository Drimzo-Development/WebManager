import { useEffect, useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { Notice, Panel, useSaver } from '../../forms.tsx';
import { formatBytes, relativeTime } from '../../format.ts';
import { nextAwaiting, pollDelay } from '../../system.ts';
import { toast, useLoad } from '../../runtime.ts';
import { ErrorNote, Pill, Skeleton } from '../../ui.tsx';
import { BackupTarget } from './BackupTarget.tsx';
import { fill, locale } from '../../i18n.ts';
import { Rich } from '../../Rich.tsx';

interface Result {
  ok: boolean;
  at: string;
  file?: string;
  detail?: string;
  error?: string;
  kind?: string;
  version?: string;
}

interface Backup {
  helperInstalled: boolean;
  canApply: boolean;
  configured: boolean;
  encrypted: boolean;
  remote?: string;
  remoteInfo?: { count: number; bytes: number } | null;
  keep?: { daily: number; weekly: number; monthly: number };
  lastBackup: Result | null;
  lastUpload: Result | null;
  lastVerify: Result | null;
  running: boolean;
  requestPending: boolean;
  state: { state: string; action: string } | null;
  logTail: string;
  localFiles: { name: string; bytes: number; at: string; encrypted: boolean }[];
}

const INSTALL_CMD = 'sudo /opt/webmanager/scripts/backup-remote.sh install';
const ACTION: Record<string, string> = { backup: 'Backup', upload: 'Upload', verify: 'Restore test', 'verify-remote': 'Restore test (external target)' };

function Res({ r, extra }: { r: Result | null; extra?: string }) {
  if (!r) return <span class="muted">never</span>;
  return (
    <span>
      <Pill tone={r.ok ? 'ok' : 'err'}>{r.ok ? 'ok' : 'failed'}</Pill> <span class="small">{new Date(r.at).toLocaleString(locale())}</span>
      {extra && <span class="muted small block">{extra}</span>}
    </span>
  );
}

export function BackupSection() {
  const [every, setEvery] = useState(30_000);
  const [awaiting, setAwaiting] = useState<{ since: number; seenRunning: boolean } | null>(null);
  const load = useLoad(() => api.get<Backup>('/api/backup'), every);
  const d = load.data;
  const act = useSaver();

  useEffect(() => {
    if (!d) return;
    const n = nextAwaiting(awaiting, d, Date.now());
    if (n.timedOut) toast('The server did not pick up the request. Please check the backup helper (systemctl status webmanager-backupreq.path).', 'err');
    if (n.awaiting !== awaiting) setAwaiting(n.awaiting);
    setEvery(pollDelay({ running: d.running, pending: d.requestPending, awaiting: !!n.awaiting, failed: false }));
  }, [d]);

  if (!d) return load.error ? <ErrorNote message={load.error} onRetry={load.reload} /> : <Skeleton lines={4} />;
  const busy = d.running || d.requestPending || !!awaiting;
  const failed = !busy && d.state?.state === 'failed';
  const run = (action: string) => void act.run(async () => { await api.post('/api/backup/run', { action }); setAwaiting({ since: Date.now(), seenRunning: false }); setEvery(4000); load.reload(); }, fill('{v} was requested', { v: ACTION[action] ?? action }));
  const disabled = busy || !d.canApply || act.busy;

  return (
    <div class="stack">
      <Panel title="Status and actions">
        <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}><Rich text="A backup contains configuration, database, certificates and website files. It is only useful if it is stored {outside} and can demonstrably be {restored}: The restore test decrypts the newest backup, checks all checksums and imports the database into a throwaway database without touching the running installation. It runs automatically every Sunday." with={{ outside: <b>outside the server</b>, restored: <b>restored</b> }} /></p>
        <div class="rows">
          <div><span class="muted">Last local backup</span><Res r={d.lastBackup} extra={d.lastBackup ? (d.lastBackup.kind === 'db' ? 'database only' : fill('complete, version {version}', { version: d.lastBackup.version })) : undefined} /></div>
          <div><span class="muted">External target</span><span>{d.configured ? d.remote : 'not set up'}</span></div>
          {d.configured && <div><span class="muted">On the target</span><span>{d.remoteInfo ? fill('{count} backup(s), {size}', { count: d.remoteInfo.count, size: formatBytes(d.remoteInfo.bytes) }) : 'unknown'}</span></div>}
          {d.configured && d.keep && <div><span class="muted">Retention on the target</span><span>{d.keep.daily} {'daily,'} {d.keep.weekly} {'weekly,'} {d.keep.monthly} {'monthly'}</span></div>}
          {d.configured && <div><span class="muted">Last upload</span><Res r={d.lastUpload} extra={d.lastUpload && !d.lastUpload.ok ? d.lastUpload.error : d.lastUpload?.file} /></div>}
          <div><span class="muted">Last restore test</span><Res r={d.lastVerify} extra={d.lastVerify?.detail ? d.lastVerify.detail : undefined} /></div>
        </div>
        {!d.helperInstalled && <Notice><Rich text="The backup helper is not set up on the server yet. Run on the server: {cmd}" with={{ cmd: <code>{INSTALL_CMD}</code> }} /></Notice>}
        {d.helperInstalled && !d.canApply && <Notice>The dashboard control is not active on the server (systemctl status webmanager-backupreq.path). Backups keep running via backup.sh.</Notice>}
        {!d.configured ? (
          <>
            <Notice><b>The backups are only on this server.</b> {'If the server or its disk fails, they are gone too. Set up an external target below.'}</Notice>
          </>
        ) : !d.encrypted && <Notice tone="err"><Rich text="The passphrase file is missing: unencrypted backups are not uploaded. Run setup again: backup-remote.sh setup --remote {remote}" with={{ remote: d.remote }} /></Notice>}
        {busy && <Notice tone="ok">{d.running ? fill('Running: {v} …', { v: ACTION[d.state?.action ?? ''] ?? d.state?.action ?? '' }) : 'Was requested and starts shortly …'}</Notice>}
        {failed && <Notice tone="err"><Rich text="The last operation ({action}) failed. Excerpt from the log:" with={{ action: d.state?.action }} /></Notice>}
        {d.logTail && (busy || failed) && <pre class="log compact" tabIndex={0}>{d.logTail}</pre>}
        <div class="row" style={{ marginTop: 'var(--sp-3)' }}>
          <button class="btn primary" disabled={disabled} onClick={() => run('backup')}>Create backup now</button>
          <button class="btn" disabled={disabled || !d.configured} onClick={() => run('upload')}>Upload to external target</button>
          <button class="btn" disabled={disabled} onClick={() => run('verify')}>Restore test (local)</button>
          <button class="btn" disabled={disabled || !d.configured} onClick={() => run('verify-remote')}>Restore test (external target)</button>
        </div>
        {act.error && <Notice tone="err">{act.error}</Notice>}
      </Panel>
      <BackupTarget configured={d.configured} />
      {d.localFiles.length > 0 && (
        <Panel title="Local backups">
          <div class="scroll-x">
            <table>
              <thead><tr><th>File</th><th>Size</th><th class="hide-sm">Created</th><th class="hide-sm">Encrypted</th></tr></thead>
              <tbody>
                {d.localFiles.map((f) => (
                  <tr key={f.name}><td class="mono wrap">{f.name}</td><td class="num">{formatBytes(f.bytes)}</td><td class="hide-sm muted small">{relativeTime(f.at)}</td><td class="hide-sm">{f.encrypted ? 'yes' : <span class="muted">no</span>}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
