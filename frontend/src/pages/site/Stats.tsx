import { useEffect, useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { Chart } from '../../Chart.tsx';
import { Loading, Notice, Panel } from '../../forms.tsx';
import { formatBytes } from '../../format.ts';
import { useLoad } from '../../runtime.ts';
import type { MetricsAnswer } from '../../types.ts';
import { PRESETS, SECTIONS, STATUS_CLASSES, parseFilter, presetOf, toggle, type Preset, type Section, type StatsFilter, type StatusClass } from '../../statsFilter.ts';
import { locale, decimal } from '../../i18n.ts';

type Range = '1h' | '24h' | '7d' | '30d';
const RANGES: [Range, string][] = [['1h', '1 hour'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']];

const WAF_NAMES: Record<string, string> = {
  sqli: 'SQL injection', xss: 'XSS', traversal: 'Path traversal', rce: 'Command injection', probe: 'Sensitive files', scanner: 'Scanner',
};

interface Stats extends MetricsAnswer {
  bucketSec: number;
  visitors: { day: string; n: number }[];
  top404: { path: string; count: number }[];
  waf: Record<string, number>;
  recentWaf: { t: number; cat: string; ip: string; request: string }[];
  points: (MetricsAnswer['points'][number] & { s2: number; s3: number; s4: number; s5: number; bytes: number })[];
}

const PRESET_LABEL: Record<Preset, string> = { all: 'Everything', errors: 'Errors only', server: 'Server errors only (5xx)' };
const STATUS_LABEL: Record<StatusClass, string> = { s2: 'Success (2xx)', s3: 'Redirect (3xx)', s4: 'Client errors (4xx)', s5: 'Server errors (5xx)' };
const SECTION_LABEL: Record<Section, string> = { requests: 'Requests', resources: 'CPU & memory', traffic: 'Data & visitors', lists: 'Page lists', waf: 'Firewall' };
const FILTER_KEY = 'wm.stats.filter';

function loadFilter(): StatsFilter {
  try {
    return parseFilter(localStorage.getItem(FILTER_KEY));
  } catch {
    return parseFilter(null);
  }
}

const num = (v: number) => Math.round(v).toLocaleString(locale());

function TopTable({ title, rows, empty }: { title: string; rows: { path: string; count: number }[]; empty: string }) {
  return (
    <Panel title={title}>
      {rows.length ? (
        <div class="scroll-x">
          <table>
            <tbody>{rows.map((r) => <tr key={r.path}><td class="mono">{r.path}</td><td class="num">{num(r.count)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : <p class="muted small">{empty}</p>}
    </Panel>
  );
}

export function StatsSection({ id }: { id: number }) {
  const [range, setRange] = useState<Range>('24h');
  const [filter, setFilterState] = useState<StatsFilter>(loadFilter);
  const setFilter = (f: StatsFilter) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(f));
    } catch {
      /* private window: the filter just is not remembered */
    }
  };
  const has = (s: Section) => filter.sections.includes(s);
  const preset = presetOf(filter);
  const load = useLoad(() => api.get<Stats>(`/api/v1/sites/${id}/metrics?range=${range}`), 60_000);
  useEffect(() => load.reload(), [range]);
  const timeFormat = (t: number) => new Date(t).toLocaleString(locale(), range === '1h' || range === '24h' ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return (
    <div class="stack">
      <Panel
        title="Statistics"
        actions={
          <div class="seg" role="group" aria-label="Period">
            {RANGES.map(([k, l]) => <button key={k} aria-pressed={range === k} onClick={() => setRange(k)}>{l}</button>)}
          </div>
        }
      >
        <p class="muted small">{'From container values and the proxy\'s access log, without tracking scripts. No IP addresses are stored; visitors are only counted through short-lived identifiers that cannot be traced back. Recording starts when the website has a domain.'}</p>
        <div class="filter-bar" role="group" aria-label="Filter the display">
          <div class="chips">
            {(Object.keys(PRESETS) as Preset[]).map((k) => <button key={k} class={`chip${preset === k ? ' active' : ''}`} aria-pressed={preset === k} onClick={() => setFilter(PRESETS[k])}>{PRESET_LABEL[k]}</button>)}
          </div>
          <details class="filter-more" open={preset === null}>
            <summary>Custom selection</summary>
            <div class="filter-groups">
              <fieldset>
                <legend class="muted small">Requests by status</legend>
                <div class="chips">{STATUS_CLASSES.map((c) => <button key={c} class={`chip${filter.status.includes(c) ? ' active' : ''}`} aria-pressed={filter.status.includes(c)} onClick={() => setFilter({ ...filter, status: toggle(filter.status, STATUS_CLASSES, c, true) })}>{STATUS_LABEL[c]}</button>)}</div>
              </fieldset>
              <fieldset>
                <legend class="muted small">Sections</legend>
                <div class="chips">{SECTIONS.map((c) => <button key={c} class={`chip${has(c) ? ' active' : ''}`} aria-pressed={has(c)} onClick={() => setFilter({ ...filter, sections: toggle(filter.sections, SECTIONS, c) })}>{SECTION_LABEL[c]}</button>)}</div>
              </fieldset>
            </div>
          </details>
        </div>
      </Panel>
      <Loading load={load}>
        {(m) => {
          const times = m.points.map((p) => p.t);
          const perMin = m.bucketSec / 60;
          const per = (v: number | undefined) => Math.round(((v ?? 0) / perMin) * 10) / 10;
          const hasData = m.totals.req > 0 || m.points.some((p) => p.cpu !== null);
          const wafTotal = Object.values(m.waf).reduce((a, b) => a + b, 0);
          return (
            <>
              <div class="stats five">
                {[['Requests', num(m.totals.req)], ['Visitors (today)', num(m.visitors.at(-1)?.n ?? 0)], ['Errors 4xx/5xx', num(m.totals.s4 + m.totals.s5)], ['Data volume', formatBytes(m.totals.bytes ?? 0)], ['WAF hits', num(m.totals.waf ?? 0)]].map(([k, v]) => (
                  <div class="card card-pad stat" key={k}><span class="muted small">{k}</span><span class="big num block">{v}</span></div>
                ))}
              </div>
              {filter.sections.length === 0 && <Notice>All sections are hidden. Choose “Everything” above or pick individual sections under “Custom selection”.</Notice>}
              {!hasData ? <Notice>There is no data for this period yet. Recording runs every minute.</Notice> : (
                <>
                  {has('requests') && (
                    <Panel title="Requests per minute">
                      <Chart title="Requests per minute" kind="bars" stacked times={times} unit="/min" timeFormat={timeFormat} series={[
                        { key: 's2', color: 'var(--ok)' },
                        { key: 's3', color: 'var(--brand)' },
                        { key: 's4', color: 'var(--warn)' },
                        { key: 's5', color: 'var(--err)' },
                      ].filter((x) => filter.status.includes(x.key as StatusClass)).map((x) => ({ label: STATUS_LABEL[x.key as StatusClass], color: x.color, values: m.points.map((p) => per(p[x.key as StatusClass])) }))} />
                    </Panel>
                  )}
                  {has('resources') && <div class="grid-2 even">
                    <Panel title="CPU load"><Chart title="CPU" times={times} unit="%" timeFormat={timeFormat} series={[{ label: 'CPU', color: 'var(--brand)', values: m.points.map((p) => p.cpu) }]} /></Panel>
                    <Panel title="Memory"><Chart title="Memory" times={times} unit="MB" format={(v) => String(Math.round(v))} timeFormat={timeFormat} series={[{ label: 'Memory', color: 'var(--ok)', values: m.points.map((p) => (p.mem === null ? null : p.mem / 1048576)) }]} /></Panel>
                  </div>}
                  {has('traffic') && <div class="grid-2 even">
                    <Panel title="Data volume (delivered)"><Chart title="Data volume" kind="bars" times={times} unit="MB" format={(v) => decimal(String(Math.round(v * 100) / 100))} timeFormat={timeFormat} series={[{ label: 'Data', color: 'var(--brand)', values: m.points.map((p) => (p.bytes ?? 0) / 1048576) }]} /></Panel>
                    <Panel title="Visitors per day"><Chart title="Visitors" kind="bars" times={m.visitors.map((v) => Date.parse(`${v.day}T12:00:00Z`))} unit="" format={(v) => String(Math.round(v))} timeFormat={(x) => new Date(x).toLocaleDateString(locale())} series={[{ label: 'Visitors', color: 'var(--ok)', values: m.visitors.map((v) => v.n) }]} /></Panel>
                  </div>}
                </>
              )}
              {has('lists') && (
                <div class="grid-2 even">
                  {preset !== 'errors' && preset !== 'server' && <TopTable title="Most visited pages" rows={m.topPages} empty="No page views yet." />}
                  <TopTable title="Most frequent “not found” (404)" rows={m.top404} empty="No 404 errors." />
                </div>
              )}
              {has('waf') && <Panel title="Firewall (WAF)">
                {wafTotal === 0 ? <p class="muted small">{'No hits in this period (or the WAF is not active under “Protection → Security & WAF”).'}</p> : (
                  <>
                    <div class="row">{Object.entries(m.waf).sort((a, b) => b[1] - a[1]).map(([k, v]) => <span class="pill warn" key={k}>{WAF_NAMES[k] ?? k}: {num(v)}</span>)}</div>
                    <div class="scroll-x" style={{ marginTop: 'var(--sp-3)' }}>
                      <table>
                        <thead><tr><th>Time</th><th>Category</th><th>Address</th><th>Request</th></tr></thead>
                        <tbody>
                          {m.recentWaf.slice(0, 15).map((e, i) => (
                            <tr key={i}><td class="small">{new Date(e.t).toLocaleString(locale())}</td><td>{WAF_NAMES[e.cat] ?? e.cat}</td><td class="mono">{e.ip}</td><td class="mono wrap">{e.request}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </Panel>}
            </>
          );
        }}
      </Loading>
    </div>
  );
}
