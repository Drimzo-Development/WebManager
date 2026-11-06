import type { Role } from './types.ts';

export interface SubDef {
  key: string;
  label: string;
}

export interface TabDef {
  key: string;
  label: string;
  icon: string;
  subs: readonly SubDef[];
}

export const TABS: readonly TabDef[] = [
  { key: 'overview', label: 'Overview', icon: 'dashboard', subs: [] },
  { key: 'content', label: 'Content', icon: 'folder', subs: [{ key: 'files', label: 'Files' }, { key: 'database', label: 'Database' }] },
  { key: 'deploy', label: 'Deploy', icon: 'zap', subs: [{ key: 'commands', label: 'Commands & code' }, { key: 'env', label: 'Environment' }, { key: 'cron', label: 'Cron jobs' }] },
  { key: 'domains', label: 'Domains & HTTPS', icon: 'globe', subs: [{ key: 'domains', label: 'Domains & HTTPS' }, { key: 'webserver', label: 'Web server' }] },
  {
    key: 'protection',
    label: 'Protection',
    icon: 'shield',
    subs: [{ key: 'maintenance', label: 'Maintenance mode' }, { key: 'gate', label: 'Password protection' }, { key: 'rules', label: 'Access rules' }, { key: 'security', label: 'Security & WAF' }],
  },
  {
    key: 'ops',
    label: 'Operations',
    icon: 'activity',
    subs: [{ key: 'logs', label: 'Logs' }, { key: 'jobs', label: 'Tasks' }, { key: 'stats', label: 'Statistics' }, { key: 'report', label: 'Weekly report' }],
  },
  { key: 'console', label: 'Console', icon: 'terminal', subs: [{ key: 'console', label: 'Console' }] },
  { key: 'settings', label: 'Settings', icon: 'cpu', subs: [{ key: 'settings', label: 'Settings' }] },
];

export type TabKey = (typeof TABS)[number]['key'];

export interface SiteRoute {
  id: number;
  tab: TabKey;
  /** null = the first section the caller may see */
  sub: string | null;
}

/** "/sites/12", "/sites/12/content", "/sites/12/content/database". Unknown tab or section, id 0 or trailing junk is not a site route. */
export function parseSiteRoute(route: string): SiteRoute | null {
  const m = /^\/sites\/([1-9]\d{0,5})(?:\/([a-z]+)(?:\/([a-z]+))?)?$/.exec(route);
  if (!m) return null;
  const tab = TABS.find((t) => t.key === (m[2] ?? 'overview'));
  if (!tab) return null;
  const sub = m[3] ?? null;
  if (sub !== null && !tab.subs.some((s) => s.key === sub)) return null;
  return { id: Number(m[1]), tab: tab.key, sub };
}

export function siteHref(id: number, tab: TabKey = 'overview', sub?: string): string {
  return tab === 'overview' ? `#/sites/${id}` : `#/sites/${id}/${tab}${sub ? `/${sub}` : ''}`;
}

// ---------------------------------------------------------------- who sees what (the server decides again on every request)
export interface Caller {
  role: Role;
}

export function canSee(c: Caller, section: string): boolean {
  if (section === 'jobs') return true;
  if (section === 'console') return c.role === 'admin'; // an interactive shell in the container: administrators only
  return c.role === 'operator' || c.role === 'admin';
}

/** Sections of a tab the caller may open, in display order. */
export function visibleSubs(tab: TabDef, c: Caller): SubDef[] {
  return tab.subs.filter((s) => canSee(c, s.key));
}

/** Tabs the caller sees: the overview always, others when at least one of their sections is visible. */
export function visibleTabs(c: Caller): TabDef[] {
  return TABS.filter((t) => t.key === 'overview' || visibleSubs(t, c).length > 0);
}
