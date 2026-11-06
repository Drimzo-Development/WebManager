import { Field, Toggle } from './forms.tsx';
import { fieldsFor } from './siteForm.ts';
import type { RuntimeDef } from './types.ts';

export interface SiteValues {
  runtime: string;
  internal_port: number;
  docroot: string;
  git_url: string;
  git_branch: string;
  git_username: string;
  git_token: string;
  install_command: string;
  build_command: string;
  start_command: string;
  memory_mb: number;
  cpus: number;
  pids: number;
  autostart: boolean;
}

interface Props {
  idp: string;
  type: string;
  values: SiteValues;
  set: (p: Partial<SiteValues>) => void;
  /** runtimes that fit the type */
  runtimes: RuntimeDef[];
  /** per-field messages of a 422 answer */
  errors: Record<string, string>;
  tokenSaved?: boolean;
}

const num = (v: string, fallback: number) => (v.trim() === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

/** The part of the site form that new website and settings have in common: runtime, application, limits. */
export function SiteFields({ idp, type, values: v, set, runtimes, errors, tokenSaved = false }: Props) {
  const show = fieldsFor(type);
  const rt = runtimes.find((r) => r.key === v.runtime);
  const err = (k: string) => (errors[k] ? <span class="err-text small" role="alert">{errors[k]}</span> : null);
  const text = (k: keyof SiteValues, label: string, opts: { hint?: string; placeholder?: string; mono?: boolean; wide?: boolean; password?: boolean } = {}) => (
    <div class={opts.wide ? 'span-2' : undefined}>
      <Field label={label} htmlFor={`${idp}-${k}`} hint={opts.hint}>
        <input id={`${idp}-${k}`} class={`input${opts.mono ? ' mono' : ''}`} type={opts.password ? 'password' : 'text'} autocomplete="off" spellcheck={false} placeholder={opts.placeholder} value={String(v[k] ?? '')} onInput={(e) => set({ [k]: e.currentTarget.value } as Partial<SiteValues>)} />
      </Field>
      {err(k)}
    </div>
  );
  const number = (k: 'internal_port' | 'memory_mb' | 'cpus' | 'pids', label: string, min: number, max: number, step = 1, hint?: string) => (
    <div>
      <Field label={label} htmlFor={`${idp}-${k}`} hint={hint}>
        <input id={`${idp}-${k}`} class="input" type="number" min={min} max={max} step={step} value={v[k]} onInput={(e) => set({ [k]: num(e.currentTarget.value, v[k]) } as Partial<SiteValues>)} />
      </Field>
      {err(k)}
    </div>
  );

  return (
    <>
      <div class="form-grid">
        <div>
          <Field label="Runtime template" htmlFor={`${idp}-runtime`} hint={rt?.image ? `Image: ${rt.image}` : undefined}>
            <select id={`${idp}-runtime`} class="input" value={v.runtime} onChange={(e) => set({ runtime: e.currentTarget.value })}>
              {runtimes.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </Field>
          {err('runtime')}
        </div>
        {show.port && number('internal_port', 'Internal port', 1024, 65535, 1, 'Several websites may use the same port; each one runs in its own network.')}
        {show.docroot && text('docroot', 'Document directory (optional)', { placeholder: 'e.g. public', hint: 'Relative path without “..”.' })}
      </div>

      {show.git && (
        <>
          <h3>Code from Git (optional)</h3>
          <div class="form-grid">
            {text('git_url', 'Repository (https)', { wide: true, placeholder: 'https://github.com/user/project.git', mono: true })}
            {text('git_branch', 'Branch', { placeholder: 'main' })}
            {text('git_username', 'Username', { hint: 'Anything works with GitHub.' })}
            {text('git_token', 'Access token (private repositories)', { password: true, placeholder: tokenSaved ? 'saved, leave empty to keep' : 'optional', hint: 'Stored encrypted and never shown.' })}
          </div>
        </>
      )}

      {(show.install || show.build || show.start) && (
        <>
          <h3>Commands</h3>
          <div class="form-grid">
            {show.install && text('install_command', 'Install command', { wide: true, mono: true })}
            {show.build && text('build_command', 'Build command', { wide: true, mono: true })}
            {show.start && text('start_command', 'Start command', { wide: true, mono: true, hint: 'Required for custom applications.' })}
          </div>
        </>
      )}

      <h3>Resource limits</h3>
      <div class="form-grid three">
        {number('memory_mb', 'Memory (MB)', 64, 16384)}
        {number('cpus', 'CPU cores', 0.1, 16, 0.1)}
        {number('pids', 'Maximum processes', 16, 4096)}
      </div>
      <Toggle id={`${idp}-autostart`} checked={v.autostart} onChange={(a) => set({ autostart: a })} label="Start automatically" hint="Also after a server restart." />
    </>
  );
}
