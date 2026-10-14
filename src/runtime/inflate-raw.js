'use strict';

// Pure-JS raw DEFLATE (RFC 1951) decoder.
//
// This file is dual-target and is inlined verbatim into the produced HTML:
//   * the packager requires() it in Node (tests run it against zlib output)
//   * the browser uses it as a fallback when DecompressionStream / 'deflate-raw'
//     is unavailable (Firefox < 113, Safari < 16.4)
//
// It is only inlined when the container actually contains deflated entries, so
// projects that need no compression do not pay for it.
//
// The decoding strategy is the classic counts/symbols canonical Huffman walk
// (same shape as zlib's puff.c): simple, branch-light enough, and easy to prove
// correct against zlib in the test suite.

const INFLATE_MAXBITS = 15;

const makeHuffman = () => ({
  count: new Int32Array(INFLATE_MAXBITS + 1),
  symbol: new Int32Array(288)
});

const huffmanBuild = (h, lengths, n) => {
  const count = h.count;
  count.fill(0);
  for (let symbol = 0; symbol < n; symbol++) count[lengths[symbol]]++;

  if (count[0] === n) return 0; // no codes at all

  let left = 1;
  for (let len = 1; len <= INFLATE_MAXBITS; len++) {
    left <<= 1;
    left -= count[len];
    if (left < 0) throw new Error('inflate: over-subscribed code lengths');
  }

  const offsets = new Int32Array(INFLATE_MAXBITS + 2);
  offsets[1] = 0;
  for (let len = 1; len < INFLATE_MAXBITS; len++) {
    offsets[len + 1] = offsets[len] + count[len];
  }
  for (let symbol = 0; symbol < n; symbol++) {
    if (lengths[symbol] !== 0) h.symbol[offsets[lengths[symbol]]++] = symbol;
  }

  return left;
};

// length codes 257..285
const LENGTH_BASE = new Int32Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
  67, 83, 99, 115, 131, 163, 195, 227, 258
]);
const LENGTH_EXTRA = new Int32Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
  4, 4, 4, 4, 5, 5, 5, 5, 0
]);

// distance codes 0..29
const DIST_BASE = new Int32Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577
]);
const DIST_EXTRA = new Int32Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
  9, 9, 10, 10, 11, 11, 12, 12, 13, 13
]);

// order in which the code-length alphabet is transmitted
const CODE_LENGTH_ORDER = new Int32Array([
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15
]);

/**
 * @param {Uint8Array} input raw deflate stream
 * @param {number} [expectedSize] hint for the initial output allocation
 * @returns {Uint8Array}
 */
