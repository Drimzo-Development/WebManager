/** Pure geometry for the charts, kept apart from rendering so it can be tested. */

export interface Pt {
  x: number;
  y: number;
}

/** "Nice" upper limit for an axis: 1, 2, 5 times a power of ten, at least as large as the value. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const f = value / base;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return step * base;
}

/** Maps a series onto the drawing area; null values leave a gap (the line is split there). */
export function toSegments(values: readonly (number | null)[], max: number, w: number, h: number, pad = 2): Pt[][] {
  const n = values.length;
  const segs: Pt[][] = [];
  let cur: Pt[] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (cur.length) segs.push(cur);
      cur = [];
      return;
    }
    const x = n === 1 ? w / 2 : (i / (n - 1)) * w;
    cur.push({ x, y: h - pad - (Math.max(0, v) / max) * (h - 2 * pad) });
  });
  if (cur.length) segs.push(cur);
  return segs;
}

export function pathOf(seg: readonly Pt[]): string {
  return seg.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('');
}

/** Closed shape under a segment, for area fills. */
export function areaOf(seg: readonly Pt[], h: number): string {
  const first = seg[0];
  const last = seg[seg.length - 1];
  return first && last ? `${pathOf(seg)}L${last.x.toFixed(1)} ${h}L${first.x.toFixed(1)} ${h}Z` : '';
}

/** Index of the point nearest to a horizontal position (0..w) among n evenly spaced points. */
export function nearestIndex(x: number, w: number, n: number): number {
  if (n <= 1) return 0;
  return Math.max(0, Math.min(n - 1, Math.round((x / w) * (n - 1))));
}

/** Per-bucket totals of stacked series (null counts as 0): the largest one decides the axis. */
export function stackedMax(series: readonly (readonly (number | null)[])[]): number {
  const n = Math.max(0, ...series.map((s) => s.length));
  let max = 0;
  for (let i = 0; i < n; i++) max = Math.max(max, series.reduce((a, s) => a + (s[i] ?? 0), 0));
  return max;
}
