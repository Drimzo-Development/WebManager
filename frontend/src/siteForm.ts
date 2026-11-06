import type { RuntimeDef, SiteDetail } from './types.ts';

export type SiteInfo = SiteDetail['site'];

/** Types that run an application behind the proxy (as opposed to files served by nginx/PHP). */
export const NODE_LIKE = ['node', 'express', 'next', 'custom'];

export const TYPE_LABEL: Record<string, string> = {
  static: 'Static HTML website',
  php: 'PHP website (PHP-FPM + Nginx)',
  laravel: 'Laravel application',
  node: 'Node.js application',
  express: 'Express.js application',
  next: 'Next.js application',
  custom: 'Custom (approved template)',
};

/** Defaults per type: [install, build, start], the same as SiteService::defaults() on the server. */
export const COMMAND_DEFAULTS: Record<string, [string, string, string]> = {
  node: ['npm install', '', 'npm start'],
  express: ['npm install', '', 'npm start'],
  next: ['npm install', 'npm run build', 'npm start'],
  laravel: ['composer install --no-dev --optimize-autoloader --no-interaction', 'if [ -f package.json ]; then npm ci && npm run build; fi', ''],
  static: ['', '', ''],
  php: ['', '', ''],
  custom: ['', '', ''],
};

/** Which fields a type shows (new website and settings share this). */
export function fieldsFor(type: string) {
  const nodeLike = NODE_LIKE.includes(type);
  const laravel = type === 'laravel';
  return {
    port: nodeLike,
    docroot: !nodeLike,
    git: nodeLike || laravel,
    install: nodeLike || laravel,
    build: nodeLike || laravel,
    start: nodeLike,
  };
}

/**
 * Body for PUT /api/sites/{id}: the server validates and stores the complete configuration, so every field is sent,
 * with `patch` on top. An empty git token keeps the stored one (the server only replaces it when one is sent).
 */
export function siteBody(site: SiteInfo, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: site.name,
    description: site.description,
    type: site.type,
    runtime: site.runtime,
    internal_port: site.internal_port,
    docroot: site.docroot,
    memory_mb: site.memory_mb,
    cpus: site.cpus,
    pids: site.pids,
    start_command: site.start_command,
    install_command: site.install_command,
    build_command: site.build_command,
    git_url: site.git_url,
    git_branch: site.git_branch,
    git_username: site.git_username,
    autostart: site.autostart,
    ...patch,
  };
}

/** One readable line out of the server's per-field messages. */
export function fieldSummary(fields: Record<string, string>): string {
  return Object.values(fields).join(' ');
}

/** Archive name for the temporary upload before extraction: hidden file, safe characters, original extension kept. */
export function archiveName(original: string, now = Date.now()): string | null {
  const ext = /\.zip$/i.test(original) ? '.zip' : /\.(tar\.gz|tgz)$/i.test(original) ? '.tar.gz' : null;
  return ext === null ? null : `.wm-upload-${now}${ext}`;
}

/**
 * The runtimes a form may offer for a type: those that fit, without the ones only an application template uses – except the one
 * the website already has (a website made from a template keeps showing its own runtime).
 */
export function selectableRuntimes(runtimes: readonly RuntimeDef[], type: string, current = ''): RuntimeDef[] {
  return runtimes.filter((r) => r.types.includes(type) && (!r.templateOnly || r.key === current));
}

/** The preselected runtime for a type: the last (newest) approved one that fits, e.g. PHP 8.5 rather than 8.3. */
export function defaultRuntime(runtimes: readonly RuntimeDef[], type: string): string {
  const fitting = selectableRuntimes(runtimes, type);
  return fitting[fitting.length - 1]?.key ?? '';
}

/** The errors of a form without the fields the user just edited. */
export function withoutErrors(errors: Record<string, string>, edited: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).filter(([k]) => !edited.includes(k)));
}
