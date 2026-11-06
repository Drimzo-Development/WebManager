import { fill, decimal } from './i18n.ts';
export type Tone = 'ok' | 'warn' | 'err' | '';

const DAY = 86_400_000;

/** "512 B", "3,4 KB", "212 MB", "3,4 GB": binary units, decimal comma in German. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const comma = (n: number, digits: number) => decimal(n.toFixed(digits));
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? comma(kb, 1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? comma(mb, 1) : Math.round(mb)} MB`;
  return `${comma(mb / 1024, 1)} GB`;
}

/** The server sends UTC as "YYYY-MM-DD HH:MM:SS" or ISO; both are read as UTC. */
export function parseServerDate(s: string): number {
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
  return Date.parse(iso);
}

export function relativeTime(s: string, now = Date.now()): string {
  const at = parseServerDate(s);
  if (Number.isNaN(at)) return '';
  const sec = Math.round((now - at) / 1000);
  if (sec < 45) return 'just now';
  if (sec < 3600) return fill('{round} min ago', { round: Math.round(sec / 60) });
  if (sec < 86_400) return fill('{round} h ago', { round: Math.round(sec / 3600) });
  const d = Math.round(sec / 86_400);
  return d === 1 ? 'yesterday' : fill('{d} days ago', { d });
}

export function daysUntil(s: string | null, now = Date.now()): number | null {
  if (!s) return null;
  const t = parseServerDate(s);
  return Number.isNaN(t) ? null : Math.floor((t - now) / DAY);
}

const STATES: Record<string, [Tone, string]> = {
  running: ['ok', 'Running'],
  starting: ['warn', 'Starting'],
  unhealthy: ['err', 'Unstable'],
  crashed: ['err', 'Crashed'],
  stopped: ['', 'Stopped'],
  creating: ['warn', 'Being created'],
  deleting: ['warn', 'Being deleted'],
  missing: ['err', 'Container missing'],
  unknown: ['', 'Unknown'],
};

export function stateInfo(state: string): { tone: Tone; label: string } {
  const [tone, label] = STATES[state] ?? ['', state];
  return { tone, label };
}

/** Certificate pill: remaining days with a warning below 14 and an error below 3 or when issuing failed. */
export function certInfo(status: string, notAfter: string | null, now = Date.now()): { tone: Tone; label: string } {
  if (status === 'failed') return { tone: 'err', label: 'Error' };
  const days = daysUntil(notAfter, now);
  if (days === null) return { tone: '', label: status === 'none' ? 'No HTTPS' : 'Pending' };
  if (days < 0) return { tone: 'err', label: 'Expired' };
  if (days < 3) return { tone: 'err', label: fill('{days} days', { days }) };
  if (days < 14) return { tone: 'warn', label: fill('{days} days', { days }) };
  return { tone: 'ok', label: fill('{days} days', { days }) };
}

/** `httpDown`: the container runs, but the latest HTTP check failed. */
export function needsAttention(state: string, status: string, notAfter: string | null, now = Date.now(), httpDown = false): 'err' | 'warn' | null {
  if (['crashed', 'unhealthy', 'missing'].includes(state) || httpDown) return 'err';
  const c = certInfo(status, notAfter, now).tone;
  if (c === 'err') return 'err';
  return c === 'warn' ? 'warn' : null;
}
