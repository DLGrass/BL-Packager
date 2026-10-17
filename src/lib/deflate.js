'use strict';

// A synchronous DEFLATE encoder (RFC 1951), fixed-Huffman blocks with a greedy
// LZ77 match finder.
//
// Why this exists: the browser build of the packager needs to compress the
// container payload, and the browser has no synchronous deflate. CompressionStream
// is asynchronous, and making it fit would turn the whole pipeline -- loadSb3,
// buildContainer, renderHtml -- into promises, for a front end that would still
// not produce the same bytes as the CLI. So the browser gets its own encoder and
// Node keeps `node:zlib`: identical output where it is already measured, "works,
// a bit bigger" where it is not.
//
// It is the same trade the runtime already makes for inflate: src/runtime/
// inflate-raw.js is a hand-written decoder for the produced page, and this is
// its encoder-side sibling. Decoding is not the hard part of DEFLATE; encoding
// is, and the honest ceiling of fixed Huffman is stated below.

// Length codes 257..285: base length and the number of extra bits that follow.
const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
];

// Distance codes 0..29: base distance and extra bits.
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
];

const WINDOW = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const HASH_BITS = 15;
const HASH_MASK = (1 << HASH_BITS) - 1;
// Long enough to find the repetition in text and SVG, short enough that a
// 13 MB payload does not turn into minutes of byte comparisons. Compression
// ratio is the knob that pays for this, and it is the knob we can afford.
const MAX_CHAIN = 16;

// Fixed Huffman literal/length table (RFC 1951 section 3.2.6). Codes are
// written most-significant-bit first, so both pieces are stored here: the raw
// code and its bit length.
const LIT_CODE = new Uint16Array(288);
const LIT_BITS = new Uint8Array(288);
for (let i = 0; i < 288; i++) {
  if (i < 144) {
    LIT_CODE[i] = 0x30 + i;
    LIT_BITS[i] = 8;
  } else if (i < 256) {
    LIT_CODE[i] = 0x190 + (i - 144);
    LIT_BITS[i] = 9;
  } else if (i < 280) {
    LIT_CODE[i] = i - 256;
    LIT_BITS[i] = 7;
  } else {
    LIT_CODE[i] = 0xc0 + (i - 280);
    LIT_BITS[i] = 8;
  }
}

// Reverse the low `bits` bits of `value`. Huffman codes go out MSB-first while
// everything else in the stream is LSB-first, and the bit writer is LSB-first.
const reverseBits = (value, bits) => {
  let out = 0;
  for (let i = 0; i < bits; i++) {
    out = (out << 1) | ((value >>> i) & 1);
  }
  return out;
};

class ByteSink {
  constructor(capacity) {
    this.bytes = new Uint8Array(Math.max(64, capacity | 0));
    this.length = 0;
  }

  push(byte) {
    if (this.length === this.bytes.length) this.grow();
    this.bytes[this.length++] = byte;
  }

  grow() {
    const next = new Uint8Array(this.bytes.length * 2);
    next.set(this.bytes);
    this.bytes = next;
  }

  finish() {
    return this.bytes.slice(0, this.length);
  }
}

