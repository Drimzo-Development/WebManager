'use strict';
const crypto = require('crypto');

/** Format shared with the PHP app: base64( iv[12] | tag[16] | ciphertext ), AES-256-GCM, key = hex APP_KEY. */
function keyFromHex(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex || '')) throw new Error('APP_KEY must be 64 hex characters');
  return Buffer.from(hex, 'hex');
}

function decrypt(b64, hexKey) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length < 29) throw new Error('ciphertext too short');
  const d = crypto.createDecipheriv('aes-256-gcm', keyFromHex(hexKey), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

function encrypt(plain, hexKey) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFromHex(hexKey), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

module.exports = { decrypt, encrypt };
