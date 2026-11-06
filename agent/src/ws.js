'use strict';
/**
 * Minimal WebSocket (RFC 6455) for the web console: handshake key, server frames and a parser for the masked frames of
 * browsers. No extensions, no compression; fragmented messages are reassembled, frames above `maxPayload` are refused.
 */
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

const acceptKey = (key) => crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');

/** Unmasked frame (server to client). */
function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let head;
  if (body.length < 126) {
    head = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(body.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([head, body]);
}

const closeFrame = (code = 1000, reason = '') => encodeFrame(OP.CLOSE, Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(String(reason).slice(0, 100))]));

class ProtocolError extends Error {
  constructor(message, code = 1002) { super(message); this.code = code; }
}

/** Feed it the raw bytes of the connection; it returns the complete messages { opcode, payload }. */
class FrameParser {
  constructor({ maxPayload = 64 * 1024 } = {}) {
    this.maxPayload = maxPayload;
    this.buf = Buffer.alloc(0);
    this.partial = null; // { opcode, chunks, size } of a fragmented data message
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if (b0 & 0x70) throw new ProtocolError('reserved bits set');
      if (!(b1 & 0x80)) throw new ProtocolError('client frames must be masked');
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) throw new ProtocolError('frame too large', 1009);
        len = Number(big); off = 10;
      }
      if (len > this.maxPayload) throw new ProtocolError('frame too large', 1009);
      if (this.buf.length < off + 4 + len) break;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);

      if (opcode >= 0x8) { // control frames: not fragmented, at most 125 bytes
        if (!fin || len > 125) throw new ProtocolError('invalid control frame');
        out.push({ opcode, payload });
        continue;
      }
      if (opcode === OP.CONT) {
        if (!this.partial) throw new ProtocolError('unexpected continuation');
        this.partial.size += len;
        if (this.partial.size > this.maxPayload) throw new ProtocolError('message too large', 1009);
        this.partial.chunks.push(payload);
        if (fin) { out.push({ opcode: this.partial.opcode, payload: Buffer.concat(this.partial.chunks) }); this.partial = null; }
        continue;
      }
      if (opcode !== OP.TEXT && opcode !== OP.BINARY) throw new ProtocolError('unknown opcode');
      if (this.partial) throw new ProtocolError('new message inside a fragmented one');
      if (fin) out.push({ opcode, payload });
      else this.partial = { opcode, chunks: [payload], size: len };
    }
    return out;
  }
}

module.exports = { OP, acceptKey, encodeFrame, closeFrame, FrameParser, ProtocolError };
