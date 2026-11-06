import type { Role } from './types.ts';

export interface NavItem {
  label: string;
  icon: string;
  /** hash route */
  to: string;
  min: Role;
}

const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

const GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Hosting',
    items: [
      { label: 'Overview', icon: 'dashboard', to: '/', min: 'viewer' },
      { label: 'Tasks', icon: 'clipboard-list', to: '/jobs', min: 'viewer' },
      { label: 'Maintenance', icon: 'calendar', to: '/maintenance', min: 'operator' },
    ],
  },
  {
    label: 'Account',
    items: [
      { label: 'API-Tokens', icon: 'key', to: '/tokens', min: 'viewer' },
      { label: 'My account', icon: 'user', to: '/account', min: 'viewer' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Users', icon: 'users', to: '/users', min: 'admin' },
      { label: 'System', icon: 'cpu', to: '/system', min: 'admin' },
      { label: 'Audit log', icon: 'history', to: '/audit', min: 'admin' },
    ],
  },
];

/** An item is shown when the role reaches its minimum. */
export function navFor(role: Role): { label: string; items: NavItem[] }[] {
  return GROUPS.map((g) => ({ label: g.label, items: g.items.filter((i) => RANK[role] >= RANK[i.min]) })).filter((g) => g.items.length > 0);
}

/** Is the nav item the current page? "/jobs" also matches "/jobs/5", "/system" matches "/system/backup"; "/" only matches itself. */
export function isCurrent(itemTo: string, route: string): boolean {
  return itemTo === '/' ? route === '/' || route.startsWith('/sites/') : route === itemTo || route.startsWith(`${itemTo}/`);
}
