import type { ComponentChildren } from 'preact';
import { splitPlaceholders, t } from './i18n.ts';

/**
 * A sentence with inline elements (code, bold, links): the whole sentence is translated at once and the elements are put in at their
 * placeholders, so a translation can use another word order. Usage: Rich with a text attribute that contains {cmd} and a with attribute that maps cmd to an element.
 */
export function Rich({ text, with: parts = {} }: { text: string; with?: Record<string, ComponentChildren> }) {
  return (
    <>
      {splitPlaceholders(t(text)).map((p, i) => (p.name !== undefined ? <span key={i} class="rich">{Object.prototype.hasOwnProperty.call(parts, p.name) ? parts[p.name] : `{${p.name}}`}</span> : p.text))}
    </>
  );
}