const adler32 = (data) => {
  let a = 1;
  let b = 0;
  // 5552 is the largest n for which 255n(n+1)/2 + (n+1)(BASE-1) fits in 32 bits,
  // so the modulo only has to happen once per chunk.
  for (let i = 0; i < data.length; ) {
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
};

/**
 * Raw DEFLATE (no zlib wrapper), as an sb3 entry or a BLPK asset stores it.
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 */
const deflateRaw = (input) => {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const size = data.length;
  const sink = new ByteSink((size >>> 1) + 64);

  let bitBuf = 0;
  let bitCount = 0;
  const writeBits = (value, count) => {
    bitBuf |= value << bitCount;
    bitCount += count;
    while (bitCount >= 8) {
      sink.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };
  const writeCode = (code, bits) => writeBits(reverseBits(code, bits), bits);

  // One block, final, fixed Huffman.
  writeBits(1, 1);
  writeBits(1, 2);

  const emitLiteral = (byte) => writeCode(LIT_CODE[byte], LIT_BITS[byte]);
  const emitMatch = (length, distance) => {
    let code = 0;
    while (code < 28 && LEN_BASE[code + 1] <= length) code++;
    writeCode(LIT_CODE[257 + code], LIT_BITS[257 + code]);
    if (LEN_EXTRA[code]) writeBits(length - LEN_BASE[code], LEN_EXTRA[code]);

    let slot = 0;
    while (slot < 29 && DIST_BASE[slot + 1] <= distance) slot++;
    // Fixed distance codes are five bits, sent MSB-first like every Huffman code.
    writeCode(slot, 5);
    if (DIST_EXTRA[slot]) writeBits(distance - DIST_BASE[slot], DIST_EXTRA[slot]);
  };

  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const prev = new Int32Array(WINDOW).fill(-1);
  const hashAt = (i) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & HASH_MASK;
  const insert = (i) => {
    if (i + MIN_MATCH > size) return;
    const hash = hashAt(i);
    prev[i & (WINDOW - 1)] = head[hash];
    head[hash] = i;
  };

  // The best match starting at `at`, without touching the hash chains. Greedy
  // encoding loses badly on text because the longest match often starts one byte
  // later, so the caller compares this position against the next one before
  // committing.
  const findMatch = (at) => {
    let bestLength = 0;
    let bestDistance = 0;
    if (at + MIN_MATCH > size) return {length: 0, distance: 0};

    const maxLength = Math.min(MAX_MATCH, size - at);
    let candidate = head[hashAt(at)];
    let chain = MAX_CHAIN;
    while (candidate >= 0 && at - candidate <= WINDOW && chain-- > 0) {
      // Cheap reject first: a match has to be longer than the best one so far to
      // be worth reading, so compare the byte that would extend it.
      if (data[candidate + bestLength] === data[at + bestLength]) {
        let length = 0;
        while (length < maxLength && data[candidate + length] === data[at + length]) length++;
        if (length > bestLength) {
          bestLength = length;
          bestDistance = at - candidate;
          if (length >= maxLength) break;
        }
      }
      candidate = prev[candidate & (WINDOW - 1)];
    }
    return {length: bestLength, distance: bestDistance};
  };

  let i = 0;
  while (i < size) {
    const here = findMatch(i);

    if (here.length >= MIN_MATCH) {
      // Lazy evaluation: if the match starting at i+1 is longer, one literal is
      // the cheaper way to get there.
      const next = findMatch(i + 1);
      if (next.length > here.length) {
        insert(i);
        emitLiteral(data[i]);
        i++;
        continue;
      }
      emitMatch(here.length, here.distance);
      // Every position covered by the match still has to enter the hash chains,
      // or a later match would look past them.
      for (let k = i; k < i + here.length; k++) insert(k);
      i += here.length;
    } else {
      insert(i);
      emitLiteral(data[i]);
      i++;
    }
  }

  // End of block.
  writeCode(LIT_CODE[256], LIT_BITS[256]);
  if (bitCount > 0) sink.push(bitBuf & 0xff);

  return sink.finish();
};

/**
 * DEFLATE inside a zlib wrapper (RFC 1950), which is what a PNG's IDAT stream
 * is: a two-byte header and a trailing Adler-32 of the *uncompressed* data.
 */
const deflateZlib = (input) => {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const body = deflateRaw(data);
  const out = new Uint8Array(body.length + 6);
  // 0x78 0x9c: deflate, 32K window, default compression level.
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(body, 2);
  const sum = adler32(data);
  out[out.length - 4] = (sum >>> 24) & 0xff;
  out[out.length - 3] = (sum >>> 16) & 0xff;
  out[out.length - 2] = (sum >>> 8) & 0xff;
  out[out.length - 1] = sum & 0xff;
  return out;
};

// The four tables are exported so test/run.js can assert their ranges against
// the RFC: an off-by-one in one of them still produces a stream zlib will
// inflate, just to the wrong bytes.
module.exports = {
  deflateRaw,
  deflateZlib,
  adler32,
  LEN_BASE,
  LEN_EXTRA,
  DIST_BASE,
  DIST_EXTRA
};
