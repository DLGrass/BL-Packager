'use strict';

// MD5, for the one place the packager hashes anything: a PNG that survived
// recompression is renamed to a hash of its new bytes, so a viewer's cache key
// changes with the content (src/lib/sb3.js).
//
// Node has this in node:crypto; the browser has no synchronous digest at all
// (SubtleCrypto is async and refuses MD5), so the browser build brings its own.
// It is textbook MD5 with no cleverness -- see RFC 1321 -- and test/run.js
// checks it against node:crypto on random input of every length that matters.

const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

// floor(abs(sin(i + 1)) * 2^32), the standard table.
const K = (() => {
  const table = new Uint32Array(64);
  for (let i = 0; i < 64; i++) table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  return table;
})();

const rotateLeft = (value, bits) => ((value << bits) | (value >>> (32 - bits))) >>> 0;

const md5Bytes = (input) => {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const length = data.length;

  // Message + 0x80 + zero fill + 64-bit little-endian bit count.
  const paddedLength = (((length + 8) >> 6) + 1) << 6;
  const message = new Uint8Array(paddedLength);
  message.set(data);
  message[length] = 0x80;
  const view = new DataView(message.buffer);
  // Bit length as two 32-bit halves; inputs here are far below 2^32 bits, but
  // the high half is written anyway so the function is not silently wrong above
  // 512 MB.
  view.setUint32(paddedLength - 8, (length << 3) >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor((length * 8) / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const words = new Uint32Array(16);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const next = d;
      d = c;
      c = b;
      b = (b + rotateLeft((a + f + K[i] + words[g]) >>> 0, SHIFTS[i])) >>> 0;
      a = next;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
};

const toHex = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return out;
};

/** createHash('md5').update(x).digest('hex'), the only shape the packager uses. */
const createHash = () => {
  const chunks = [];
  let size = 0;
  return {
    update(chunk) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      chunks.push(bytes);
      size += bytes.length;
      return this;
    },
    digest(encoding) {
      const joined = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        joined.set(chunk, at);
        at += chunk.length;
      }
      const digest = md5Bytes(joined);
      return encoding === 'hex' ? toHex(digest) : digest;
    }
  };
};

module.exports = {md5: md5Bytes, createHash, toHex};
