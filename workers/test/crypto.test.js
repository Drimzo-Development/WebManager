'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encrypt, decrypt } = require('../src/crypto');

const key = 'ab'.repeat(32);

test('encrypt/decrypt roundtrip', () => {
  const c = encrypt('secret=äöü', key);
  assert.equal(decrypt(c, key), 'secret=äöü');
});

test('tampering and wrong keys are detected', () => {
  const c = Buffer.from(encrypt('x', key), 'base64');
  c[c.length - 1] ^= 1;
  assert.throws(() => decrypt(c.toString('base64'), key));
  assert.throws(() => decrypt(encrypt('x', key), 'cd'.repeat(32)));
  assert.throws(() => encrypt('x', 'short'));
});
