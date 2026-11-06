/** Which parts of the statistics page are shown. Pure, so the rules can be tested. */
export type StatusClass = 's2' | 's3' | 's4' | 's5';
export type Section = 'requests' | 'resources' | 'traffic' | 'lists' | 'waf';

export interface StatsFilter {
  status: StatusClass[];
  sections: Section[];
}

export const STATUS_CLASSES: StatusClass[] = ['s2', 's3', 's4', 's5'];
export const SECTIONS: Section[] = ['requests', 'resources', 'traffic', 'lists', 'waf'];

export const DEFAULT_FILTER: StatsFilter = { status: [...STATUS_CLASSES], sections: [...SECTIONS] };

export type Preset = 'all' | 'errors' | 'server';

export const PRESETS: Record<Preset, StatsFilter> = {
  all: DEFAULT_FILTER,
  // only what went wrong: client and server errors, and the lists/firewall that explain them
  errors: { status: ['s4', 's5'], sections: ['requests', 'lists', 'waf'] },
  server: { status: ['s5'], sections: ['requests'] },
};

/** The preset a filter equals, or null for a custom selection. */
export function presetOf(f: StatsFilter): Preset | null {
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  for (const k of Object.keys(PRESETS) as Preset[]) {
    if (same(f.status, PRESETS[k].status) && same(f.sections, PRESETS[k].sections)) return k;
  }
  return null;
}

/** Adds or removes one entry, keeping the canonical order. The last status class cannot be switched off (an empty chart helps nobody). */
export function toggle<T extends string>(list: T[], all: T[], item: T, keepOne = false): T[] {
  const on = list.includes(item);
  if (on && keepOne && list.length === 1) return list;
  return all.filter((x) => (x === item ? !on : list.includes(x)));
}

/** Reads a stored filter and falls back to the default for anything unknown or broken. */
export function parseFilter(raw: string | null): StatsFilter {
  try {
    const v = JSON.parse(raw ?? '') as Partial<StatsFilter>;
    const status = STATUS_CLASSES.filter((s) => Array.isArray(v.status) && v.status.includes(s));
    const sections = SECTIONS.filter((s) => Array.isArray(v.sections) && v.sections.includes(s));
    return { status: status.length ? status : [...STATUS_CLASSES], sections };
  } catch {
    return { status: [...STATUS_CLASSES], sections: [...SECTIONS] };
  }
}
