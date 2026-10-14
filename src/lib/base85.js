'use strict';

// TurboWarp-compatible base85 codec.
//
// Wire format (identical to TurboWarp/packager's src/packager/base85.js):
//   * each group of 4 bytes -> 5 characters, little-endian uint32
//   * digit value 0..84 -> character code 0x2a..0x7e
//   * 0x3c ('<') and 0x3e ('>') are swapped for 0x28 ('(') and 0x29 (')')
//
// Why the swap matters: the resulting alphabet is completely free of
// < > " ' &, so the encoded text can be dropped straight into an HTML
// attribute with no escaping at all.
//
// Difference from upstream: the decoder below (both the Node reference and the
// in-page one) uses a 128-entry lookup table instead of calling a function with
// two comparisons per character. That removes ~10 branches per 4 bytes decoded.

const CHARSET_SIZE = 85;
const CHAR_OFFSET = 0x2a;

// 85^0..85^4
const POW = [1, 85, 7225, 614125, 52200625];

const encodeDigit = (value) => {
  let code = value + CHAR_OFFSET;
  if (code === 0x3c) code = 0x28; // '<' -> '('
  if (code === 0x3e) code = 0x29; // '>' -> ')'
  return code;
};

// value table: charCode -> digit value, -1 when the character is not a symbol
const DECODE_TABLE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let value = 0; value < CHARSET_SIZE; value++) {
    table[encodeDigit(value)] = value;
  }
  return table;
})();

/**
 * Encode a chunk of bytes. Length does not need to be a multiple of 4; the
 * encoder pads internally and the padding is not represented in the output.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const encodeChunk = (bytes) => {
  const length = bytes.length;
  const groups = Math.ceil(length / 4);
  const out = new Uint8Array(groups * 5);

  const slack = groups * 4 - length;
  let view;
  if (slack !== 0) {
    // Pad a copy so every group can be read as a uint32.
    const padded = new Uint8Array(groups * 4);
    padded.set(bytes);
    view = new DataView(padded.buffer, 0, groups * 4);
  } else {
    view = new DataView(bytes.buffer, bytes.byteOffset, groups * 4);
  }

  let outIndex = 0;
  for (let i = 0; i < view.byteLength; i += 4) {
    let n = view.getUint32(i, true);
    out[outIndex++] = encodeDigit(n % 85); n = (n - (n % 85)) / 85;
    out[outIndex++] = encodeDigit(n % 85); n = (n - (n % 85)) / 85;
    out[outIndex++] = encodeDigit(n % 85); n = (n - (n % 85)) / 85;
    out[outIndex++] = encodeDigit(n % 85); n = (n - (n % 85)) / 85;
    out[outIndex++] = encodeDigit(n);
  }

  // Chunk sizes are capped upstream at 64 KiB, so this string stays small.
  let result = '';
  for (let i = 0; i < out.length; i++) {
    result += String.fromCharCode(out[i]);
  }
  return result;
};

/**
 * Node-side reference decoder. Used by tests/verification, not by the browser.
 * @param {string} str
 * @param {Uint8Array} out destination buffer
 * @param {number} outOffset byte offset into `out`
 */
const decodeInto = (str, out, outOffset) => {
  const view = new DataView(out.buffer, out.byteOffset + outOffset, Math.floor(str.length / 5) * 4);
  for (let i = 0, j = 0; i < str.length; i += 5, j += 4) {
    view.setUint32(j, (
      DECODE_TABLE[str.charCodeAt(i + 4)] * POW[4] +
      DECODE_TABLE[str.charCodeAt(i + 3)] * POW[3] +
      DECODE_TABLE[str.charCodeAt(i + 2)] * POW[2] +
      DECODE_TABLE[str.charCodeAt(i + 1)] * POW[1] +
      DECODE_TABLE[str.charCodeAt(i)]
    ), true);
  }
};

/**
 * The exact decoder text that gets inlined into the produced HTML.
 * Keeping the codec in one place means the wire format and the runtime can not
 * drift apart (upstream keeps two copies with a "keep this up-to-date" comment).
 * @returns {string}
 */
const decoderSource = () => `
const B85_TABLE = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let v = 0; v < 85; v++) {
    let c = v + 0x2a;
    if (c === 0x3c) c = 0x28;
    if (c === 0x3e) c = 0x29;
    t[c] = v;
  }
  return t;
})();
const B85_POW4 = 52200625, B85_POW3 = 614125, B85_POW2 = 7225;
const base85decode = (str, outBuffer, outOffset) => {
  const view = new DataView(outBuffer, outOffset, Math.floor(str.length / 5) * 4);
  const t = B85_TABLE;
  for (let i = 0, j = 0; i < str.length; i += 5, j += 4) {
    view.setUint32(j, (
      t[str.charCodeAt(i + 4)] * B85_POW4 +
      t[str.charCodeAt(i + 3)] * B85_POW3 +
      t[str.charCodeAt(i + 2)] * B85_POW2 +
      t[str.charCodeAt(i + 1)] * 85 +
      t[str.charCodeAt(i)]
    ), true);
  }
};
`.trim();

module.exports = {encodeChunk, decodeInto, decoderSource, DECODE_TABLE, POW};
