'use strict';

// Lossless PNG re-compression.
//
// Why this exists: PNG is the dominant asset class in a real Scratch project,
// and the bytes are whatever the *editor* produced. Scratch's paint editor and
// every imported bitmap go through a canvas and then
// `canvas.toDataURL('image/png')`, and Chromium's encoder habitually emits
// `filter = 0` (None) on every scanline at the default zlib level. That is a
// legal but weak encoding: for smooth artwork, per-row filtering removes most
// of the redundancy before deflate ever sees it.
//
// So we decode the IDAT stream, undo the per-row filters, pick a filter type
// per scanline (minimum sum of absolute differences — the heuristic libpng
// uses), and re-deflate. Pixels are bit-identical; only the IDAT bytes change.
// Everything else (PLTE, tRNS, gAMA, iCCP, ...) is copied through untouched.
//
// Returns null whenever the result would not be smaller, so callers can treat
// "null" as "leave this asset alone".

const zlib = require('node:zlib');

const {crc32} = require('./crc32');

const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Refuse absurd images rather than allocating gigabytes in the packager.
const MAX_RAW_BYTES = 96 * 1024 * 1024;

const isPng = (bytes) => bytes.length > 8 && bytes.subarray(0, 8).equals(MAGIC);

const CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};

/**
 * Split a PNG into its chunks. `raw` keeps the full on-disk form (length, type,
 * data, CRC) so unchanged chunks can be re-emitted byte for byte.
 */
const readChunks = (bytes) => {
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (offset + 12 + length > bytes.length) return null;
    chunks.push({
      type: bytes.toString('latin1', offset + 4, offset + 8),
      data: bytes.subarray(offset + 8, offset + 8 + length),
      raw: bytes.subarray(offset, offset + 12 + length)
    });
    offset += 12 + length;
    if (chunks[chunks.length - 1].type === 'IEND') break;
  }
  return chunks.length ? chunks : null;
};

const writeChunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, crc]);
};

/** Undo per-row filtering. Returns plain scanlines (no filter type bytes). */
const unfilter = (raw, bytesPerRow, bpp, height) => {
  const rows = [];
  const prev = Buffer.alloc(bytesPerRow);
  for (let y = 0; y < height; y++) {
    const at = y * (bytesPerRow + 1);
    const type = raw[at];
    if (type > 4) return null;
    const row = Buffer.alloc(bytesPerRow);
    for (let i = 0; i < bytesPerRow; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const x = raw[at + 1 + i];
      let v;
      if (type === 0) v = x;
      else if (type === 1) v = x + a;
      else if (type === 2) v = x + b;
      else if (type === 3) v = x + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
      }
      row[i] = v & 0xff;
    }
    rows.push(row);
    row.copy(prev);
  }
  return rows;
};

/** Re-apply per-row filtering with a per-scanline choice of filter type. */
const filterAdaptive = (rows, bpp) => {
  const parts = [];
  const prev = Buffer.alloc(rows[0].length);
  const candidate = Buffer.alloc(rows[0].length);
  for (const row of rows) {
    let bestType = 0;
    let bestScore = Infinity;
    let best = null;
    for (let type = 0; type <= 4; type++) {
      let score = 0;
      for (let i = 0; i < row.length; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let v;
        if (type === 0) v = row[i];
        else if (type === 1) v = row[i] - a;
        else if (type === 2) v = row[i] - b;
        else if (type === 3) v = row[i] - ((a + b) >> 1);
        else {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = row[i] - (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
        }
        v &= 0xff;
        candidate[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        best = Buffer.from(candidate);
      }
    }
    parts.push(Buffer.from([bestType]), best);
    row.copy(prev);
  }
  return Buffer.concat(parts);
};

const STRATEGIES = [
  zlib.constants.Z_DEFAULT_STRATEGY,
  zlib.constants.Z_FILTERED,
  zlib.constants.Z_RLE
];

const deflateBest = (input, level) => {
  let best = null;
  for (const strategy of STRATEGIES) {
    let out;
    try {
      out = zlib.deflateSync(input, {level, memLevel: 9, strategy});
    } catch {
      continue;
    }
    if (!best || out.length < best.length) best = out;
  }
  return best;
};

/**
 * @param {Buffer} bytes a PNG file
 * @param {{level?: number}} [options]
 * @returns {Buffer|null} a smaller, pixel-identical PNG, or null to keep the original
 */
const recompressPng = (bytes, options = {}) => {
  const level = options.level === undefined ? 9 : options.level;
  if (!isPng(bytes)) return null;

  const chunks = readChunks(bytes);
  if (!chunks) return null;

  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length < 13) return null;
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  // Adam7 re-interleaves scanlines; not worth supporting for the gain.
  if (interlace !== 0) return null;
  if (![1, 2, 4, 8, 16].includes(bitDepth)) return null;
  const channels = CHANNELS[colorType];
  if (!channels) return null;
  if (!width || !height) return null;

  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const bytesPerRow = Math.ceil((width * bitsPerPixel) / 8);
  if (bytesPerRow * height > MAX_RAW_BYTES) return null;

  const idat = chunks.filter((c) => c.type === 'IDAT');
  if (!idat.length) return null;

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat.map((c) => c.data)));
  } catch {
    return null;
  }
  if (raw.length !== (bytesPerRow + 1) * height) return null;

  // Two candidates: keep the original filtered stream (only re-deflate), or
  // re-choose the filter per scanline. Best of both wins.
  const rows = unfilter(raw, bytesPerRow, bpp, height);
  if (!rows) return null;
  const refiltered = filterAdaptive(rows, bpp);

  const candidates = [deflateBest(raw, level), deflateBest(refiltered, level)].filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.length - b.length);
  const bestIdat = candidates[0];

  // Collapsing several IDAT chunks into one changes the framing, so compare
  // against the total IDAT payload, then against the whole file at the end.
  const originalIdatBytes = idat.reduce((n, c) => n + c.data.length, 0);
  if (bestIdat.length >= originalIdatBytes) return null;

  // Re-emit: everything before the first IDAT, one fresh IDAT, everything after
  // the last IDAT.
  const out = [MAGIC];
  let sawIdat = false;
  let emitted = false;
  for (const chunk of chunks) {
    if (chunk.type === 'IDAT') {
      if (!sawIdat) {
        out.push(writeChunk('IDAT', bestIdat));
        sawIdat = true;
        emitted = true;
      }
      continue;
    }
    out.push(chunk.raw);
    if (chunk.type === 'IEND') break;
  }
  if (!emitted) return null;

  const result = Buffer.concat(out);
  return result.length < bytes.length ? result : null;
};

module.exports = {recompressPng, isPng, unfilter, filterAdaptive, readChunks, writeChunk};
