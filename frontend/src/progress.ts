import { fill } from './i18n.ts';
/**
 * Progress of work whose real length is unknown (the worker does not report percentages).
 * The number is an estimate that rises quickly at first and flattens towards 95 %, never goes backwards and only reaches
 * 100 % when the job has really ended. What makes it trustworthy is the running clock next to it: as long as the seconds
 * count up the page is alive, and a hint appears when nothing has changed for a long time.
 */
export type Phase = 'request' | 'queued' | 'running' | 'done';

export interface ProgressView {
  active: boolean;
  percent: number;
  elapsedMs: number;
  /** nothing changed for a long time: still running, but slower than usual */
  stalled: boolean;
  phase: Phase;
}

export const IDLE: ProgressView = { active: false, percent: 0, elapsedMs: 0, stalled: false, phase: 'request' };

/** Percent for a phase after `sinceMs` in it. request 0-20, queued 20-35, running 35-95, done 100. */
export function estimatePercent(phase: Phase, sinceMs: number, tauMs = 8000): number {
  const t = Math.max(0, sinceMs);
  switch (phase) {
    case 'request': return 20 * (1 - Math.exp(-t / 700));
    case 'queued': return 20 + 15 * (1 - Math.exp(-t / 4000));
    case 'running': return 35 + 60 * (1 - Math.exp(-t / Math.max(1000, tauMs)));
    case 'done': return 100;
  }
}

/** "4 s", "59 s", "1:05 Min.", "12:00 Min." */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  return fill('{m}:{s} min', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') });
}

export const STALL_AFTER_MS = 45_000;

export function isStalled(now: number, lastChangeAt: number, limit = STALL_AFTER_MS): boolean {
  return now - lastChangeAt > limit;
}

/** The text inside a busy button: "37 % · 12 s". */
export function progressText(v: Pick<ProgressView, 'percent' | 'elapsedMs'>): string {
  return `${Math.round(v.percent)} % · ${formatElapsed(v.elapsedMs)}`;
}
