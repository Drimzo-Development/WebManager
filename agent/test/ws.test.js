'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OP, acceptKey, encodeFrame, closeFrame, FrameParser, ProtocolError } = require('../src/ws');

/** A frame the way a browser sends it (masked). */
function clientFrame(opcode, payload, { fin = true, mask = Buffer.from([1, 2, 3, 4]) } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const m = Buffer.from(body);
  for (let i = 0; i < m.length; i++) m[i] ^= mask[i & 3];
  let head;
  if (body.length < 126) head = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | body.length]);
  else if (body.length < 65536) { head = Buffer.alloc(4); head[0] = (fin ? 0x80 : 0) | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(body.length, 2); }
  else { head = Buffer.alloc(10); head[0] = (fin ? 0x80 : 0) | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(body.length), 2); }
  return Buffer.concat([head, mask, m]);
}

test('handshake key of RFC 6455', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('server frames: short, medium and long payloads', () => {
  assert.deepEqual([...encodeFrame(OP.TEXT, 'hi')], [0x81, 2, 0x68, 0x69]);
  const mid = encodeFrame(OP.BINARY, Buffer.alloc(300));
  assert.deepEqual([...mid.subarray(0, 4)], [0x82, 126, 1, 44]);
  const big = encodeFrame(OP.BINARY, Buffer.alloc(70000));
  assert.equal(big[1], 127);
  assert.equal(Number(big.readBigUInt64BE(2)), 70000);
  assert.deepEqual([...closeFrame(1000, 'ok')].slice(0, 4), [0x88, 4, 0x03, 0xe8]);
});

test('masked client frames are decoded, also when they arrive in pieces', () => {
  const p = new FrameParser();
  const f = clientFrame(OP.TEXT, '{"type":"resize"}');
  assert.deepEqual(p.push(f.subarray(0, 3)), []);
  const out = p.push(f.subarray(3));
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.toString(), '{"type":"resize"}');
  const two = p.push(Buffer.concat([clientFrame(OP.BINARY, Buffer.from('a')), clientFrame(OP.BINARY, Buffer.alloc(200, 'b'))]));
  assert.deepEqual(two.map((m) => m.payload.length), [1, 200]);
});

test('fragmented messages are reassembled, control frames may interrupt', () => {
  const p = new FrameParser();
  const out = p.push(Buffer.concat([
    clientFrame(OP.TEXT, 'ab', { fin: false }), clientFrame(OP.PING, 'x'), clientFrame(OP.CONT, 'cd', { fin: true }),
  ]));
  assert.deepEqual(out.map((m) => [m.opcode, m.payload.toString()]), [[OP.PING, 'x'], [OP.TEXT, 'abcd']]);
});

test('protocol violations are refused', () => {
  assert.throws(() => new FrameParser().push(Buffer.from([0x81, 0x02, 0x68, 0x69])), ProtocolError, 'unmasked');
  assert.throws(() => new FrameParser().push(Buffer.from([0xc1, 0x80, 0, 0, 0, 0])), /reserved/);
  assert.throws(() => new FrameParser().push(clientFrame(OP.CONT, 'x')), /continuation/);
  assert.throws(() => new FrameParser().push(clientFrame(OP.PING, 'x', { fin: false })), /control/);
  assert.throws(() => new FrameParser({ maxPayload: 100 }).push(clientFrame(OP.BINARY, Buffer.alloc(101))), (e) => e.code === 1009);
  const huge = Buffer.alloc(14); huge[0] = 0x82; huge[1] = 0x80 | 127; huge.writeBigUInt64BE(2n ** 40n, 2);
  assert.throws(() => new FrameParser().push(huge), (e) => e.code === 1009, 'announced size is checked before anything is buffered');
  assert.throws(() => new FrameParser().push(clientFrame(0x3, 'x')), /opcode/);
});
