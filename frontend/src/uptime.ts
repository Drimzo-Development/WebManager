import type { Tone } from './format.ts';

export interface UptimeBucket {
  /** start of the bucket, unix seconds */
  t: number;
  n: number;
  up: number;
  ms: number | null;
}

export interface UptimeAnswer {
  summary: { checks: number; pct24: number | null; pct7: number | null; pct14: number | null; ms24: number | null };
  hours: UptimeBucket[];
  days: UptimeBucket[];
  failures: { at: string; status: number | null; error: string }[];
}

export interface UptimeBar {
  t: number;
  state: 'ok' | 'warn' | 'err' | 'none';
  n: number;
  up: number;
}

/** Percentage for display: never rounds up to 100 (99.996 → "99.99 %"), whole numbers without decimals. */
export function formatPct(p: number | null | undefined): string {
  if (p === null || p === undefined || Number.isNaN(p)) return '–';
  if (p >= 100) return '100 %';
  const floored = Math.floor(p * 100) / 100;
  return `${Number.isInteger(floored) ? floored : floored.toFixed(2).replace(/0$/, '')} %`;
}

export function uptimeTone(p: number | null | undefined): Tone {
  if (p === null || p === undefined) return '';
  return p >= 99.9 ? 'ok' : p >= 99 ? 'warn' : 'err';
}

/**
 * `count` bars of `stepSec` seconds ending with the bucket that contains `nowSec`; periods without checks are "none".
 * A bar is red when every check failed, orange when some did.
 */
export function buildBars(buckets: readonly UptimeBucket[], stepSec: number, count: number, nowSec: number): UptimeBar[] {
  const byStart = new Map(buckets.map((b) => [b.t, b]));
  const last = Math.floor(nowSec / stepSec) * stepSec;
  const out: UptimeBar[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = last - i * stepSec;
    const b = byStart.get(t);
    if (!b || b.n === 0) out.push({ t, state: 'none', n: 0, up: 0 });
    else out.push({ t, state: b.up >= b.n ? 'ok' : b.up === 0 ? 'err' : 'warn', n: b.n, up: b.up });
  }
  return out;
}
