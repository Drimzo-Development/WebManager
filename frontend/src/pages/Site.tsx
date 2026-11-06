import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { certInfo, formatBytes, relativeTime, stateInfo } from '../format.ts';
import { canSee, siteHref, TABS, visibleSubs, visibleTabs, type Caller, type TabKey } from '../routes.ts';
import { useLoad } from '../runtime.ts';
import type { Job, Me, MetricsAnswer, SiteDetail, SiteLive } from '../types.ts';
import { ErrorNote, Icon, PageSkeleton, Pill, Spark } from '../ui.tsx';
import { ActionButton } from './site/Actions.tsx';
import { ConsoleSection } from './site/Console.tsx';
import { ResourcesCard } from './site/Resources.tsx';
import { CommandsSection } from './site/Commands.tsx';
import { CronSection } from './site/Cron.tsx';
import { DatabaseSection } from './site/Database.tsx';
import { DomainsSection, WebserverSection } from './site/Domains.tsx';
import { EnvSection } from './site/Env.tsx';
import { FilesSection } from './site/Files.tsx';
import { GateSection, MaintenanceSection, RulesSection, SecuritySection } from './site/Protection.tsx';
import { ReportSection } from './site/Report.tsx';
import { SettingsSection } from './site/Settings.tsx';
import { StatsSection } from './site/Stats.tsx';
import { fill, locale } from '../i18n.ts';
import { buildBars, formatPct, uptimeTone, type UptimeAnswer } from '../uptime.ts';

const FINISHED = ['succeeded', 'failed', 'cancelled'];
const JOB_LABEL: Record<string, string> = { succeeded: 'done', failed: 'failed', running: 'running', queued: 'waiting', cancelled: 'cancelled', cancelling: 'being cancelled' };

/** What this caller may do with the site, mirroring the server (which decides again on every request). */
export function callerOf(me: Me): Caller {
  return { role: me.user.role };
}

export function abilities(me: Me) {
  const c = callerOf(me);
  return {
    act: ['operator', 'admin'].includes(me.user.role),
    logs: canSee(c, 'logs'),
    metrics: canSee(c, 'logs'),
  };
}

