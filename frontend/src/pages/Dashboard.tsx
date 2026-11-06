import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import { certInfo, formatBytes, needsAttention, relativeTime, stateInfo } from '../format.ts';
import { formatPct, uptimeTone } from '../uptime.ts';
import { siteHref } from '../routes.ts';
import { useLoad } from '../runtime.ts';
import type { Job, Me, SiteSummary } from '../types.ts';
import { Bar, ErrorNote, Icon, Pill } from '../ui.tsx';
import { fill, locale } from '../i18n.ts';

type Filter = 'all' | 'running' | 'attention';

interface SitesAnswer {
  sites: SiteSummary[];
  agent_error: string | null;
}

const JOB_DOT: Record<string, string> = { succeeded: 'ok', failed: 'err', cancelled: 'warn', cancelling: 'warn' };

function greeting(me: Me): string {
  const h = new Date().getHours();
  const part = h < 11 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${me.user.name || me.user.email.split('@')[0]}`;
}

/** The container runs, but the latest HTTP check failed. */
const httpDown = (s: SiteSummary) => s.state === 'running' && s.uptime?.last?.ok === false;

export function Dashboard({ me }: { me: Me }) {
  const sites = useLoad(() => api.get<SitesAnswer>('/api/v1/sites'), 15_000);
  const jobs = useLoad(() => api.get<{ jobs: Job[] }>('/api/v1/jobs?limit=6'), 15_000);
  const [filter, setFilter] = useState<Filter>('all');
  const list = sites.data?.sites ?? [];
  const operator = ['operator', 'admin'].includes(me.user.role);

  const running = list.filter((s) => s.state === 'running').length;
  const cpu = list.reduce((a, s) => a + (s.stats?.cpuPercent ?? 0), 0);
  const mem = list.reduce((a, s) => a + (s.stats?.memBytes ?? 0), 0);
  const memLimit = list.reduce((a, s) => a + (s.stats?.memLimitBytes ?? 0), 0);
  const attention = list.flatMap((s) => {
    const level = needsAttention(s.state, s.cert_status, s.cert_not_after, Date.now(), httpDown(s));
    return level ? [{ s, level }] : [];
  });
  const expiring = list.filter((s) => ['warn', 'err'].includes(certInfo(s.cert_status, s.cert_not_after).tone)).length;
  const shown = list.filter((s) => (filter === 'running' ? s.state === 'running' : filter === 'attention' ? needsAttention(s.state, s.cert_status, s.cert_not_after, Date.now(), httpDown(s)) !== null : true));

  return (
    <main>
      <div class="page-head">
        <div>
          <p class="muted small">{new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</p>
          <h1>{greeting(me)}</h1>
        </div>
        <div class="row">
          {operator && (
            <a class="btn primary" href="#/sites/new">
              <Icon name="plus" />
              {'New website'}
            </a>
          )}
        </div>
      </div>

      {sites.error && <ErrorNote message={sites.error} onRetry={sites.reload} />}
      {sites.data?.agent_error && <ErrorNote message={fill('Container status not available: {agent_error}', { agent_error: sites.data.agent_error })} />}

      <div class="kpis">
        <div class="card kpi">
          <div class="label"><Icon name="globe" small />Websites online</div>
          <div class="value num">{sites.loading && !sites.data ? '–' : running}<small> / {list.length}</small></div>
          <Bar percent={list.length ? (running / list.length) * 100 : 0} label="Online" good />
        </div>
        <div class="card kpi">
          <div class="label"><Icon name="cpu" small />CPU (all containers)</div>
          <div class="value num">{Math.round(cpu)}<small> %</small></div>
          <Bar percent={Math.min(cpu, 100)} label="CPU" />
        </div>
        <div class="card kpi">
          <div class="label"><Icon name="database" small />Memory</div>
          <div class="value num">{formatBytes(mem)}<small> / {formatBytes(memLimit)}</small></div>
          <Bar percent={memLimit ? (mem / memLimit) * 100 : 0} label="Memory" />
        </div>
        <div class="card kpi">
          <div class="label"><Icon name="shield-check" small />Certificates</div>
          <div class="value num">{expiring === 0 ? 'All OK' : expiring}<small>{expiring === 0 ? '' : ' due soon'}</small></div>
          <Bar percent={list.length ? ((list.length - expiring) / list.length) * 100 : 0} label="Valid certificates" good />
        </div>
      </div>

      <div class="grid-2">
        <section class="card card-pad">
          <div class="card-head">
            <h2>Websites</h2>
            <div class="seg" role="group" aria-label="Filter">
              {(['all', 'running', 'attention'] as const).map((f) => (
                <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {{ all: 'All', running: 'Running', attention: 'Attention' }[f]}
                </button>
              ))}
            </div>
          </div>
          <div class="scroll-x">
            <table>
              <thead>
                <tr><th>Name</th><th>Status</th><th class="hide-sm">Type</th><th class="hide-sm">Memory</th><th class="hide-sm">Availability</th><th class="hide-sm">Certificate</th></tr>
              </thead>
              <tbody>
                {shown.map((s) => {
                  const st = stateInfo(s.state);
                  const c = certInfo(s.cert_status, s.cert_not_after);
                  return (
                    <tr key={s.id}>
                      <td>
                        <a class="site-name" href={siteHref(s.id)}>
                          <span class="ico"><Icon name="globe" small /></span>
                          <span translate={false}>
                            {s.name}
                            <span class="muted small block">{s.domains[0] ?? 'No domain'}</span>
                          </span>
                        </a>
                      </td>
                      <td><Pill tone={st.tone} live={s.state === 'running'}>{s.busy ? 'Working …' : st.label}</Pill></td>
                      <td class="hide-sm"><span class="tag">{s.runtime || s.type}</span></td>
                      <td class="hide-sm w-bar">{s.stats ? <Bar percent={s.stats.memPercent} label="Memory" /> : <span class="muted small">–</span>}</td>
                      <td class="hide-sm">
                        {s.uptime?.pct24 != null
                          ? <Pill tone={httpDown(s) ? 'err' : uptimeTone(s.uptime.pct24)}>{httpDown(s) ? 'Not answering' : formatPct(s.uptime.pct24)}</Pill>
                          : <span class="muted small">–</span>}
                      </td>
                      <td class="hide-sm"><Pill tone={c.tone}>{c.label}</Pill></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!sites.loading && shown.length === 0 && <p class="muted empty">{list.length === 0 ? 'No websites yet.' : 'No website matches the filter.'}</p>}
          </div>
        </section>

        <div class="stack">
          <section class="card card-pad">
            <div class="card-head">
              <h2>Needs attention</h2>
              {attention.length > 0 && <Pill tone="warn">{attention.length}</Pill>}
            </div>
            <div class="attention">
              {attention.map(({ s, level }) => (
                <div key={s.id} class={`attn${level === 'err' ? ' err' : ''}`}>
                  <Icon name="alert" />
                  <div>
                    <b translate={false}>{s.name}</b>
                    <br />
                    {['crashed', 'unhealthy', 'missing'].includes(s.state) ? stateInfo(s.state).label : httpDown(s) ? 'Not answering HTTP requests' : fill('Certificate: {label}', { label: certInfo(s.cert_status, s.cert_not_after).label })}
                  </div>
                </div>
              ))}
              {attention.length === 0 && <p class="muted small">All good.</p>}
            </div>
          </section>
          <section class="card card-pad feed">
            <div class="card-head">
              <h2>Activity</h2>
              <a href="#/jobs" class="small">All tasks</a>
            </div>
            <ul>
              {(jobs.data?.jobs ?? []).map((j) => (
                <li key={j.id}>
                  <span class={`dot ${JOB_DOT[j.status] ?? ''}`} />
                  <div translate={false}>
                    {j.title}
                    <br />
                    <span class="muted small">{relativeTime(j.finished_at ?? j.created_at)} · {{ succeeded: 'done', failed: 'failed', running: 'running', queued: 'waiting', cancelled: 'cancelled', cancelling: 'being cancelled' }[j.status] ?? j.status}</span>
                  </div>
                </li>
              ))}
              {jobs.data?.jobs.length === 0 && <p class="muted small">No tasks yet.</p>}
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
