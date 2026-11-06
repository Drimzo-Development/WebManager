export type Role = 'viewer' | 'operator' | 'admin';

export interface Me {
  user: { id: number; email: string; name: string; role: Role };
  auth: 'session' | 'token';
  csrf: string | null;
  two_factor_missing: boolean;
  brand: { name: string; product: string; logo: string };
  version: string;
}

export interface SiteStats {
  cpuPercent: number;
  memBytes: number;
  memLimitBytes: number;
  memPercent: number;
}

export interface SiteSummary {
  id: number;
  name: string;
  type: string;
  runtime: string;
  domains: string[];
  state: string;
  tls: boolean;
  cert_status: string;
  cert_not_after: string | null;
  busy: boolean;
  stats: SiteStats | null;
  /** HTTP checks: share of successful checks (24 h) and the latest result of the last 10 minutes */
  uptime?: { pct24: number | null; last: { ok: boolean; status: number | null; ms: number | null; error: string | null; at: string } | null };
}

export interface Job {
  id: number;
  type: string;
  site_id: number | null;
  title: string;
  status: string;
  exit_code?: number | null;
  error?: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at: string | null;
}

export interface MaintenanceWindow {
  id: number;
  site_id: number | null;
  site_name: string | null;
  title: string;
  starts_at: string;
  ends_at: string;
  repeat: 'none' | 'daily' | 'weekly';
  active: boolean;
  current_end: string | null;
  next_start: string | null;
}

export interface ApiTokenItem {
  id: number;
  name: string;
  prefix: string;
  role: 'viewer' | 'operator' | 'admin';
  ip_allow: string;
  created_at: string;
  expires_at: string;
  expired: boolean;
  last_used_at: string | null;
  last_used_ip: string | null;
}

export interface AuthState {
  authenticated: boolean;
  csrf: string;
  pending_2fa: { totp: boolean; passkey: boolean } | null;
  passkeys_possible: boolean;
  brand: { name: string; product: string; logo: string };
}

export interface AgentStatus {
  exists: boolean;
  state: string;
  running?: boolean;
  health?: string | null;
  exitCode?: number;
  oomKilled?: boolean;
  startedAt?: string;
  restartCount?: number;
  image?: string;
  tls?: boolean;
}

export interface SiteDetail {
  site: {
    id: number;
    slug: string;
    name: string;
    description: string;
    type: string;
    runtime: string;
    docroot: string;
    memory_mb: number;
    cpus: number;
    pids: number;
    internal_port: number;
    start_command: string;
    install_command: string;
    build_command: string;
    git_url: string;
    git_branch: string;
    git_username: string;
    has_git_token: boolean;
    autostart: boolean;
    gate_enabled: boolean;
    maintenance_enabled: boolean;
    lifecycle: string;
  };
  domains: string[];
  status: AgentStatus | null;
  state: string;
  agent_error: string | null;
  cert: { status: string; not_after: string | null } | null;
  busy: boolean;
  runtimes: RuntimeDef[];
}

export interface RuntimeDef {
  key: string;
  label: string;
  types: string[];
  fixedPort: number | null;
  npm: boolean;
  image?: string;
  /** only an application template uses it (for example Uptime Kuma): offered nowhere else */
  templateOnly?: boolean;
}

export interface SiteLive {
  status: AgentStatus | null;
  stats: SiteStats | null;
  state: string;
}

export interface MetricPoint {
  t: number;
  req: number;
  cpu: number | null;
  mem: number | null;
  memLimit: number | null;
}

export interface MetricsAnswer {
  range: string;
  points: MetricPoint[];
  totals: { req: number; s2: number; s3: number; s4: number; s5: number; bytes: number; waf: number };
  topPages: { path: string; count: number }[];
}

/** Application template for “New website → Start from” (templates/apps.json). */
export interface AppTemplate {
  key: string;
  label: string;
  description: string;
  type: string;
  database: string | null;
  memory_mb: number;
  after: string;
}

export interface DnsState {
  configured: boolean;
  provider: 'cloudflare' | 'hetzner' | null;
  providers: Record<string, string>;
  wait: number;
}
