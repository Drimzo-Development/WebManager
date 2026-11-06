import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { waitForJob } from './jobs.ts';
import { IDLE, progressText, type ProgressView } from './progress.ts';
import { toast, type Loaded } from './runtime.ts';
import { ErrorNote, Icon, Skeleton } from './ui.tsx';
import { useProgress } from './useProgress.ts';

/** Label, control and an optional hint underneath. The control is passed in so each caller sets its own attributes. */
export function Field({ label, hint, htmlFor, children }: { label: string; hint?: ComponentChildren; htmlFor?: string; children: ComponentChildren }) {
  return (
    <div class="field">
      <label for={htmlFor}>{label}</label>
      {children}
      {hint && <span class="muted small">{hint}</span>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: ComponentChildren; id: string }) {
  return (
    <div class="field">
      <label class="switch" for={id}>
        <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
        <span class="track" aria-hidden="true" />
        <span class="strong">{label}</span>
      </label>
      {hint && <span class="muted small switch-hint">{hint}</span>}
    </div>
  );
}

export function Notice({ tone = 'warn', children }: { tone?: 'ok' | 'warn' | 'err'; children: ComponentChildren }) {
  return (
    <div class={`attn ${tone === 'err' ? 'err' : tone === 'ok' ? 'ok' : ''}`} role={tone === 'err' ? 'alert' : undefined}>
      <Icon name={tone === 'ok' ? 'check' : 'alert'} />
      <div>{children}</div>
    </div>
  );
}

/** A titled card; `actions` sit in its header. */
export function Panel({ title, actions, children }: { title: string; actions?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="card card-pad">
      <div class="card-head">
        <h2>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * Runs a save or action. If the answer carries a job id it waits for the job (the worker applies the change), so
 * "done" means done. Shows the error inline; `onDone` reloads whatever the change affected.
 */
export function useSaver(onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pg = useProgress();
  const run = async (fn: () => Promise<unknown>, okText = 'Saved'): Promise<boolean> => {
    setBusy(true);
    setError('');
    pg.begin();
    try {
      const r = (await fn()) as { job?: unknown } | null;
      if (r && typeof r.job === 'number') {
        pg.phase('queued');
        pg.alive();
        const done = await waitForJob(r.job, 180_000, 1200, (j) => {
          pg.alive();
          pg.phase(j.status === 'queued' ? 'queued' : 'running');
        });
        if (done === null) toast('The task is still running. You can follow it under “Operations → Tasks”.');
        else toast(okText);
      } else toast(okText);
      onDone?.();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      onDone?.();
      return false;
    } finally {
      pg.end();
      setBusy(false);
    }
  };
  return { busy, error, run, clear: () => setError(''), progress: pg.view };
}

/**
 * A button that shows the progress of what it started: "37 % · 12 s" with a fill running through it. The running seconds
 * prove the page is alive; without a `progress` of its own (a caller that tracks only `busy`) it times itself.
 */
export function ProgressButton({ busy, progress, label, icon, class: cls = 'btn', type = 'button', disabled, onClick, title }: {
  busy: boolean;
  progress?: ProgressView;
  label: ComponentChildren;
  icon?: string;
  class?: string;
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  title?: string;
}) {
  const own = useSelfProgress(busy && !progress?.active);
  const v = progress?.active ? progress : own;
  const stalled = busy && v.stalled;
  return (
    <button
      class={`${cls} pb${busy ? ' busy' : ''}${stalled ? ' stalled' : ''}`}
      type={type}
      disabled={busy || disabled}
      onClick={onClick}
      title={stalled ? 'No answer from the server for more than 45 seconds. The task may still be running: Operations → Tasks.' : title}
      aria-busy={busy || undefined}
    >
      {busy && <span class="pb-fill" style={{ width: `${v.percent}%` }} aria-hidden="true" />}
      <span class="pb-label" aria-hidden={busy || undefined}>{icon && <Icon name={icon} />}{label}</span>
      {busy && (
        <>
          <span class="pb-sizer" aria-hidden="true"><Icon name="refresh" />100 % · 99 s</span>
          <span class="pb-text" role="status">
            <Icon name={stalled ? 'alert' : 'refresh'} />
            {progressText(v)}
          </span>
        </>
      )}
    </button>
  );
}

/** Timing for a button whose caller only knows "busy". Ticks only while busy. */
function useSelfProgress(on: boolean): ProgressView {
  const [view, setView] = useState<ProgressView>(IDLE);
  useEffect(() => {
    if (!on) {
      setView(IDLE);
      return;
    }
    const t0 = Date.now();
    let max = 0;
    const tick = () => {
      const ms = Date.now() - t0;
      max = Math.max(max, 90 * (1 - Math.exp(-ms / 6000)));
      setView({ active: true, percent: max, elapsedMs: ms, stalled: false, phase: 'running' });
    };
    tick();
    const t = window.setInterval(tick, 200);
    return () => window.clearInterval(t);
  }, [on]);
  return view;
}

/** Editable copy of loaded data. It is reset whenever fresh data arrives (after saving or reloading). */
export function useDraft<T>(load: Loaded<T>): [T | null, (patch: Partial<T> | ((d: T) => Partial<T>)) => void] {
  const [draft, setDraft] = useState<T | null>(null);
  useEffect(() => {
    if (load.data) setDraft(load.data);
  }, [load.data]);
  // a function patch sees the latest draft, so two changes in one tick do not overwrite each other
  return [draft, (patch) => setDraft((d) => (d ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch) } : d))];
}

/** Common shell of a section: loading and error states, then the form. */
export function Loading<T>({ load, children }: { load: Loaded<T>; children: (data: T) => ComponentChildren }) {
  if (load.error && !load.data) return <ErrorNote message={load.error} onRetry={load.reload} />;
  if (!load.data) return <Skeleton lines={4} />;
  return <>{children(load.data)}</>;
}

export function SaveBar({ busy, error, label = 'Save', disabled, progress, children }: { busy: boolean; error: string; label?: string; disabled?: boolean; progress?: ProgressView; children?: ComponentChildren }) {
  return (
    <>
      {error && <ErrorNote message={error} />}
      <div class="row">
        <ProgressButton class="btn primary" type="submit" busy={busy} progress={progress} disabled={disabled} label={label} />
        {children}
      </div>
    </>
  );
}
