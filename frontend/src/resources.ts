export interface ResourcesAnswer {
  limits: { memory_mb: number; cpus: number; pids: number };
  usage: { cpuPercent: number; memBytes: number; memLimitBytes: number; memPercent: number; pids: number } | null;
  restarts: number | null;
  oom: boolean;
  disk: { day: string; bytes: number }[];
}

/** CPU use as a share of the website's own CPU limit (docker reports percent of one core): 100 = the limit is reached. */
export function cpuOfLimit(cpuPercent: number, cpus: number): number {
  if (!Number.isFinite(cpuPercent) || !(cpus > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((cpuPercent / (cpus * 100)) * 100)));
}

/** Latest disk value and the change against the value about `days` days earlier (null when there is no older value). */
export function diskTrend(disk: readonly { day: string; bytes: number }[], days = 7): { latest: number; delta: number | null } | null {
  const last = disk[disk.length - 1];
  if (!last) return null;
  const at = Date.parse(`${last.day}T00:00:00Z`);
  let ref: { day: string; bytes: number } | null = null;
  for (const d of disk) if (at - Date.parse(`${d.day}T00:00:00Z`) >= days * 86_400_000) ref = d;
  return { latest: last.bytes, delta: ref ? last.bytes - ref.bytes : null };
}

/** "+1.2 GB" / "−300 MB" / "±0" for the change of the disk space. */
export function signedBytes(delta: number, format: (n: number) => string): string {
  if (delta === 0) return '±0';
  return `${delta > 0 ? '+' : '−'}${format(Math.abs(delta))}`;
}
