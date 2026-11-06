import type { Job } from './types.ts';

const STATUS: Record<string, [string, 'ok' | 'warn' | 'err' | '']> = {
  queued: ['waiting', 'warn'], running: ['running', 'warn'], cancelling: ['being cancelled', 'warn'],
  succeeded: ['done', 'ok'], failed: ['failed', 'err'], cancelled: ['cancelled', ''],
};

export function jobStatus(s: string) {
  const [label, tone] = STATUS[s] ?? [s, ''];
  return { label, tone };
}

/** Seconds between two server timestamps, or null while unfinished. */
export function jobSeconds(j: Pick<Job, 'started_at' | 'finished_at'>): number | null {
  if (!j.started_at || !j.finished_at) return null;
  const a = Date.parse(j.started_at.replace(' ', 'T') + 'Z');
  const b = Date.parse(j.finished_at.replace(' ', 'T') + 'Z');
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.max(0, Math.round((b - a) / 1000));
}
