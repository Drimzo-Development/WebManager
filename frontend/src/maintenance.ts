import type { MaintenanceWindow } from './types.ts';

export const REPEAT_LABEL = { none: 'Once', daily: 'Every day', weekly: 'Every week' } as const;

/** Value of a datetime-local input (local time, "2026-11-10T22:00") from a Date. */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The next full hour after `from`, a sensible default for the start. */
export function nextFullHour(from: Date): Date {
  const d = new Date(from);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

/** Local datetime-local value -> ISO string with the real instant (the server stores UTC). Null when it is not a date. */
export function localToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Short state text of a window: running until …, next start, or over. */
export function stateOf(w: MaintenanceWindow): 'active' | 'upcoming' | 'over' {
  return w.active ? 'active' : w.next_start ? 'upcoming' : 'over';
}
