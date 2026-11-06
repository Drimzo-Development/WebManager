import { fill } from './i18n.ts';
/** Textareas that hold lists (domains, IP addresses, paths): one entry per line, commas and spaces work as well. */
export function parseList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function formatList(items: readonly string[]): string {
  return items.join('\n');
}

/** Same list without changes? (order matters for display, not for meaning, so compare sorted) */
export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

/** "a/b/c.txt" -> ["a", "a/b", "a/b/c.txt"] for breadcrumbs. */
export function pathTrail(path: string): { name: string; path: string }[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
}

export function joinPath(dir: string, name: string): string {
  return [dir, name].filter(Boolean).join('/');
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** A file or folder name the server will accept: not empty, no slash, not "." or "..", no control characters. */
export function validName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\\u0000-\u001f]/.test(name) && name.length <= 255;
}

/** A folder path inside the project (relative; empty = the project root): no "..", no control characters, at most 2048 characters. */
export function validFolder(path: string): boolean {
  return path.length <= 2048 && !/[\u0000-\u001f]/.test(path) && !path.split('/').includes('..');
}

/** Range of rows between two clicks (shift-click), both ends included, in either order. */
export function rangeBetween<T>(items: readonly T[], a: number, b: number): T[] {
  if (a < 0 || b < 0 || a >= items.length || b >= items.length) return [];
  return items.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** ".env" style text -> object. Blank lines and "#" comments are ignored; the value is everything after the first "=" (not trimmed). */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq < 1) throw new Error(fill('Line {v}: expected NAME=value', { v: i + 1 }));
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  });
  return env;
}

export function formatEnv(env: Record<string, string> | null | undefined): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}
