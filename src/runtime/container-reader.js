'use strict';

// BLPK container reader. Dual-target: required by the packager's tests, and
// inlined verbatim into the produced HTML.
//
// The inflate function is injected so the same reader drives both the native
// (DecompressionStream) and the pure-JS fallback path, and so Node tests can
// exercise identical logic.

const BLPK_HEADER_SIZE = 12;
const BLPK_FLAG_INDEX_DEFLATED = 1;

const blpkTextDecoder = new TextDecoder();

/**
 * @param {ArrayBuffer} buffer decoded container bytes
 * @param {(bytes: Uint8Array, expectedSize?: number) => (Uint8Array|Promise<Uint8Array>)} inflateRaw
 * @param {{preloadDeflated?: boolean, length?: number, copyStored?: boolean}} [options]
 *        `length` is the container's true byte length; the base85 decoder pads
 *        its output buffer to a multiple of 4, so byteLength may be larger.
 *
 *        `copyStored` (default true) decides how RAW entries are handed out:
 *
 *          true   an owned copy, whose ArrayBuffer is exactly the entry size.
 *          false  a zero-copy view into the whole decoded container buffer.
 *
 *        The view looks like the obvious optimisation and is a trap. Scratch's
 *        asset consumers assume they own the bytes: scratch-audio does
 *        `sound.data.buffer.slice(0)` (AudioEngine.js, _decodeSound), and other
 *        consumers do the same kind of thing. With a view, `.buffer` is the WHOLE
 *        container, so every sound copies the entire container. On the synthetic
 *        benchmark (30 sounds, 13.5 MB container) that turned a 2.2 s load into
 *        11.9 s. Copies are correct and, being a single container-sized memcpy
 *        amortised across the whole load, cheaper.
 * @returns {Promise<object>}
 */
const openBlpk = async (buffer, inflateRaw, options = {}) => {
  const view = new DataView(buffer);
  const totalBytes = options.length === undefined ? buffer.byteLength : options.length;

  if (totalBytes < BLPK_HEADER_SIZE) {
    throw new Error('BLPK: container is too small');
  }

  if (view.getUint8(0) !== 0x42 || view.getUint8(1) !== 0x4c ||
      view.getUint8(2) !== 0x50 || view.getUint8(3) !== 0x4b) {
    throw new Error('BLPK: bad magic (expected "BLPK")');
  }

  const version = view.getUint8(4);
  if (version !== 1) {
    throw new Error(`BLPK: unsupported version ${version}`);
  }

  const flags = view.getUint8(5);
  const indexLength = view.getUint32(8, true);
  if (BLPK_HEADER_SIZE + indexLength > totalBytes) {
    throw new Error('BLPK: index runs past the end of the container');
  }

  let indexBytes = new Uint8Array(buffer, BLPK_HEADER_SIZE, indexLength);
  if (flags & BLPK_FLAG_INDEX_DEFLATED) {
    indexBytes = await inflateRaw(indexBytes);
  }

  const index = JSON.parse(blpkTextDecoder.decode(indexBytes));
  const payloadOffset = BLPK_HEADER_SIZE + indexLength;
  const copyStored = options.copyStored !== false;

  // Memoised: a warm-up pass and the VM's later request for the same asset must
  // not pay for the same inflate twice.
  const cache = new Map();

  const readEntry = async (record) => {
    const offset = record[0];
    const length = record[1];
    const entryFlags = record[2];
    if (payloadOffset + offset + length > totalBytes) {
      throw new Error('BLPK: entry runs past the end of the container');
    }
    if (entryFlags) {
      // inflateRaw always returns a freshly allocated buffer, so it is already
      // owned and correctly sized; nothing to copy.
      return await inflateRaw(new Uint8Array(buffer, payloadOffset + offset, length), record[3]);
    }
    const start = payloadOffset + offset;
    return copyStored
      ? new Uint8Array(buffer.slice(start, start + length))
      : new Uint8Array(buffer, start, length);
  };

  const getAsset = async (name) => {
    if (cache.has(name)) return cache.get(name);
    const record = index.a[name];
    if (!record) return null;
    const value = await readEntry(record);
    cache.set(name, value);
    return value;
  };

  const assetNames = Object.keys(index.a);

  const container = {
    index,
    assetNames,
    payloadOffset,
    copyStored,
    totalBytes,
    getProject: () => readEntry(index.p),
    getAsset,
    readEntry,

    /** Names whose payload is deflate-compressed and therefore worth pre-warming. */
    deflatedAssetNames: assetNames.filter((name) => index.a[name][2] !== 0),
    isAssetDeflated: (name) => !!(index.a[name] && index.a[name][2]),

    /**
     * Decode every deflated payload up front. With native decompression these
     * run concurrently off the main thread, so the cost overlaps with the VM
     * parsing project.json instead of stalling asset-by-asset later on.
     */
    warmUp: () => {
      const jobs = [];
      for (const name of assetNames) {
        if (index.a[name][2] !== 0 && !cache.has(name)) jobs.push(getAsset(name));
      }
      return Promise.all(jobs);
    },

    stats: () => ({
      assets: assetNames.length,
      deflatedAssets: assetNames.filter((name) => index.a[name][2] !== 0).length,
      cachedAssets: cache.size,
      cachedBytes: Array.from(cache.values()).reduce((sum, bytes) => sum + bytes.byteLength, 0),
      copyStored
    })
  };

  if (options.preloadDeflated) await container.warmUp();

  return container;
};

// Dual target
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {openBlpk, BLPK_HEADER_SIZE, BLPK_FLAG_INDEX_DEFLATED};
}
