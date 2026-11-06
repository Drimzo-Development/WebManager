import { useEffect, useRef, useState } from 'preact/hooks';

// ---------------------------------------------------------------- hash router: "#/tokens" -> "/tokens"
export function currentRoute(): string {
  const h = location.hash.replace(/^#/, '');
  return h === '' ? '/' : h.split('?')[0] ?? '/';
}

export function useRoute(): string {
  const [route, setRoute] = useState(currentRoute());
  useEffect(() => {
    const on = () => {
      setRoute(currentRoute());
      scrollTo(0, 0);
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

// ---------------------------------------------------------------- theme: key and values shared with assets/theme.js
export type Theme = 'light' | 'dark';

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setTheme(t: Theme): void {
  const root = document.documentElement;
  root.classList.add('theming');
  setTimeout(() => root.classList.remove('theming'), 400);
  root.dataset.theme = t;
  try {
    localStorage.setItem('wm.theme', t);
  } catch {
    /* private mode: the choice just does not persist */
  }
}

export function useTheme(): [Theme, () => void] {
  const [t, setT] = useState<Theme>(getTheme());
  return [
    t,
    () => {
      const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
      setTheme(next);
      setT(next);
    },
  ];
}

// ---------------------------------------------------------------- toasts
export interface ToastItem {
  id: number;
  text: string;
  tone: 'ok' | 'err';
  out: boolean;
}

let toasts: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<(t: ToastItem[]) => void>();
const emit = () => listeners.forEach((l) => l(toasts));

export function toast(text: string, tone: 'ok' | 'err' = 'ok'): void {
  const id = nextId++;
  toasts = [...toasts, { id, text, tone, out: false }];
  emit();
  setTimeout(() => {
    toasts = toasts.map((t) => (t.id === id ? { ...t, out: true } : t));
    emit();
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
      emit();
    }, 300);
  }, tone === 'err' ? 5000 : 2600);
}

export function useToasts(): ToastItem[] {
  const [list, setList] = useState(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => void listeners.delete(setList);
  }, []);
  return list;
}

// ---------------------------------------------------------------- async data with polling
export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Loads on mount and every `everyMs` while the tab is visible. Errors keep the last data on screen. */
export function useLoad<T>(fn: () => Promise<T>, everyMs = 0): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    let alive = true;
    const run = () =>
      latest.current().then(
        (data) => alive && setState({ data, error: null, loading: false }),
        (e: unknown) => alive && setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), loading: false })),
      );
    void run();
    const id = everyMs > 0 ? setInterval(() => !document.hidden && void run(), everyMs) : 0;
    return () => {
      alive = false;
      if (id) clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, everyMs]);
  return { ...state, reload: () => setTick((n) => n + 1) };
}
