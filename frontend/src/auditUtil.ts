export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target: string;
  ip: string;
  details: string;
  created_at: string;
}

/** "key: value, key: value" out of the stored JSON, without ever failing on odd content. */
export function formatDetails(raw: string): string {
  try {
    const d = JSON.parse(raw) as unknown;
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      return Object.entries(d as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join(', ');
    }
  } catch {
    /* not JSON: show as stored */
  }
  return raw === '{}' ? '' : raw;
}
