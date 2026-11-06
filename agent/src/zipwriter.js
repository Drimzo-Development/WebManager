'use strict';
/**
 * Streaming ZIP writer (no dependencies): deflate with a data descriptor behind every file, so nothing has to be held in memory or
 * written to a temporary file. UTF-8 names, Unix permissions in the external attributes. No ZIP64: the callers limit the number of
 * entries (20,000) and the total size (2 GiB), which stays far below the 32-bit limits of the classic format.
 */
const fs = require('fs');
const zlib = require('zlib');
const { once } = require('events');

const MAX_ENTRY_BYTES = 0xfffffffe;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of `buf`, continuing from `prev` (0 to start). */
function crc32(buf, prev = 0) {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time of a Date (local time, as the format has no zone; never before 1980). */
function dosDateTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}

class ZipWriter {
  /** `out` is a Writable (stdout or a file); the writer never ends it. */
  constructor(out) {
    this.out = out;
    this.pos = 0;
    this.entries = [];
  }

  async _write(buf) {
    this.pos += buf.length;
    if (!this.out.write(buf)) await once(this.out, 'drain');
  }

  _local(nameBuf, flags, method, dos) {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4); // version needed
    h.writeUInt16LE(flags, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(dos.time, 10);
    h.writeUInt16LE(dos.date, 12);
    // crc and sizes follow in the data descriptor (or are 0 for a folder)
    h.writeUInt16LE(nameBuf.length, 26);
    return Buffer.concat([h, nameBuf]);
  }

  /** A folder entry. `name` is relative and without a trailing slash. */
  async addDir(name, mtime, mode) {
    const nameBuf = Buffer.from(`${name}/`, 'utf8');
    const dos = dosDateTime(new Date(mtime));
    const offset = this.pos;
    await this._write(this._local(nameBuf, 0x0800, 0, dos));
    this.entries.push({ nameBuf, flags: 0x0800, method: 0, dos, crc: 0, csize: 0, usize: 0, offset, attr: (((mode & 0o7777) | 0o040000) << 16 | 0x10) >>> 0 });
  }

  /** A file, read from the open descriptor `fd` (the caller opened it with O_NOFOLLOW) and compressed on the way. */
  async addFile(name, fd, mtime, mode) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dos = dosDateTime(new Date(mtime));
    const offset = this.pos;
    await this._write(this._local(nameBuf, 0x0808, 8, dos));
    let crc = 0;
    let usize = 0;
    let csize = 0;
    const df = zlib.createDeflateRaw({ level: 6 });
    const rs = fs.createReadStream(null, { fd, autoClose: false });
    const feed = (async () => {
      for await (const chunk of rs) {
        crc = crc32(chunk, crc);
        usize += chunk.length;
        if (usize > MAX_ENTRY_BYTES) throw new Error('A file is too large for a ZIP archive');
        if (!df.write(chunk)) await once(df, 'drain');
      }
      df.end();
    })();
    const drain = (async () => {
      for await (const c of df) {
        csize += c.length;
        if (csize > MAX_ENTRY_BYTES) throw new Error('A file is too large for a ZIP archive');
        await this._write(c);
      }
    })();
    await Promise.all([feed, drain]);
    const d = Buffer.alloc(16);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(crc, 4);
    d.writeUInt32LE(csize, 8);
    d.writeUInt32LE(usize, 12);
    await this._write(d);
    this.entries.push({ nameBuf, flags: 0x0808, method: 8, dos, crc, csize, usize, offset, attr: (((mode & 0o7777) | 0o100000) << 16) >>> 0 });
  }

  /** Central directory and end record. Returns the number of bytes written in total. */
  async finish() {
    const start = this.pos;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(e.flags, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.dos.time, 12);
      h.writeUInt16LE(e.dos.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.usize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt32LE(e.attr, 38);
      h.writeUInt32LE(e.offset, 42);
      await this._write(Buffer.concat([h, e.nameBuf]));
    }
    const size = this.pos - start;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    await this._write(end);
    return this.pos;
  }
}

module.exports = { ZipWriter, crc32, dosDateTime, MAX_ENTRY_BYTES };
