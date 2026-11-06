import assert from 'node:assert/strict';
import { test } from 'node:test';
import { b64uToBuf, bufToB64u } from './webauthn.ts';

test('base64url: round trip with all byte values and without padding', () => {
  const all = new Uint8Array(256).map((_, i) => i);
  for (const len of [0, 1, 2, 3, 4, 5, 31, 32, 33, 256]) {
    const src = all.slice(0, len);
    const enc = bufToB64u(src.buffer);
    assert.match(enc, /^[A-Za-z0-9_-]*$/, `only URL-safe characters at ${len} Bytes`);
    assert.deepEqual(new Uint8Array(b64uToBuf(enc)), src, `round trip at ${len} Bytes`);
  }
});

test('base64url: known values', () => {
  assert.equal(bufToB64u(new Uint8Array([251, 255, 254]).buffer), '-__-');
  assert.deepEqual(new Uint8Array(b64uToBuf('-__-')), new Uint8Array([251, 255, 254]));
  assert.deepEqual(new Uint8Array(b64uToBuf('AQID')), new Uint8Array([1, 2, 3]));
});
