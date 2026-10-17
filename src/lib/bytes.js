'use strict';

// The slice of Node's Buffer API that src/lib actually uses, for the browser
// build of the packager.
//
// The packing code was written against Buffer -- `Buffer.alloc`, `readUInt32LE`,
// `toString('latin1')` -- and rewriting five modules to Uint8Array + DataView
// would be a rewrite with its own chance of off-by-one byte errors, for no gain
// in behaviour. A subclass of Uint8Array that implements the used subset keeps
// the Node path untouched (where the real Buffer is still used, and still
// faster) and gives the browser exactly the same call surface.
//
// Nothing here is meant to be clever: each method is the obvious implementation,
// and test/run.js compares it against the real Buffer on the same inputs.

const utf8Encoder = typeof TextEncoder === 'undefined' ? null : new TextEncoder();
const utf8Decoder = typeof TextDecoder === 'undefined' ? null : new TextDecoder();

const HEX = '0123456789abcdef';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int8Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) table[B64.charCodeAt(i)] = i;
  return table;
})();

const encodeUtf8 = (text) => {
  if (utf8Encoder) return utf8Encoder.encode(text);
  // Fallback for an environment without TextEncoder: escaped UTF-8 by hand.
  const out = [];
  for (const char of text) {
    let code = char.codePointAt(0);
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    } else {
      out.push(
        0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63), 0x80 | (code & 63)
      );
    }
  }
  return Uint8Array.from(out);
};

const decodeUtf8 = (bytes) => {
  if (utf8Decoder) return utf8Decoder.decode(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const byte = bytes[i++];
    if (byte < 0x80) out += String.fromCharCode(byte);
    else if (byte < 0xe0) out += String.fromCharCode(((byte & 31) << 6) | (bytes[i++] & 63));
    else if (byte < 0xf0) {
      out += String.fromCharCode(((byte & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
    } else {
      const code = ((byte & 7) << 18) | ((bytes[i++] & 63) << 12) |
        ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      out += String.fromCodePoint(code);
    }
  }
  return out;
};

const encodeHex = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  }
  return out;
};

const decodeHex = (text) => {
  const length = text.length >> 1;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = parseInt(text.substr(i * 2, 2), 16);
  }
  return out;
};

const encodeBase64 = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return out;
};

const decodeBase64 = (text) => {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let at = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    buffer = (buffer << 6) | B64_LOOKUP[clean.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
};

const fromString = (text, encoding) => {
  switch (encoding) {
    case 'hex': return decodeHex(text);
    case 'base64': return decodeBase64(text);
    case 'latin1':
    case 'binary': {
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
      return out;
    }
    default: return encodeUtf8(text);
  }
};

class Buffer extends Uint8Array {
  static isBuffer(value) {
    return value instanceof Buffer;
  }

  static alloc(size, fill) {
    const out = new Buffer(size);
    if (fill) out.fill(typeof fill === 'number' ? fill : 0);
    return out;
  }

  static from(source, encoding) {
    if (typeof source === 'string') return new Buffer(fromString(source, encoding));
    if (source instanceof ArrayBuffer) return new Buffer(new Uint8Array(source));
    if (ArrayBuffer.isView(source)) {
      // A view keeps its own offset and length; copying is what Buffer.from does.
      return new Buffer(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
    }
    return new Buffer(Uint8Array.from(source));
  }

  static concat(list, totalLength) {
    let length = 0;
    for (const item of list) length += item.length;
    const out = new Buffer(totalLength === undefined ? length : totalLength);
    let at = 0;
    for (const item of list) {
      out.set(item, at);
      at += item.length;
    }
    return out;
  }

  readUInt8(offset) {
    return this[offset];
  }

  readUInt16LE(offset) {
    return this[offset] | (this[offset + 1] << 8);
  }

  readUInt16BE(offset) {
    return (this[offset] << 8) | this[offset + 1];
  }

  readUInt32LE(offset) {
    return (this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16) |
      (this[offset + 3] << 24)) >>> 0;
  }

  readUInt32BE(offset) {
    return ((this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) |
      this[offset + 3]) >>> 0;
  }

  writeUInt8(value, offset) {
    this[offset] = value & 0xff;
    return offset + 1;
  }

  writeUInt16LE(value, offset) {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >>> 8) & 0xff;
    return offset + 2;
  }

  writeUInt16BE(value, offset) {
    this[offset] = (value >>> 8) & 0xff;
    this[offset + 1] = value & 0xff;
    return offset + 2;
  }

  writeUInt32LE(value, offset) {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >>> 8) & 0xff;
    this[offset + 2] = (value >>> 16) & 0xff;
    this[offset + 3] = (value >>> 24) & 0xff;
    return offset + 4;
  }

  writeUInt32BE(value, offset) {
    this[offset] = (value >>> 24) & 0xff;
    this[offset + 1] = (value >>> 16) & 0xff;
    this[offset + 2] = (value >>> 8) & 0xff;
    this[offset + 3] = value & 0xff;
    return offset + 4;
  }

  write(text, offset, lengthOrEncoding, encoding) {
    const at = offset || 0;
    const bytes = fromString(String(text), typeof lengthOrEncoding === 'string'
      ? lengthOrEncoding
      : encoding);
    const room = Math.min(bytes.length, this.length - at);
    this.set(bytes.subarray(0, room), at);
    return room;
  }

  equals(other) {
    if (!other || other.length !== this.length) return false;
    for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
    return true;
  }

  copy(target, targetStart, sourceStart, sourceEnd) {
    const to = targetStart || 0;
    const from = sourceStart || 0;
    const end = sourceEnd === undefined ? this.length : sourceEnd;
    const slice = this.subarray(from, end);
    target.set(slice.subarray(0, Math.max(0, target.length - to)), to);
    return Math.min(slice.length, Math.max(0, target.length - to));
  }

  toString(encoding, start, end) {
    const view = this.subarray(start || 0, end === undefined ? this.length : end);
    switch (encoding) {
      case 'hex': return encodeHex(view);
      case 'base64': return encodeBase64(view);
      case 'latin1':
      case 'binary': {
        let out = '';
        for (let i = 0; i < view.length; i++) out += String.fromCharCode(view[i]);
        return out;
      }
      default: return decodeUtf8(view);
    }
  }

  slice(start, end) {
    // Buffer's slice is a view, like subarray; Uint8Array's own slice copies.
    return this.subarray(start, end);
  }
}

module.exports = {Buffer};