const inflateRawJS = (input, expectedSize) => {
  let out = new Uint8Array(Math.max(1024, expectedSize || input.length * 4));
  let outLength = 0;

  const grow = (needed) => {
    if (outLength + needed <= out.length) return;
    let capacity = out.length;
    while (capacity < outLength + needed) capacity *= 2;
    const bigger = new Uint8Array(capacity);
    bigger.set(out.subarray(0, outLength));
    out = bigger;
  };

  // ---- bit reader --------------------------------------------------------
  let pos = 0;
  let bitbuf = 0;
  let bitcnt = 0;

  const bits = (need) => {
    let val = bitbuf;
    while (bitcnt < need) {
      if (pos >= input.length) throw new Error('inflate: unexpected end of input');
      val |= input[pos++] << bitcnt;
      bitcnt += 8;
    }
    bitbuf = val >>> need;
    bitcnt -= need;
    return val & ((1 << need) - 1);
  };

  const decode = (h) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= INFLATE_MAXBITS; len++) {
      code |= bits(1);
      const count = h.count[len];
      if (code - count < first) return h.symbol[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('inflate: invalid huffman code');
  };

  // ---- fixed Huffman block, built once -----------------------------------
  const fixedLitLen = makeHuffman();
  const fixedDist = makeHuffman();
  {
    const lengths = new Uint8Array(288);
    let i = 0;
    for (; i < 144; i++) lengths[i] = 8;
    for (; i < 256; i++) lengths[i] = 9;
    for (; i < 280; i++) lengths[i] = 7;
    for (; i < 288; i++) lengths[i] = 8;
    huffmanBuild(fixedLitLen, lengths, 288);

    const distLengths = new Uint8Array(30).fill(5);
    huffmanBuild(fixedDist, distLengths, 30);
  }

  const dynamicLitLen = makeHuffman();
  const dynamicDist = makeHuffman();
  const codeLengthHuffman = makeHuffman();
  const codeLengths = new Uint8Array(320);

  // ---- block loop --------------------------------------------------------
  for (;;) {
    const final = bits(1);
    const type = bits(2);

    if (type === 0) {
      // stored: move to a byte boundary, then copy verbatim
      const drop = bitcnt & 7;
      if (drop) bits(drop);

      if (bitcnt === 0) {
        if (pos + 4 > input.length) throw new Error('inflate: truncated stored block header');
        const len = input[pos] | (input[pos + 1] << 8);
        const nlen = input[pos + 2] | (input[pos + 3] << 8);
        pos += 4;
        if ((len ^ 0xffff) !== nlen) throw new Error('inflate: stored block length mismatch');
        if (pos + len > input.length) throw new Error('inflate: truncated stored block');
        grow(len);
        out.set(input.subarray(pos, pos + len), outLength);
        outLength += len;
        pos += len;
      } else {
        const len = bits(16);
        if (len !== (bits(16) ^ 0xffff)) throw new Error('inflate: stored block length mismatch');
        grow(len);
        for (let i = 0; i < len; i++) out[outLength++] = bits(8);
      }
    } else if (type === 1 || type === 2) {
      let litLen;
      let dist;

      if (type === 1) {
        litLen = fixedLitLen;
        dist = fixedDist;
      } else {
        // dynamic: read the code-length alphabet, then the two real alphabets
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;

        codeLengths.fill(0);
        for (let i = 0; i < hclen; i++) {
          codeLengths[CODE_LENGTH_ORDER[i]] = bits(3);
        }
        huffmanBuild(codeLengthHuffman, codeLengths, 19);

        const total = hlit + hdist;
        const lengths = codeLengths; // reuse the buffer, it is large enough
        lengths.fill(0);

        let index = 0;
        while (index < total) {
          const symbol = decode(codeLengthHuffman);
          if (symbol < 16) {
            lengths[index++] = symbol;
          } else {
            let repeat = 0;
            let value = 0;
            if (symbol === 16) {
              if (index === 0) throw new Error('inflate: repeat with no previous length');
              value = lengths[index - 1];
              repeat = 3 + bits(2);
            } else if (symbol === 17) {
              repeat = 3 + bits(3);
            } else {
              repeat = 11 + bits(7);
            }
            if (index + repeat > total) throw new Error('inflate: too many code lengths');
            while (repeat--) lengths[index++] = value;
          }
        }

        huffmanBuild(dynamicLitLen, lengths.subarray(0, hlit), hlit);
        huffmanBuild(dynamicDist, lengths.subarray(hlit), hdist);

        litLen = dynamicLitLen;
        dist = dynamicDist;
      }

      // ---- decode symbols -------------------------------------------------
      for (;;) {
        const symbol = decode(litLen);
        if (symbol < 256) {
          grow(1);
          out[outLength++] = symbol;
        } else if (symbol === 256) {
          break;
        } else {
          const lengthIndex = symbol - 257;
          if (lengthIndex >= 29) throw new Error(`inflate: invalid length symbol ${symbol}`);
          const length = LENGTH_BASE[lengthIndex] + bits(LENGTH_EXTRA[lengthIndex]);

          const distSymbol = decode(dist);
          if (distSymbol >= 30) throw new Error(`inflate: invalid distance symbol ${distSymbol}`);
          const distance = DIST_BASE[distSymbol] + bits(DIST_EXTRA[distSymbol]);
          if (distance > outLength) throw new Error('inflate: distance too far back');

          grow(length);
          let from = outLength - distance;
          for (let i = 0; i < length; i++) out[outLength++] = out[from++];
        }
      }
    } else {
      throw new Error('inflate: invalid block type');
    }

    if (final) break;
  }

  return out.subarray(0, outLength);
};

// Dual target: Node (tests + packager) and browser (inlined verbatim).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {inflateRawJS};
}
