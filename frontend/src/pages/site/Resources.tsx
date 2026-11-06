import { api } from '../../api.ts';
import { formatBytes } from '../../format.ts';
import { fill } from '../../i18n.ts';
import { cpuOfLimit, diskTrend, signedBytes, type ResourcesAnswer } from '../../resources.ts';
import { useLoad } from '../../runtime.ts';
import { Bar, ErrorNote, Pill, Spark } from '../../ui.tsx';

/** Limits, current use, restarts and the disk space over the last 30 days of one website. */
export function ResourcesCard({ id }: { id: number }) {
  const res = useLoad(() => api.get<ResourcesAnswer>(`/api/v1/sites/${id}/resources`), 30_000);
  const d = res.data;
  const trend = d ? diskTrend(d.disk) : null;
  const mem = d?.usage;
  return (
    <section class="card card-pad">
      <div class="card-head">
        <h2>Resources</h2>
        {d?.oom && <Pill tone="err">Memory exhausted</Pill>}
      </div>
      {res.error && <ErrorNote message={res.error} onRetry={res.reload} />}
      {d && (
        <div class="rows">
          <div>
            <span class="muted">Memory</span>
            <span class="num">{mem ? `${formatBytes(mem.memBytes)} of ${d.limits.memory_mb} MB` : `Limit ${d.limits.memory_mb} MB`}</span>
          </div>
          {mem && <div><Bar percent={mem.memPercent} label="Memory" /></div>}
          <div>
            <span class="muted">CPU</span>
            <span class="num">{mem ? `${Math.round(mem.cpuPercent)} % · ` : ''}{fill('limit {n} CPU', { n: d.limits.cpus })}</span>
          </div>
          {mem && <div><Bar percent={cpuOfLimit(mem.cpuPercent, d.limits.cpus)} label="CPU of the limit" /></div>}
          <div><span class="muted">Processes</span><span class="num">{mem ? `${mem.pids} of ${d.limits.pids}` : `Limit ${d.limits.pids}`}</span></div>
          <div><span class="muted">Restarts</span><span class="num">{d.restarts ?? '–'}</span></div>
          <div>
            <span class="muted">Disk space</span>
            <span class="num">
              {trend ? formatBytes(trend.latest) : '–'}
              {trend && trend.delta !== null ? <span class="muted small">{' '}({signedBytes(trend.delta, formatBytes)} in 7 days)</span> : null}
            </span>
          </div>
        </div>
      )}
      {d && d.disk.length > 1 && (
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <Spark data={d.disk.map((x) => x.bytes)} />
          <div class="uptime-axis muted small"><span>Disk space, last 30 days</span><span>measured daily</span></div>
        </div>
      )}
      {d && d.disk.length === 0 && <p class="muted small" style={{ marginTop: 'var(--sp-3)' }}>The disk space is measured once a day; the first value appears within a day.</p>}
    </section>
  );
}
