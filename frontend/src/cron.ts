/** Ready-made schedules for the cron form ("minute hour day month weekday", server time). */
export const CRON_PRESETS: readonly [string, string][] = [
  ['*/5 * * * *', 'Every 5 minutes'],
  ['*/15 * * * *', 'Every 15 minutes'],
  ['0 * * * *', 'Hourly'],
  ['0 3 * * *', 'Daily at 03:00'],
  ['30 2 * * 1', 'Weekly, Monday 02:30'],
  ['0 4 1 * *', 'Monthly on the 1st, 04:00'],
  ['* * * * *', 'Every minute'],
];

const ALIASES: Record<string, string> = {
  '@hourly': 'Hourly',
  '@daily': 'Daily at 00:00',
  '@midnight': 'Daily at 00:00',
  '@weekly': 'Weekly, Sunday 00:00',
  '@monthly': 'Monthly on the 1st, 00:00',
};

/** Plain-language name of a schedule, or '' when it is a custom expression. */
export function cronLabel(expr: string): string {
  const e = expr.trim();
  return CRON_PRESETS.find((p) => p[0] === e)?.[1] ?? ALIASES[e.toLowerCase()] ?? '';
}
