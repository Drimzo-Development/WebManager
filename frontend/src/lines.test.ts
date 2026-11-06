import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatEnv, formatList, joinPath, parentPath, parseEnv, parseList, pathTrail, rangeBetween, sameList, validFolder, validName } from './lines.ts';

test('parseList: lines, commas, spaces, empty entries', () => {
  assert.deepEqual(parseList('a.de\nb.de'), ['a.de', 'b.de']);
  assert.deepEqual(parseList('a.de, b.de  c.de\r\n\n'), ['a.de', 'b.de', 'c.de']);
  assert.deepEqual(parseList('   '), []);
  assert.equal(formatList(['a', 'b']), 'a\nb');
});

test('sameList ignores the order', () => {
  assert.ok(sameList(['a', 'b'], ['b', 'a']));
  assert.ok(!sameList(['a'], ['a', 'b']));
  assert.ok(!sameList(['a', 'b'], ['a', 'c']));
});

test('path helpers', () => {
  assert.deepEqual(pathTrail('a/b/c.txt'), [{ name: 'a', path: 'a' }, { name: 'b', path: 'a/b' }, { name: 'c.txt', path: 'a/b/c.txt' }]);
  assert.deepEqual(pathTrail(''), []);
  assert.equal(joinPath('', 'x'), 'x');
  assert.equal(joinPath('a/b', 'x'), 'a/b/x');
  assert.equal(parentPath('a/b/x'), 'a/b');
  assert.equal(parentPath('x'), '');
});

test('validName', () => {
  for (const ok of ['index.php', '.htaccess', 'a b', 'ä.txt']) assert.ok(validName(ok), ok);
  for (const bad of ['', '.', '..', 'a/b', 'a\b', 'a\nb', '\u0000x', 'x'.repeat(256)]) assert.ok(!validName(bad), JSON.stringify(bad));
});

test('parseEnv: comments, empty lines, equals signs in the value, spaces stay in the value', () => {
  assert.deepEqual(parseEnv('A=1\n# comment\n\n  # indented\nB=x=y\nC= with spaces \r\nD='), { A: '1', B: 'x=y', C: ' with spaces ', D: '' });
  assert.deepEqual(parseEnv(''), {});
});

test('parseEnv: error names the line', () => {
  assert.throws(() => parseEnv('A=1\nkaputt'), /Line 2: expected NAME=value/);
  assert.throws(() => parseEnv('=without name'), /Line 1/);
});

test('formatEnv and parseEnv match each other', () => {
  const env = { NODE_ENV: 'production', URL: 'https://x.example/?a=b' };
  assert.deepEqual(parseEnv(formatEnv(env)), env);
  assert.equal(formatEnv(null), '');
  assert.equal(formatEnv({}), '');
});

test('validFolder: relative project paths, the root is allowed', () => {
  for (const ok of ['', 'public', 'public/img', 'a b/c', '.config']) assert.ok(validFolder(ok), ok);
  for (const bad of ['..', 'a/../b', '../x', 'a/..', 'a\nb', 'x'.repeat(2049)]) assert.ok(!validFolder(bad), bad);
});

test('rangeBetween: shift-click selects everything between two rows in either order', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(rangeBetween(rows, 1, 3), ['b', 'c', 'd']);
  assert.deepEqual(rangeBetween(rows, 3, 1), ['b', 'c', 'd']);
  assert.deepEqual(rangeBetween(rows, 2, 2), ['c']);
  assert.deepEqual(rangeBetween(rows, -1, 2), [], 'no earlier click');
  assert.deepEqual(rangeBetween(rows, 0, 9), []);
});
