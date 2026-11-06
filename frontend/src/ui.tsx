import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { watchPending } from './api.ts';
import { useToasts } from './runtime.ts';
import type { Tone } from './format.ts';
import { availableLanguages, chooseLanguage, fill, language } from './i18n.ts';

/** Icon from the shared sprite (public/assets/icons.svg). */
export function Icon({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <svg class={small ? 'i sm' : 'i'} aria-hidden="true">
      <use href={`/assets/icons.svg#${name}`} />
    </svg>
  );
}

/** Placeholder for content that is still loading: soft shimmering lines. */
export function Skeleton({ lines = 3, tall = false }: { lines?: number; tall?: boolean }) {
  return (
    <div class="skeleton" role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} class={`sk-line${tall && i === 0 ? ' tall' : ''}`} style={{ width: `${i === lines - 1 ? 55 : 100 - ((i * 13) % 30)}%` }} />
      ))}
    </div>
  );
}

/** A whole page while it loads: a heading line plus a few cards. */
export function PageSkeleton() {
  return (
    <main aria-busy="true">
      <span class="sk-line tall" style={{ width: '14rem', marginBottom: 'var(--sp-5)', display: 'block' }} />
      <div class="grid-2">
        <div class="card card-pad"><Skeleton lines={4} /></div>
        <div class="card card-pad"><Skeleton lines={4} /></div>
      </div>
    </main>
  );
}

/** Thin bar at the very top of the window; shown while a request takes longer than a moment. */
export function TopBar() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const off = watchPending((n) => {
      window.clearTimeout(timer);
      if (n === 0) setOn(false);
      else timer = window.setTimeout(() => setOn(true), 400);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, []);
  return <div class={`topbar${on ? ' on' : ''}`} role="progressbar" aria-hidden={!on} aria-label="Loading" />;
}

export function Pill({ tone = '', live = false, children }: { tone?: Tone; live?: boolean; children: ComponentChildren }) {
  return <span class={`pill ${tone}${live ? ' live' : ''}`}>{children}</span>;
}

/** Area sparkline for a series of numbers (null = gap is drawn as the previous value). Decorative: the value is printed next to it. */
export function Spark({ data }: { data: (number | null)[] }) {
  const vals = data.reduce<number[]>((a, v) => a.concat(v ?? a[a.length - 1] ?? 0), []);
  if (vals.length < 2) return <div class="spark-empty" />;
  const w = 200;
  const h = 40;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - 3 - ((v - min) / (max - min || 1)) * (h - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  return (
    <svg class="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${line}L${w} ${h}L0 ${h}Z`} fill="var(--spark)" fill-opacity=".16" />
      <path d={line} fill="none" stroke="var(--spark)" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
    </svg>
  );
}

/** Usage bar: turns amber above 80 %. With `good` a full bar is the healthy state (online, valid), so it turns amber below 50 % instead. */
export function Bar({ percent, label, good = false }: { percent: number; label: string; good?: boolean }) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <div class={`bar${(good ? p < 50 : p > 80) ? ' warn' : ''}`} role="img" aria-label={fill('{label}: {pct} percent', { label, pct: Math.round(p) })}>
      <i style={{ width: `${p}%` }} />
    </div>
  );
}

export function Toasts() {
  const list = useToasts();
  return (
    <div class="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} class={`toast${t.out ? ' out' : ''}${t.tone === 'err' ? ' err' : ''}`}>
          <Icon name={t.tone === 'err' ? 'alert' : 'check'} small />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div class="attn err" role="alert">
      <Icon name="alert" />
      <div>
        {message}
        {onRetry && (
          <>
            {' '}
            <button class="link" onClick={onRetry}>
              {'Try again'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Language choice (saved in this browser). Hidden while the server offers no language besides English. */
export function LanguageSelect() {
  const langs = availableLanguages();
  if (langs.length < 2) return null;
  return (
    <select class="input" style={{ width: 'auto' }} aria-label="Language" value={language()} onChange={(e) => chooseLanguage(e.currentTarget.value)}>
      {langs.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
    </select>
  );
}
