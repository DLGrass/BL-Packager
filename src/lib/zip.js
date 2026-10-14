'use strict';

// Minimal, dependency-free ZIP reader/writer.
// Only what a .sb3 needs: stored (0) and deflated (8) entries, no encryption,
// no zip64, no data descriptors on write.
//
// Using this instead of a JSZip build keeps the packager zero-dependency and,
// more importantly, makes the read path synchronous and allocation-light.

const zlib = require('node:zlib');
const {crc32} = require('./crc32');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * @param {Buffer|Uint8Array} input
 * @returns {Map<string, {method: number, crc: number, compressedSize: number, uncompressedSize: number, data: Buffer}>}
 */
const readZip = (input) => {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);

  // --- locate the End Of Central Directory record -------------------------
  let eocd = -1;
  const lowest = Math.max(0, buf.length - (EOCD_MIN + MAX_COMMENT));
  for (let i = buf.length - EOCD_MIN; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error('not a zip file: end of central directory not found');
  }

  const entryCount = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);

  if (centralOffset === 0xffffffff || entryCount === 0xffff) {
    throw new Error('zip64 archives are not supported');
  }

  // --- walk the central directory ----------------------------------------
  const entries = new Map();
  let p = centralOffset;

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error(`corrupt zip: central directory signature mismatch at ${p}`);
    }

    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);

    p += 46 + nameLength + extraLength + commentLength;

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error(`zip64 entry not supported: ${name}`);
    }

    // Directories are stored as zero-length entries ending in '/'.
    if (name.endsWith('/')) {
      continue;
    }

    // --- local header tells us where the payload actually starts ---------
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`corrupt zip: local header signature mismatch for ${name}`);
    }
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const rawData = buf.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === METHOD_STORE) {
      data = rawData;
    } else if (method === METHOD_DEFLATE) {
      data = zlib.inflateRawSync(rawData);
    } else {
      throw new Error(`unsupported zip compression method ${method} for ${name}`);
    }

    entries.set(name, {method, crc, compressedSize, uncompressedSize, data});
  }

  return entries;
};

/**
 * @param {{name: string, data: Buffer|Uint8Array}[]} entries
 * @param {{compression?: 'auto'|'deflate'|'store'}} [options]
 *   'auto'    (default) deflate only when it actually shrinks the entry
 *   'deflate' always deflate, even when it grows the entry — this is what
 *             Scratch's own serializer does, and reproducing it matters for
 *             benchmarking because a deflated asset has to be inflated again
 *             by whoever reads the archive
 *   'store'   never deflate
 * @returns {Buffer}
 */
const writeZip = (entries, options = {}) => {
  const compression = options.compression || 'auto';
  const locals = [];
  const centrals = [];
  let offset = 0;

  // Fixed DOS timestamp (1990-01-01 00:00:00) so output is byte-deterministic.
  const dosTime = 0;
  const dosDate = 0x0021;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);

    const crc = crc32(raw);
    const deflated = raw.length > 0 ? zlib.deflateRawSync(raw, {level: 9}) : raw;

    let method;
    let payload;
    if (compression === 'deflate') {
      method = METHOD_DEFLATE;
      payload = deflated;
    } else if (compression === 'store') {
      method = METHOD_STORE;
      payload = raw;
    } else {
      const useDeflate = deflated.length < raw.length;
      method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
      payload = useDeflate ? deflated : raw;
    }

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    locals.push(local, payload);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0x81a40000, 38); // external attrs: -rw-r--r-- (unix)
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    centrals.push(central);

    offset += local.length + payload.length;
  }

  const centralStart = offset;
  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);

  const eocd = Buffer.alloc(EOCD_MIN);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk with cd
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, ...centrals, eocd]);
};

module.exports = {readZip, writeZip, METHOD_STORE, METHOD_DEFLATE};
