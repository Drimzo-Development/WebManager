import { fill } from './i18n.ts';
export class ApiError extends Error {
  readonly status: number;
  /** Field level messages of a 422 answer ({"fields": {"name": "..."}}), if the server sent any */
  readonly fields: Record<string, string>;
  // no parameter properties: the tests run these files with Node's type stripping, which does not support them
  constructor(status: number, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

let csrf = '';

export function setCsrf(token: string | null): void {
  csrf = token ?? '';
}

/** Requests in flight; the shell's thin top bar listens (it only appears for slow requests, so polling does not flicker). */
let pending = 0;
const watchers = new Set<(n: number) => void>();

export function watchPending(fn: (n: number) => void): () => void {
  watchers.add(fn);
  fn(pending);
  return () => void watchers.delete(fn);
}

function track(delta: number): void {
  pending += delta;
  watchers.forEach((w) => w(pending));
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  track(1);
  try {
    return await send<T>(method, path, body);
  } finally {
    track(-1);
  }
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  // FormData sets its own multipart Content-Type (with the boundary)
  const form = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body) });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON answer */
  }
  if (res.status === 401) {
    // the app shell shows the sign-in again; the sign-in endpoints never answer 401 for a wrong password
    dispatchEvent(new Event('wm:unauthorized'));
    throw new ApiError(401, 'Not signed in');
  }
  if (!res.ok) {
    const body = data as { error?: string; fields?: Record<string, string> } | null;
    throw new ApiError(res.status, (body?.error ?? fill('Error {status}', { status: res.status })), Object.fromEntries(Object.entries(body?.fields ?? {}).map(([k, v]) => [k, v])));
  }
  return data as T;
}

export const api = {
  get: <T,>(path: string) => call<T>('GET', path),
  post: <T,>(path: string, body?: unknown) => call<T>('POST', path, body ?? {}),
  put: <T,>(path: string, body?: unknown) => call<T>('PUT', path, body ?? {}),
  del: <T,>(path: string, body?: unknown) => call<T>('DELETE', path, body),
};
