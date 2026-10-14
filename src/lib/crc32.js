'use strict';

// Standard CRC-32 (IEEE 802.3), as used by ZIP and PNG.
// Precomputed table: one lookup per byte instead of eight shifts.

const TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/**
 * @param {Uint8Array} bytes
 * @param {number} [seed] previous crc32 value (already finished), for streaming
 * @returns {number} unsigned 32-bit crc
 */
const crc32 = (bytes, seed = 0) => {
  let crc = ~seed;
  for (let i = 0; i < bytes.length; i++) {
    crc = TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (~crc) >>> 0;
};

module.exports = {crc32};