// ---------------------------------------------------------------- overview
function Overview({ me, d, id }: { me: Me; d: SiteDetail; id: number }) {
  const can = abilities(me);
  const live = useLoad(() => api.get<SiteLive>(`/api/v1/sites/${id}/status`), 10_000);
  const metrics = useLoad(() => (can.metrics ? api.get<MetricsAnswer>(`/api/v1/sites/${id}/metrics?range=24h`) : Promise.reject(new Error('no permission'))), 60_000);
  const jobs = useLoad(() => api.get<{ jobs: Job[] }>(`/api/v1/sites/${id}/jobs`), 15_000);
  const pts = metrics.data?.points ?? [];
  const st = live.data?.stats ?? null;
  const last = pts[pts.length - 1];
  const reqPerMin = last ? Math.round(last.req) : null;
  const cert = d.cert ? certInfo(d.cert.status, d.cert.not_after) : certInfo('none', null);
  const status = d.status;

  return (
    <div class="stack">
      <div class="stats">
        <div class="card card-pad stat">
          <div class="top-row"><span class="muted small">CPU</span><span class="big num">{st ? `${Math.round(st.cpuPercent)} %` : '–'}</span></div>
          <Spark data={pts.map((p) => p.cpu)} />
        </div>
        <div class="card card-pad stat">
          <div class="top-row"><span class="muted small">Memory</span><span class="big num">{st ? formatBytes(st.memBytes) : '–'}</span></div>
          <Spark data={pts.map((p) => p.mem)} />
        </div>
        <div class="card card-pad stat">
          <div class="top-row"><span class="muted small">Requests / min.</span><span class="big num">{reqPerMin ?? '–'}</span></div>
          <Spark data={pts.map((p) => p.req)} />
        </div>
      </div>

      <div class="grid-2">
        <section class="card card-pad">
          <div class="card-head">
            <h2>Latest tasks</h2>
            <a class="small" href={siteHref(id, 'ops', 'jobs')}>Show all</a>
          </div>
          <div class="timeline">
            {(jobs.data?.jobs ?? []).slice(0, 5).map((j) => (
              <div class="tl" key={j.id}>
                <span class={`ic${FINISHED.includes(j.status) ? (j.status === 'succeeded' ? '' : ' bad') : ' run'}`}>
                  <Icon name={j.status === 'succeeded' ? 'check' : j.status === 'failed' ? 'x' : 'refresh'} small />
                </span>
                <div><span translate={false}>{j.title}</span><div class="muted small">{JOB_LABEL[j.status] ?? j.status}</div></div>
                <span class="muted small">{relativeTime(j.finished_at ?? j.created_at)}</span>
              </div>
            ))}
            {jobs.data && jobs.data.jobs.length === 0 && <p class="muted small">No tasks for this website yet.</p>}
            {jobs.error && <ErrorNote message={jobs.error} />}
          </div>
        </section>

        <div class="stack">
          <UptimeCard id={id} />
          <ResourcesCard id={id} />
          <section class="card card-pad">
            <div class="card-head"><h2>Domains</h2></div>
            <div class="rows">
              {d.domains.map((dom) => (
                <div key={dom}>
                  <a href={`${status?.tls ? 'https' : 'http'}://${dom}`} target="_blank" rel="noopener noreferrer">{dom}</a>
                  <Pill tone={status?.tls ? cert.tone : ''}>{status?.tls ? fill('HTTPS · {label}', { label: cert.label }) : 'HTTP'}</Pill>
                </div>
              ))}
              {d.domains.length === 0 && <p class="muted small">No domain entered.</p>}
            </div>
          </section>
          <section class="card card-pad">
            <div class="card-head"><h2>Container</h2></div>
            <div class="rows">
              <div><span class="muted">Runtime</span><span>{d.site.runtime || d.site.type}</span></div>
              <div><span class="muted">Image</span><span class="mono">{status?.image ?? '–'}</span></div>
              <div><span class="muted">Started</span><span>{status?.startedAt && status.running ? relativeTime(status.startedAt) : '–'}</span></div>
              <div><span class="muted">Restarts</span><span class="num">{status?.restartCount ?? 0}{status?.oomKilled ? ' · memory exhausted' : ''}</span></div>
              <div><span class="muted">Limits</span><span class="num">{d.site.memory_mb} MB · {d.site.cpus} CPU</span></div>
            </div>
          </section>
        </div>
      </div>

      {can.logs && (
        <section class="card card-pad">
          <div class="card-head"><h2>Live log</h2><a class="small" href={siteHref(id, 'ops', 'logs')}>Full</a></div>
          <LogView id={id} compact />
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- availability
const HOURS_BAR = 48; // half-hour bars: the last 24 hours

function UptimeCard({ id }: { id: number }) {
  const up = useLoad(() => api.get<UptimeAnswer>(`/api/v1/sites/${id}/uptime`), 60_000);
  const d = up.data;
  const bars = d ? buildBars(d.hours, 1800, HOURS_BAR, Date.now() / 1000) : [];
  const fmt = new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' });
  const label = (b: (typeof bars)[number]) => (b.state === 'none' ? 'no checks' : b.state === 'ok' ? 'all checks succeeded' : fill('{up} of {n} checks succeeded', { up: b.up, n: b.n }));
  return (
    <section class="card card-pad">
      <div class="card-head">
        <h2>Availability</h2>
        {d && d.summary.pct24 !== null && <Pill tone={uptimeTone(d.summary.pct24)}>{formatPct(d.summary.pct24)}</Pill>}
      </div>
      {up.error && <ErrorNote message={up.error} onRetry={up.reload} />}
      {d && d.summary.checks === 0 && <p class="muted small">No checks yet. A running website is checked every minute.</p>}
      {d && d.summary.checks > 0 && (
        <>
          <div class="uptime-bars" role="img" aria-label={fill('Availability of the last 24 hours: {pct}', { pct: formatPct(d.summary.pct24) })}>
            {bars.map((b) => <span key={b.t} class={`ub ${b.state}`} title={`${fmt.format(new Date(b.t * 1000))} – ${label(b)}`} />)}
          </div>
          <div class="uptime-axis muted small"><span>24 h ago</span><span>now</span></div>
          <div class="rows">
            <div><span class="muted">Last 24 hours</span><span class="num">{formatPct(d.summary.pct24)}</span></div>
            <div><span class="muted">Last 7 days</span><span class="num">{formatPct(d.summary.pct7)}</span></div>
            <div><span class="muted">Last 14 days</span><span class="num">{formatPct(d.summary.pct14)}</span></div>
            <div><span class="muted">Response time (24 h)</span><span class="num">{d.summary.ms24 === null ? '–' : `${d.summary.ms24} ms`}</span></div>
          </div>
          {d.failures.length > 0 && (
            <details class="uptime-fail">
              <summary class="small">Recent failed checks ({d.failures.length})</summary>
              <ul class="small">
                {d.failures.map((f) => <li key={f.at}><span class="muted">{relativeTime(f.at)}</span> · {f.error || (f.status ? `HTTP ${f.status}` : 'failed')}</li>)}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- logs
const SOURCES = [['container', 'Container'], ['access', 'Access'], ['error', 'Error']] as const;

function LogView({ id, compact = false }: { id: number; compact?: boolean }) {
  const [source, setSource] = useState<(typeof SOURCES)[number][0]>('container');
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLPreElement>(null);
  const tail = compact ? 12 : 300;
  const log = useLoad(() => api.get<{ log: string }>(`/api/v1/sites/${id}/logs?source=${source}&tail=${tail}`), follow ? 5_000 : 0);
  // reload on source change (useLoad keeps its closure of the first render)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else log.reload();
  }, [source]);
  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight;
  }, [log.data]);

  return (
    <div>
      <div class="log-tools">
        <div class="subtabs" role="group" aria-label="Log source">
          {SOURCES.map(([k, label]) => <button key={k} aria-pressed={source === k} onClick={() => setSource(k)}>{label}</button>)}
        </div>
        {!compact && (
          <label class="small muted check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} /> {'Refresh every 5 seconds'}</label>
        )}
      </div>
      {log.error && <ErrorNote message={log.error} onRetry={log.reload} />}
      <pre ref={box} class={`log${compact ? ' compact' : ' tall'}`} tabIndex={0} aria-label="Log">{log.loading && !log.data ? 'Loading …' : log.data?.log?.trim() || '(no entries)'}</pre>
    </div>
  );
}

// ---------------------------------------------------------------- jobs
function JobsTab({ id }: { id: number }) {
  const jobs = useLoad(() => api.get<{ jobs: Job[] }>(`/api/v1/sites/${id}/jobs`), 10_000);
  return (
    <section class="card card-pad">
      <div class="card-head"><h2>Tasks</h2></div>
      {jobs.error && <ErrorNote message={jobs.error} onRetry={jobs.reload} />}
      <div class="scroll-x">
        <table>
          <thead><tr><th>Task</th><th>Status</th><th class="hide-sm">Started</th><th class="hide-sm">Done</th><th><span class="sr">Details</span></th></tr></thead>
          <tbody>
            {(jobs.data?.jobs ?? []).map((j) => (
              <tr key={j.id}>
                <td translate={false}>{j.title}</td>
                <td><Pill tone={j.status === 'succeeded' ? 'ok' : j.status === 'failed' ? 'err' : j.status === 'running' || j.status === 'queued' ? 'warn' : ''}>{JOB_LABEL[j.status] ?? j.status}</Pill></td>
                <td class="hide-sm muted small">{relativeTime(j.created_at)}</td>
                <td class="hide-sm muted small">{j.finished_at ? relativeTime(j.finished_at) : '–'}</td>
                <td class="num"><a class="small" href={`#/jobs/${j.id}`}>Details</a></td>
              </tr>
            ))}
          </tbody>
        </table>
        {jobs.data && jobs.data.jobs.length === 0 && <p class="muted empty">No tasks yet.</p>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- page
/** The section component for a sub key; each one loads and saves on its own. */
function Section({ sub, id, d, reload }: { sub: string; id: number; d: SiteDetail; reload: () => void }) {
  switch (sub) {
    case 'files': return <FilesSection id={id} />;
    case 'database': return <DatabaseSection id={id} slug={d.site.slug} siteName={d.site.name} onChanged={reload} />;
    case 'domains': return <DomainsSection id={id} domains={d.domains} onChanged={reload} />;
    case 'webserver': return <WebserverSection id={id} />;
    case 'maintenance': return <MaintenanceSection id={id} onChanged={reload} />;
    case 'gate': return <GateSection id={id} onChanged={reload} />;
    case 'rules': return <RulesSection id={id} onChanged={reload} />;
    case 'security': return <SecuritySection id={id} onChanged={reload} />;
    case 'logs': return <section class="card card-pad"><LogView id={id} /></section>;
    case 'jobs': return <JobsTab id={id} />;
    case 'console': return <ConsoleSection id={id} running={d.state === 'running'} />;
    case 'stats': return <StatsSection id={id} />;
    case 'report': return <ReportSection id={id} />;
    case 'commands': return <CommandsSection id={id} d={d} onChanged={reload} />;
    case 'env': return <EnvSection id={id} />;
    case 'cron': return <CronSection id={id} />;
    case 'settings': return <SettingsSection id={id} d={d} onChanged={reload} />;
    default: return null;
  }
}

export function SitePage({ me, id, tab, sub }: { me: Me; id: number; tab: TabKey; sub: string | null }) {
  const site = useLoad(() => api.get<SiteDetail>(`/api/v1/sites/${id}`), 10_000);
  const bar = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState({ left: 0, width: 0 });

  useEffect(() => {
    const a = bar.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (a) {
      setInd({ left: a.offsetLeft, width: a.offsetWidth });
      // keep the open tab visible when the row scrolls (narrow windows)
      const el = bar.current!;
      el.scrollLeft = Math.max(0, a.offsetLeft - (el.clientWidth - a.offsetWidth) / 2);
    }
  }, [tab, !site.data]);

  // soft edge on the side where more tabs are hidden
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const edges = () => {
      el.classList.toggle('fade-l', el.scrollLeft > 4);
      el.classList.toggle('fade-r', el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    };
    edges();
    el.addEventListener('scroll', edges, { passive: true });
    addEventListener('resize', edges);
    return () => {
      el.removeEventListener('scroll', edges);
      removeEventListener('resize', edges);
    };
  }, [!site.data]);

  if (site.error && !site.data) {
    return (
      <main>
        <p class="crumbs muted"><a href="#/">Overview</a> /</p>
        <ErrorNote message={site.error} onRetry={site.reload} />
      </main>
    );
  }
  const d = site.data;
  if (!d) return <PageSkeleton />;
  const can = abilities(me);
  const caller = callerOf(me);
  const info = stateInfo(d.state);
  const running = ['running', 'starting', 'unhealthy'].includes(d.state);
  const ready = d.site.lifecycle === 'ready';
  const first = d.domains[0];
  const tabs = visibleTabs(caller);
  const def = TABS.find((t) => t.key === tab);
  const subs = def ? visibleSubs(def, caller) : [];
  // an address that points to something this caller may not see falls back to what they may see
  const activeSub = sub && subs.some((x) => x.key === sub) ? sub : subs[0]?.key ?? null;
  const allowedTab = tab === 'overview' || tabs.some((t) => t.key === tab);

  return (
    <main>
      <div>
        <p class="crumbs muted"><a href="#/">Overview</a> / Websites /</p>
        <div class="site-head">
          <div class="l">
            <span class="ico"><Icon name="globe" /></span>
            <div>
              <h1 translate={false}>{d.site.name}</h1>
              <div class="meta">
                <Pill tone={info.tone} live={d.state === 'running'}>{d.busy ? 'Working …' : info.label}</Pill>
                <span class="tag">{d.site.runtime || d.site.type}</span>
                {d.site.maintenance_enabled && <Pill tone="warn">Maintenance mode</Pill>}
                {d.site.gate_enabled && <Pill tone="ok">Password protection</Pill>}
                <span class="muted small">{d.site.slug}{d.site.description ? ` · ${d.site.description}` : ''}</span>
              </div>
            </div>
          </div>
          <div class="row">
            {first && (
              <a class="btn" href={`${d.status?.tls ? 'https' : 'http'}://${first}`} target="_blank" rel="noopener noreferrer"><Icon name="external-link" />Open</a>
            )}
            {can.act && ready && (running ? (
              <>
                <ActionButton id={id} action="restart" icon="refresh" label="Restart" locked={d.busy} onDone={site.reload} />
                <ActionButton id={id} action="stop" icon="x" label="Stop" locked={d.busy} onDone={site.reload} />
              </>
            ) : (
              <ActionButton id={id} action="start" icon="zap" label="Start" primary locked={d.busy} onDone={site.reload} />
            ))}
          </div>
        </div>
      </div>

      {d.agent_error && <ErrorNote message={fill('Container status not available: {agent_error}', { agent_error: d.agent_error })} />}

      <div class="tabs" role="tablist" aria-label="Sections" ref={bar}>
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => (location.hash = siteHref(id, t.key).slice(1))}>
            <Icon name={t.icon} small />{t.label}
          </button>
        ))}
        <span class="ind" style={{ left: `${ind.left}px`, width: `${ind.width}px` }} />
      </div>

      {!allowedTab && <ErrorNote message="This section is not available to you." />}
      {allowedTab && subs.length > 1 && (
        <div class="subtabs" role="group" aria-label="Subsections">
          {subs.map((x) => <button key={x.key} aria-pressed={activeSub === x.key} onClick={() => (location.hash = siteHref(id, tab, x.key).slice(1))}>{x.label}</button>)}
        </div>
      )}

      {allowedTab && tab === 'overview' && <Overview me={me} d={d} id={id} />}
      {allowedTab && activeSub && canSee(caller, activeSub) && <Section key={activeSub} sub={activeSub} id={id} d={d} reload={site.reload} />}
    </main>
  );
}
