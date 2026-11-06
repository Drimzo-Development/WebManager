import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SOURCE, decimal, fill, language, locale, pickLanguage, splitPlaceholders, t, useLanguage } from './i18n.ts';
import { translateProps } from './i18nHook.ts';

const DE = { code: 'de', name: 'Deutsch', locale: 'de-DE' };
const FR = { code: 'fr', name: 'Français', locale: 'fr-FR' };

test('English is the source: nothing changes, fill still works', () => {
  useLanguage(SOURCE, {});
  assert.equal(t('Save'), 'Save');
  assert.equal(fill('{n} websites online', { n: 3 }), '3 websites online');
  assert.equal(fill('{a} and {b}', { a: 'x' }), 'x and {b}', 'an unknown placeholder stays visible');
  assert.equal(locale(), 'en-GB');
  assert.equal(language(), 'en');
});

test('translation: exact text, spaces around it are kept, unknown text stays English', () => {
  useLanguage(DE, { Save: 'Speichern', 'Delete {name}': '{name} löschen', 'Two words': 'Zwei Wörter' });
  assert.equal(t('Save'), 'Speichern');
  assert.equal(t(' Save '), ' Speichern ');
  assert.equal(t('Two\n   words'), 'Zwei Wörter', 'line breaks in the source do not matter');
  assert.equal(t('Cancel'), 'Cancel');
  assert.equal(t(''), '');
  assert.equal(locale(), 'de-DE');
  useLanguage(SOURCE, {});
});

test('fill translates the template first and then fills in the values', () => {
  useLanguage(DE, { 'Delete {name}': '{name} löschen' });
  assert.equal(fill('Delete {name}', { name: 'blog' }), 'blog löschen');
  assert.equal(fill('Delete {name}', { name: '{x}' }), '{x} löschen');
  useLanguage(SOURCE, {});
});

test('empty translations and non-text values are ignored', () => {
  useLanguage(DE, { Save: '', Cancel: '  ', Edit: 5 as unknown as string });
  assert.equal(t('Save'), 'Save');
  assert.equal(t('Cancel'), 'Cancel');
  assert.equal(t('Edit'), 'Edit');
  useLanguage(SOURCE, {});
});

test('decimal: only languages with a decimal comma change the separator', () => {
  assert.equal(decimal('1.5'), '1.5');
  useLanguage(DE, {});
  assert.equal(decimal('1.5'), '1,5');
  useLanguage(SOURCE, {});
});

test('pickLanguage: English unless a language was chosen; the browser language does not matter', () => {
  const offered = [DE, FR];
  assert.equal(pickLanguage(null, offered).code, 'en', 'nothing chosen yet');
  assert.equal(pickLanguage('', offered).code, 'en');
  assert.equal(pickLanguage('fr', offered).code, 'fr');
  assert.equal(pickLanguage('FR', offered).code, 'fr', 'the code is compared without regard to case');
  assert.equal(pickLanguage('en', offered).code, 'en', 'English can be chosen on purpose');
  assert.equal(pickLanguage('xx', offered).code, 'en', 'a saved language that no longer exists');
  assert.equal(pickLanguage('de', []).code, 'en', 'the server offers none');
});

test('translateProps: elements, attributes and components; code and user input stay as they are', () => {
  const tr = (s: string) => `[${s}]`;
  const el = (type: string, props: Record<string, unknown>) => { translateProps(type, props, tr); return props; };
  assert.deepEqual(el('button', { children: 'Save', title: 'Save it' }), { children: '[Save]', title: '[Save it]' });
  assert.deepEqual(el('p', { children: ['Hello', { not: 'text' }, ' of '] }), { children: ['[Hello]', { not: 'text' }, '[ of ]'] });
  assert.deepEqual(el('input', { placeholder: 'Name', value: 'Name' }), { placeholder: '[Name]', value: 'Name' });
  assert.deepEqual(el('code', { children: 'npm ci' }), { children: 'npm ci' });
  assert.deepEqual(el('pre', { children: 'ls -l' }), { children: 'ls -l' });
  assert.deepEqual(el('textarea', { children: 'x' }), { children: 'x' });
  const comp: Record<string, unknown> = { label: 'Name', hint: 'Help', value: 'Name', class: 'x' };
  translateProps(() => null, comp, tr);
  assert.deepEqual(comp, { label: '[Name]', hint: '[Help]', value: 'Name', class: 'x' });
  // user data is never translated, even when it equals a text of the interface
  assert.deepEqual(el('span', { translate: false, children: 'Logs', title: 'Logs' }), { translate: false, children: 'Logs', title: 'Logs' });
  assert.deepEqual(el('span', { translate: 'no', children: 'Logs' }), { translate: 'no', children: 'Logs' });
  assert.deepEqual(el('span', { translate: true, children: 'Logs' }), { translate: true, children: '[Logs]' });
  const keep: Record<string, unknown> = { label: 'Name', translate: false };
  translateProps(() => null, keep, tr);
  assert.deepEqual(keep, { label: 'Name', translate: false });
  const none = { children: 5 };
  translateProps('span', none, tr);
  assert.deepEqual(none, { children: 5 });
});

test('the language files in lang/ are well formed and keep the placeholders of the English text', () => {
  const dir = join(import.meta.dirname, '..', '..', 'lang');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.includes('de.json'));
  for (const f of files) {
    const code = f.replace(/\.json$/, '');
    assert.match(code, /^[a-z]{2,3}(-[A-Z]{2})?$/, f);
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { _meta: { name: string; locale: string }; strings: Record<string, string> };
    assert.ok(j._meta.name && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(j._meta.locale), `${f} meta`);
    const ph = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(',');
    for (const [k, v] of Object.entries(j.strings)) {
      assert.equal(typeof v, 'string', `${f}: ${k}`);
      if (v !== '') assert.equal(ph(v), ph(k), `${f}: placeholders of “${k}”`);
    }
  }
});

test('splitPlaceholders: text and placeholders in order, any word order', () => {
  assert.deepEqual(splitPlaceholders('Run {cmd} once.'), [{ text: 'Run ' }, { name: 'cmd' }, { text: ' once.' }]);
  assert.deepEqual(splitPlaceholders('{a}{b}'), [{ name: 'a' }, { name: 'b' }]);
  assert.deepEqual(splitPlaceholders('{cmd} führst du einmal aus.'), [{ name: 'cmd' }, { text: ' führst du einmal aus.' }]);
  assert.deepEqual(splitPlaceholders('no placeholder'), [{ text: 'no placeholder' }]);
  assert.deepEqual(splitPlaceholders(''), []);
  assert.deepEqual(splitPlaceholders('{ not a name } {ok}'), [{ text: '{ not a name } ' }, { name: 'ok' }]);
});

test('every Rich sentence of the interface has the same placeholders in German', () => {
  const dir = join(import.meta.dirname, '..', '..', 'lang');
  const de = (JSON.parse(readFileSync(join(dir, 'de.json'), 'utf8')) as { strings: Record<string, string> }).strings;
  const names = (s: string) => splitPlaceholders(s).flatMap((p) => (p.name ? [p.name] : [])).sort().join(',');
  let checked = 0;
  for (const [k, v] of Object.entries(de)) {
    if (!v || !k.includes('{')) continue;
    assert.equal(names(v), names(k), k);
    checked++;
  }
  assert.ok(checked > 40, 'sentences with placeholders were found');
});
