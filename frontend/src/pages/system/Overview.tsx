import { useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { Bar, Icon, Pill } from '../../ui.tsx';
import { Notice, Panel, useSaver } from '../../forms.tsx';
import { formatBytes, relativeTime } from '../../format.ts';
import { diskInfo, systemHref, type Tone } from '../../system.ts';
import { useLoad } from '../../runtime.ts';
import { JobLog } from '../site/JobLog.tsx';
import { fill } from '../../i18n.ts';

interface Sys {
  version: string;
  components: Record<string, { ok: boolean; detail?: string | null }>;
  system: null | {
    docker: { version?: string; os?: string; arch?: string; running?: number; containers?: number };
    host: { load: number[]; memTotal: number };
    disk?: { totalBytes: number; freeBytes: number };
    acmeStaging?: boolean;
  };
  jobs_active: number;
  settings: { dashboard_domain: string; dashboard_cert: unknown };
}
interface Upd { current: string; available: boolean; latest: string | null }
interface Bak { lastBackup: { at: string; ok: boolean } | null; configured: boolean; remote?: string; lastUpload: { ok: boolean } | null; lastVerify: { ok: boolean } | null }
interface Login { require_2fa: 'off' | 'admins' | 'all'; without_2fa: number }
interface Notify { enabled: boolean; recipients: string }
interface Prot { config: { autoBan: { enabled: boolean } }; bans: unknown[] }

const COMPONENT: Record<string, string> = { database: 'Database', agent: 'Management service (agent)', docker: 'Docker', proxy: 'Reverse Proxy', worker: 'Worker' };

interface Tile {
  sub: string;
  icon: string;
  title: string;
  big: string;
  sub2: string;
  tone: Tone | 'info' | 'muted';
}

export function OverviewSection() {
  const sys = useLoad(() => api.get<Sys>('/api/system'), 10_000);
  const tiles = useLoad(async () => {
    const [u, b, l, n, p] = await Promise.allSettled([
      api.get<Upd>('/api/update'), api.get<Bak>('/api/backup'), api.get<Login>('/api/settings/login'), api.get<Notify>('/api/settings/notifications'), api.get<Prot>('/api/protection'),
    ]);
    return { u: u.status === 'fulfilled' ? u.value : null, b: b.status === 'fulfilled' ? b.value : null, l: l.status === 'fulfilled' ? l.value : null, n: n.status === 'fulfilled' ? n.value : null, p: p.status === 'fulfilled' ? p.value : null };
  }, 60_000);
  const [job, setJob] = useState<number | null>(null);
  const act = useSaver();
  const s = sys.data;
  const tl = tiles.data;

  const list: Tile[] = [];
  if (tl?.u || s) {
    const avail = !!tl?.u?.available;
    list.push({ sub: 'update', icon: 'refresh', title: 'Version', big: `v${tl?.u?.current ?? s?.version}`, sub2: avail ? fill('New version {latest} available', { latest: tl?.u?.latest }) : 'Up to date', tone: avail ? 'info' : 'ok' });
  }
  if (tl?.b) {
    const lb = tl.b.lastBackup;
    let tone: Tone = !lb ? 'warn' : lb.ok ? 'ok' : 'err';
    if (tl.b.lastUpload && !tl.b.lastUpload.ok) tone = 'err';
    if (tl.b.lastVerify && !tl.b.lastVerify.ok) tone = 'err';
    if (!tl.b.configured && tone === 'ok') tone = 'warn';
    list.push({ sub: 'backup', icon: 'archive', title: 'Backups', big: lb ? (lb.ok ? relativeTime(lb.at) : 'Failed') : 'No backup yet', sub2: tl.b.configured ? fill('External: {remote}', { remote: tl.b.remote }) : 'Local only, no external target', tone });
  }
  const disk = s?.system?.disk ? diskInfo(s.system.disk.totalBytes, s.system.disk.freeBytes) : null;
  if (disk && s?.system?.disk) list.push({ sub: 'storage', icon: 'database', title: 'Storage', big: fill('{pct} % used', { pct: disk.pct }), sub2: fill('{v} free of {v2}', { v: formatBytes(s.system.disk.freeBytes), v2: formatBytes(s.system.disk.totalBytes) }), tone: disk.tone });
  if (tl?.l) {
    const off = tl.l.require_2fa === 'off';
    list.push({ sub: 'login', icon: 'key', title: 'Sign-in', big: { off: 'Optional', admins: 'Mandatory for administrators', all: 'Mandatory for everyone' }[tl.l.require_2fa], sub2: off ? '2FA is not required (recommended: administrators)' : tl.l.without_2fa ? fill('{without_2fa} users without 2FA', { without_2fa: tl.l.without_2fa }) : 'Everyone has a second factor', tone: off || tl.l.without_2fa ? 'warn' : 'ok' });
  }
  if (s) {
    const dom = s.settings.dashboard_domain;
    const https = location.protocol === 'https:';
    list.push({ sub: 'domain', icon: 'globe', title: 'Dashboard address', big: dom || (https ? location.hostname : 'IP address only'), sub2: dom ? (s.settings.dashboard_cert ? 'HTTPS set up' : 'No certificate yet') : https ? 'HTTPS through an upstream proxy' : 'Unencrypted via the server IP', tone: dom ? (s.settings.dashboard_cert ? 'ok' : 'warn') : https ? 'ok' : 'warn' });
  }
  if (tl?.p) list.push({ sub: 'protect', icon: 'shield', title: 'Attack protection', big: tl.p.config.autoBan.enabled ? 'Active' : 'Off', sub2: tl.p.config.autoBan.enabled ? (tl.p.bans.length ? fill('{length} address(es) blocked', { length: tl.p.bans.length }) : 'No blocks active') : 'Automatic blocking is switched off', tone: tl.p.config.autoBan.enabled ? 'ok' : 'muted' });
  if (tl?.n) list.push({ sub: 'notify', icon: 'mail', title: 'Notifications', big: tl.n.enabled ? 'Active' : 'Off', sub2: tl.n.enabled ? fill('{length} recipients', { length: tl.n.recipients.split(/\s+/).filter(Boolean).length }) : 'No emails are sent', tone: tl.n.enabled ? 'ok' : 'warn' });

  return (
    <div class="stack">
      <div class="tiles">
        {list.map((x) => (
          <a key={x.sub} class={`card tile tile-${x.tone || 'muted'}`} href={systemHref(x.sub)}>
            <span class="tile-head"><Icon name={x.icon} small />{x.title}</span>
            <b class="tile-big">{x.big}</b>
            <span class="muted small">{x.sub2}</span>
          </a>
        ))}
      </div>
      {sys.error && !s && <Notice tone="err">{sys.error}</Notice>}
      {s && (
        <>
          <Panel title="Components">
            <div class="status-grid">
              {Object.entries(s.components).map(([k, v]) => (
                <div class="card card-pad" key={k}>
                  <Pill tone={v.ok ? 'ok' : 'err'}>{COMPONENT[k] ?? k}</Pill>
                  <div class="muted small" style={{ marginTop: 'var(--sp-2)' }}>{v.ok ? v.detail || 'Active' : v.detail || 'Not available'}</div>
                </div>
              ))}
            </div>
            <div class="row" style={{ marginTop: 'var(--sp-4)' }}>
              <button class="btn" disabled={act.busy} onClick={() => void act.run(async () => setJob((await api.post<{ job: number }>('/api/system/reconcile')).job))}>{'Reconcile websites & proxy'}</button>
              <button class="btn" disabled={act.busy} onClick={() => void act.run(async () => setJob((await api.post<{ job: number }>('/api/system/renew-certificates')).job))}>Check/renew certificates now</button>
            </div>
            {act.error && <Notice tone="err">{act.error}</Notice>}
            {job !== null && <div style={{ marginTop: 'var(--sp-3)' }}><JobLog jobId={job} /></div>}
          </Panel>
          <Panel title="Server">
            <div class="rows">
              <div><span class="muted">WebManager</span><span>v{s.version}</span></div>
              {s.system && <div><span class="muted">Docker</span><span>{s.system.docker.version ?? '?'} ({s.system.docker.os ?? '?'}, {s.system.docker.arch ?? '?'})</span></div>}
              {s.system && <div><span class="muted">Container</span><span>{s.system.docker.running ?? '?'} {'running /'} {s.system.docker.containers ?? '?'} {'total'}</span></div>}
              {s.system && <div><span class="muted">Load (1/5/15 min)</span><span class="num">{s.system.host.load.map((x) => x.toFixed(2).replace('.', ',')).join(' / ')}</span></div>}
              {s.system && <div><span class="muted">Memory</span><span>{formatBytes(s.system.host.memTotal)}</span></div>}
              {disk && s.system?.disk && (
                <div><span class="muted">Disk</span><span>{formatBytes(s.system.disk.freeBytes)} {'free of'} {formatBytes(s.system.disk.totalBytes)}</span></div>
              )}
              {s.system?.acmeStaging && <div><span class="muted">Let's Encrypt</span><span>STAGING mode active (certificates are not trusted)</span></div>}
              <div><span class="muted">Active tasks</span><span>{s.jobs_active}</span></div>
            </div>
            {disk && <div style={{ marginTop: 'var(--sp-3)' }}><Bar percent={disk.pct} label="Disk used" /></div>}
          </Panel>
        </>
      )}
    </div>
  );
}
