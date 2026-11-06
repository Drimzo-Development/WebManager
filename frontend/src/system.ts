export interface SystemSub {
  key: string;
  label: string;
  icon: string;
  group: string;
}

/** Sections of the system page, in display order. */
export const SYSTEM_SUBS: readonly SystemSub[] = [
  { key: 'overview', label: 'Status', icon: 'cpu', group: 'Overview' },
  { key: 'update', label: 'Updates', icon: 'refresh', group: 'Maintenance' },
  { key: 'backup', label: 'Backups', icon: 'archive', group: 'Maintenance' },
  { key: 'storage', label: 'Storage', icon: 'database', group: 'Maintenance' },
  { key: 'login', label: 'Sign-in & 2FA', icon: 'key', group: 'Access & security' },
  { key: 'protect', label: 'Attack protection', icon: 'shield', group: 'Access & security' },
  { key: 'domain', label: 'Dashboard address', icon: 'globe', group: 'Access & security' },
  { key: 'dns', label: 'DNS provider', icon: 'workflow', group: 'Access & security' },
  { key: 'brand', label: 'Appearance', icon: 'star', group: 'Customization' },
  { key: 'notify', label: 'Email & notifications', icon: 'mail', group: 'Messages' },
];

/** "/system" -> overview, "/system/backup" -> backup, anything else is not a system route. */
export function parseSystemRoute(route: string): string | null {
  const m = /^\/system(?:\/([a-z]+))?$/.exec(route);
  if (!m) return null;
  const sub = m[1] ?? 'overview';
  return SYSTEM_SUBS.some((s) => s.key === sub) ? sub : null;
}

export function systemHref(sub: string): string {
  return sub === 'overview' ? '#/system' : `#/system/${sub}`;
}

export type Tone = 'ok' | 'warn' | 'err' | '';

/** Disk usage with the thresholds: warn from 75 %, error from 90 %. */
export function diskInfo(totalBytes: number, freeBytes: number): { used: number; pct: number; tone: Tone } {
  if (!(totalBytes > 0)) return { used: 0, pct: 0, tone: '' };
  const used = Math.max(0, totalBytes - freeBytes);
  const pct = Math.min(100, Math.round((used / totalBytes) * 100));
  return { used, pct, tone: pct >= 90 ? 'err' : pct >= 75 ? 'warn' : 'ok' };
}

/** A running state is trusted for this long; older ones are leftovers of a crashed helper. */
export function pollDelay(opts: { running: boolean; pending: boolean; awaiting: boolean; failed: boolean }): number {
  return opts.running || opts.pending || opts.awaiting ? 4000 : opts.failed ? 8000 : 30_000;
}

/** The new state of "waiting for the host to pick up my request" after a poll: done, still waiting or timed out. */
export function nextAwaiting(
  awaiting: { since: number; seenRunning: boolean } | null,
  status: { running: boolean; requestPending: boolean },
  now: number,
): { awaiting: { since: number; seenRunning: boolean } | null; timedOut: boolean } {
  if (!awaiting) return { awaiting: null, timedOut: false };
  if (status.running) return { awaiting: { ...awaiting, seenRunning: true }, timedOut: false };
  if (awaiting.seenRunning) return { awaiting: null, timedOut: false };
  if (!status.requestPending && now - awaiting.since > 120_000) return { awaiting: null, timedOut: true };
  return { awaiting, timedOut: false };
}
