import { useState } from 'preact/hooks';
import { areaOf, nearestIndex, niceMax, pathOf, stackedMax, toSegments } from './chart.ts';
import { fill, locale, decimal } from './i18n.ts';

export interface Series {
  label: string;
  /** CSS colour, usually a theme variable such as "var(--ok)" */
  color: string;
  values: (number | null)[];
}

interface Props {
  title: string;
  times: number[];
  series: Series[];
  kind?: 'area' | 'bars';
  stacked?: boolean;
  unit?: string;
  format?: (v: number) => string;
  /** "HH:mm" for short ranges, date for longer ones */
  timeFormat?: (t: number) => string;
}

const W = 600;
const H = 160;
const defaultFormat = (v: number) => decimal(String(Math.round(v * 10) / 10));

/** Small dependency free SVG chart: area lines or (stacked) bars, hover tooltip, text summary for screen readers. */
export function Chart({ title, times, series, kind = 'area', stacked = false, unit = '', format = defaultFormat, timeFormat }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const n = times.length;
  const fmtTime = timeFormat ?? ((t: number) => new Date(t).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
  const peak = kind === 'bars' && stacked ? stackedMax(series.map((s) => s.values)) : Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const max = niceMax(peak);
  const summary = series.map((s) => {
    const vals = s.values.filter((v): v is number => v !== null);
    return vals.length ? fill('{label}: latest {last} {unit}, peak {peak} {unit}', { label: s.label, last: format(vals[vals.length - 1]!), unit, peak: format(Math.max(...vals)) }) : fill('{label}: no data', { label: s.label });
  });

  const onMove = (e: MouseEvent | TouchEvent) => {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const cx = 'touches' in e ? e.touches[0]?.clientX ?? 0 : e.clientX;
    setHover(nearestIndex(((cx - rect.left) / rect.width) * W, W, n));
  };

  const colW = n > 0 ? W / n : W;
  return (
    <figure class="chart">
      <div class="chart-body">
        <span class="chart-y top">{format(max)} {unit}</span>
        <span class="chart-y bottom">0</span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${title}. ${summary.join('. ')}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)} onTouchMove={onMove} onTouchEnd={() => setHover(null)}>
          {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} class="grid" />)}
          {kind === 'area' &&
            series.map((s) =>
              toSegments(s.values, max, W, H).map((seg, i) => (
                <g key={s.label + i}>
                  {seg.length > 1 && <path d={areaOf(seg, H)} fill={s.color} fill-opacity=".14" />}
                  <path d={pathOf(seg)} fill="none" stroke={s.color} stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
                  {seg.length === 1 && <circle cx={seg[0]!.x} cy={seg[0]!.y} r="2.5" fill={s.color} />}
                </g>
              )),
            )}
          {kind === 'bars' &&
            times.map((_, i) => {
              let y = H;
              return series.map((s) => {
                const v = s.values[i] ?? 0;
                const hh = (v / max) * (H - 4);
                if (stacked) y -= hh;
                const top = stacked ? y : H - hh;
                return v > 0 ? <rect key={s.label + i} x={i * colW + colW * 0.12} width={colW * 0.76} y={top} height={Math.max(hh, 0.6)} fill={s.color} rx="1" /> : null;
              });
            })}
          {hover !== null && <line x1={n > 1 ? (hover / (n - 1)) * W : W / 2} x2={n > 1 ? (hover / (n - 1)) * W : W / 2} y1="0" y2={H} class="cursor" vector-effect="non-scaling-stroke" />}
        </svg>
        {hover !== null && (
          <div class="chart-tip" style={{ left: `${n > 1 ? (hover / (n - 1)) * 100 : 50}%` }}>
            <b>{fmtTime(times[hover]!)}</b>
            {series.map((s) => (
              <div key={s.label}><i style={{ background: s.color }} />{s.label}: {s.values[hover] === null || s.values[hover] === undefined ? '–' : `${format(s.values[hover]!)} ${unit}`}</div>
            ))}
          </div>
        )}
      </div>
      <figcaption class="chart-x small muted"><span>{n ? fmtTime(times[0]!) : ''}</span><span>{n ? fmtTime(times[n - 1]!) : ''}</span></figcaption>
      {series.length > 1 && (
        <div class="legend small">
          {series.map((s) => <span key={s.label}><i style={{ background: s.color }} />{s.label}</span>)}
        </div>
      )}
    </figure>
  );
}
