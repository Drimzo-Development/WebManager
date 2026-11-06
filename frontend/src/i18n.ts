/**
 * Translation. The English texts in the source are the keys: a language file (lang/<code>.json on the server) maps them to the
 * translation, a text without an entry stays English. Literal texts in the interface are translated when they are rendered
 * (see i18nHook.ts), `fill()` translates its template before it fills in the values. Add a language: see the manual, "Languages".
 */

export type Vars = Record<string, string | number | null | undefined>;

export interface Language {
  code: string;
  name: string;
  locale: string;
}

export const SOURCE: Language = { code: 'en', name: 'English', locale: 'en-GB' };
export const STORAGE_KEY = 'wm_lang';

let dict: Record<string, string> = {};
let current: Language = SOURCE;
let available: Language[] = [SOURCE];

const norm = (s: string): string => s.replace(/\s+/g, ' ');

/** Translation of a text; leading and trailing spaces are kept, unknown texts come back unchanged. */
export function t(text: string): string {
  if (current.code === SOURCE.code || text === '') return text;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!m || !m[2]) return text;
  const hit = dict[norm(m[2])];
  return hit ? `${m[1]}${hit}${m[3]}` : text;
}

/** Replaces `{name}` placeholders in the (translated) text: fill('{n} websites online', { n: 3 }) -> "3 websites online" */
export function fill(text: string, vars?: Vars): string {
  const s = t(text);
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? '') : m));
}

/** Splits a (translated) sentence at its `{name}` placeholders: ['Run ', 'cmd', ' once.'] -> text, name, text. Pure, so it can be tested. */
export function splitPlaceholders(text: string): { text?: string; name?: string }[] {
  const out: { text?: string; name?: string }[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ name: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** BCP 47 tag for dates and numbers */
export const locale = (): string => current.locale;

/** Code of the language in use ("en" = the English source texts). */
export const language = (): string => current.code;

/** Decimal separator: the numbers of the interface are formatted with the locale, this only fixes up texts typed by hand. */
export const decimal = (v: string): string => (current.locale.startsWith('en') ? v : v.replace('.', ','));

/** Activates a language (an empty or unknown dictionary leaves everything English). */
export function useLanguage(lang: Language, strings: Record<string, string>): void {
  current = lang;
  dict = {};
  for (const [k, v] of Object.entries(strings)) if (typeof v === 'string' && v.trim() !== '') dict[norm(k.trim())] = v;
}

/** The language to start with: the choice saved in this browser if the server still offers it, otherwise English (the browser language is not used). */
export function pickLanguage(saved: string | null, offered: readonly Language[]): Language {
  if (!saved || saved === SOURCE.code) return SOURCE;
  return offered.find((l) => l.code.toLowerCase() === saved.toLowerCase()) ?? SOURCE;
}

// ---------------------------------------------------------------- browser side

export async function offeredLanguages(): Promise<Language[]> {
  try {
    const r = await fetch('/api/lang', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (!r.ok) return [];
    const j = (await r.json()) as { languages?: Language[] };
    return Array.isArray(j.languages) ? j.languages : [];
  } catch {
    return [];
  }
}

/** Loads the language of the user before the first render; never throws (on any problem the interface stays English). */
export async function initLanguage(): Promise<Language[]> {
  const offered = await offeredLanguages();
  let saved: string | null = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* storage blocked */ }
  const lang = pickLanguage(saved, offered);
  if (lang.code !== SOURCE.code) {
    try {
      const r = await fetch(`/api/lang/${encodeURIComponent(lang.code)}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (r.ok) useLanguage(lang, ((await r.json()) as { strings?: Record<string, string> }).strings ?? {});
    } catch { /* English */ }
  }
  document.documentElement.lang = current.locale.split('-')[0] ?? 'en';
  available = [SOURCE, ...offered];
  return available;
}

/** English plus the languages the server offers (after initLanguage). */
export const availableLanguages = (): readonly Language[] => available;

/** Saves the choice and reloads, so that every text is rendered in the new language. */
export function chooseLanguage(code: string): void {
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* storage blocked: the choice is lost on reload */ }
  location.reload();
}
