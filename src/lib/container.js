'use strict';

// ---------------------------------------------------------------------------
// BLPK container
// ---------------------------------------------------------------------------
//
// TurboWarp embeds the original .sb3 bytes and lets JSZip unpack them in the
// page. That costs two things on every open:
//
//   1. JSZip must parse the zip central directory and build entry objects, and
//      its asset lookup falls back to a *regexp scan over every entry* on miss.
//   2. Every asset that the zip stored with DEFLATE is inflated by JSZip's
//      pure-JS inflater, on the main thread, synchronously.
//
// The BLPK container replaces the zip with a flat, pre-resolved layout:
//
//   offset 0   magic "BLPK"
//   offset 4   version (uint8)
//   offset 5   flags (uint8)   bit0: index is deflate-raw
//   offset 6   reserved (uint16)
//   offset 8   indexLength (uint32 LE)
//   offset 12  index JSON (UTF-8, indexLength bytes)
//   ...        payload: every entry's bytes, back to back
//
// index JSON:
//   { "v": 1, "p": [off, len, flag], "a": { "<md5ext>": [off, len, flag] } }
//   flag 0 = stored raw, 1 = deflate-raw
//
// Looking an asset up is then a Map hit plus a subarray, with no zip parsing and
// — for the overwhelmingly common case of already-compressed assets (png, jpg,
// mp3, ogg) — no decompression at all. The few entries where DEFLATE genuinely
// wins (svg, wav, ttf) are inflated with the platform's native
// DecompressionStream instead of a JS inflater.

const zlib = require('node:zlib');

const MAGIC = Buffer.from('BLPK', 'utf8');
const VERSION = 1;
const HEADER_SIZE = 12;

const FLAG_INDEX_DEFLATED = 1;

const FLAG_ENTRY_DEFLATED = 1;

/**
 * Decide whether deflating an entry is worth it.
 * @param {Buffer} raw
 * @param {number} minSaving minimum ratio of bytes saved (0..1)
 * @param {number} minSize entries smaller than this are never compressed
 */
const deflateEntry = (raw, minSaving, minSize) => {
  if (raw.length < minSize) return {flag: 0, data: raw};
  const deflated = zlib.deflateRawSync(raw, {level: 9});
  if (deflated.length <= raw.length * (1 - minSaving)) {
    return {flag: FLAG_ENTRY_DEFLATED, data: deflated};
  }
  return {flag: 0, data: raw};
};

/**
 * @param {{projectJSONBytes: Buffer, assets: Map<string, Buffer>}} project
 * @param {{minSaving?: number, minSize?: number, deflateIndex?: boolean}} [options]
 * @returns {{container: Buffer, stats: object}}
 */
const buildContainer = (project, options = {}) => {
  const minSaving = options.minSaving === undefined ? 0.05 : options.minSaving;
  const minSize = options.minSize === undefined ? 64 : options.minSize;

  /** ordered entries: project.json first so the VM can start as early as possible */
  const queue = [
    {name: 'project.json', raw: project.projectJSONBytes}
  ];
  for (const [name, raw] of project.assets) {
    queue.push({name, raw});
  }

  const index = {v: VERSION, p: null, a: {}};
  const payloadParts = [];
  const stats = {assetsRaw: 0, assetsDeflated: 0, deflatedBytesSaved: 0, storedBytes: 0};

  let payloadSize = 0;
  for (const entry of queue) {
    const {flag, data} = deflateEntry(entry.raw, minSaving, minSize);
    if (flag === FLAG_ENTRY_DEFLATED) {
      stats.assetsDeflated++;
      stats.deflatedBytesSaved += entry.raw.length - data.length;
    } else {
      stats.assetsRaw++;
    }
    stats.storedBytes += data.length;

    // [payloadOffset, storedLength, flags, uncompressedLength]
    // The 4th element is only used as an allocation hint by the JS inflate
    // fallback, and lets us recycle the buffer without re-deriving the size.
    const record = [payloadSize, data.length, flag, entry.raw.length];
    if (entry.name === 'project.json') {
      index.p = record;
    } else {
      // Keyed by basename: sb3 files are allowed to keep assets in one level of
      // subdirectory, but scratch-vm always asks for "<md5>.<ext>".
      index.a[basename(entry.name)] = record;
    }

    payloadParts.push(data);
    payloadSize += data.length;
  }

  let indexJSON = Buffer.from(JSON.stringify(index), 'utf8');
  let flags = 0;
  if (options.deflateIndex && indexJSON.length >= 512) {
    const deflated = zlib.deflateRawSync(indexJSON, {level: 9});
    if (deflated.length < indexJSON.length * 0.9) {
      indexJSON = deflated;
      flags |= FLAG_INDEX_DEFLATED;
    }
  }

  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, 4);
  header.writeUInt8(flags, 5);
  header.writeUInt16LE(0, 6);
  header.writeUInt32LE(indexJSON.length, 8);

  const container = Buffer.concat([header, indexJSON, ...payloadParts]);

  stats.indexBytes = indexJSON.length;
  stats.payloadBytes = payloadSize;
  stats.containerBytes = container.length;
  stats.indexDeflated = (flags & FLAG_INDEX_DEFLATED) !== 0;

  return {container, stats, payloadOffset: HEADER_SIZE + indexJSON.length};
};

const basename = (name) => {
  const slash = name.lastIndexOf('/');
  return slash === -1 ? name : name.slice(slash + 1);
};

/**
 * Node-side reader, used by tests and the verifier.
 * @param {Buffer} buffer
 * @returns {{index: object, payloadOffset: number, entry: (record: number[]) => Buffer}}
 */
const parseContainer = (buffer) => {
  if (buffer.length < HEADER_SIZE || !buffer.subarray(0, 4).equals(MAGIC)) {
    throw new Error('not a BLPK container');
  }
  const version = buffer.readUInt8(4);
  if (version !== VERSION) {
    throw new Error(`unsupported BLPK version ${version}`);
  }
  const flags = buffer.readUInt8(5);
  const indexLength = buffer.readUInt32LE(8);
  let indexJSON = buffer.subarray(HEADER_SIZE, HEADER_SIZE + indexLength);
  if (flags & FLAG_INDEX_DEFLATED) {
    indexJSON = zlib.inflateRawSync(indexJSON);
  }
  const index = JSON.parse(indexJSON.toString('utf8'));
  const payloadOffset = HEADER_SIZE + indexLength;

  const entry = (record) => {
    const [offset, length, flag] = record;
    const slice = buffer.subarray(payloadOffset + offset, payloadOffset + offset + length);
    return flag === FLAG_ENTRY_DEFLATED ? zlib.inflateRawSync(slice) : slice;
  };

  return {index, payloadOffset, entry, flags};
};

module.exports = {
  buildContainer,
  parseContainer,
  basename,
  MAGIC,
  VERSION,
  HEADER_SIZE,
  FLAG_INDEX_DEFLATED,
  FLAG_ENTRY_DEFLATED
};
