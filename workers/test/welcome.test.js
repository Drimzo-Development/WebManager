'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { welcomeHtml, welcomePhp } = require('../src/welcome');

test('static default page escapes the site name and is a complete document', () => {
  const html = welcomeHtml('A<b>"x" & Co');
  assert.match(html, /<title>A&lt;b&gt;&quot;x&quot; &amp; Co<\/title>/);
  assert.doesNotMatch(html, /A<b>/);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /<h1>A&lt;b&gt;/);
});

test('php default page escapes for PHP single quotes and renders the name via htmlspecialchars', () => {
  const php = welcomePhp("O'Brien \\ $x {$y}");
  assert.match(php, /^<\?php\n\$name = htmlspecialchars\('O\\'Brien \\\\ \$x \{\$y\}', ENT_QUOTES, 'UTF-8'\);/);
  assert.match(php, /<title><\?= \$name \?><\/title>/);
  assert.match(php, /PHP <\?= \$php \?> is active\./);
  assert.doesNotMatch(php, /"\$x/); // never interpolated: single-quoted literal only
});
