'use strict';

// In-page project source. Dual-target: the packager's tests drive it from Node
// (Node 18+ provides TextDecoder, Blob, Response and DecompressionStream, so the
// whole loader including the native inflate path is testable without a browser),
// and it is inlined verbatim into the produced HTML.
//
// Two modes:
//
//   'tw'   TurboWarp's own strategy: hand the raw .sb3 bytes to
//          Scaffolding.JSZip and let it unpack them, looking assets up by name
//          and inflating them with its pure-JS inflater as the VM asks for them.
//          Kept as the reference implementation for A/B measurement.
//
//   'fast' Open a BLPK container: one index parse, O(1) asset lookup, no zip
//          central directory, no zip entry objects, and no JS inflate for the
//          common case. Only entries that DEFLATE actually shrank are
//          decompressed, and those go through the platform's native
//          DecompressionStream (off the main thread) with a pure-JS fallback.

const createInflateRaw = () => {
  const hasNative = typeof DecompressionStream === 'function' &&
    typeof Blob === 'function' &&
    typeof Response === 'function';

  return async (bytes, expectedSize) => {
    if (hasNative && bytes.byteLength > 0) {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (error) {
        // A broken deflate stream would fail again in JS, but a missing/blocked
        // native codec is worth retrying, and deflate payloads are small.
      }
    }
    return localInflateRawJS()(bytes, expectedSize);
  };
};

const localInflateRawJS = () => {
  if (typeof inflateRawJS === 'function') return inflateRawJS;
  if (typeof module !== 'undefined' && module.exports) {
    return require('./inflate-raw.js').inflateRawJS;
  }
  throw new Error('no raw inflate implementation available');
};

// In the produced HTML this is a top-level const declared by the inlined
// container-reader.js, which shares the page's global lexical scope.
const localOpenBlpk = () => {
  if (typeof openBlpk === 'function') return openBlpk;
  if (typeof module !== 'undefined' && module.exports) {
    return require('./container-reader.js').openBlpk;
  }
  throw new Error('no BLPK reader available');
};

/**
 * @param {object} config
 * @param {'fast'|'tw'} config.mode
 * @param {object} config.storage      scaffolding.storage
 * @param {object} config.vm           scaffolding.vm
 * @param {() => {buffer: ArrayBuffer, length: number}} config.takePayload
 *        hands over the decoded buffer exactly once, with its true byte length
 *        (the decoder pads to a multiple of 4, so byteLength is not enough)
 * @param {object} [config.Scaffolding] needed by tw mode (Scaffolding.JSZip)
 * @param {(bytes: Uint8Array, expected?: number) => Promise<Uint8Array>} [config.inflateRaw]
 * @param {boolean} [config.copyAssets] fast mode: hand the VM buffers it owns,
 *        rather than views into the decoded container (default true — see
 *        container-reader.js for why the view shortcut backfires)
 * @param {boolean} [config.preload]    warm up compressed payloads in the background
 * @returns {{getProjectData: () => Promise<ArrayBuffer|Uint8Array>, warmUp: () => any, stats: () => object, assetLoads: () => number}}
 */
const createProjectSource = (config) => {
  const mode = config.mode === 'tw' ? 'tw' : 'fast';
  const storage = config.storage;
  const vm = config.vm;
  const takePayload = config.takePayload;
  const copyAssets = config.copyAssets === undefined ? true : !!config.copyAssets;
  const preload = !!config.preload;
  const inflateRaw = config.inflateRaw || createInflateRaw();

  let assetLoads = 0;

  /** @type {() => object} */
  let stats;

  if (mode === 'tw') {
    const JSZip = config.Scaffolding && config.Scaffolding.JSZip;
    if (!JSZip) {
      throw new Error('the tw loader needs Scaffolding.JSZip');
    }

    let zip = null;
    let opened = null;
    let warm = null;

    // Let the zip itself be collected once the VM no longer needs it.
    vm.runtime.on('PROJECT_LOADED', () => {
      zip = null;
    });

    // The regexp fallback tolerates one level of subdirectory. It scans every
    // entry, which is why a miss here is not cheap.
    const findFileInZip = (path) => zip.file(path) || zip.file(new RegExp('^([^/]*/)?' + path + '$'))[0];

    storage.addHelper({
      load: (assetType, assetId, dataFormat) => {
        if (!zip) {
          throw new Error('Zip is not loaded or has been closed');
        }
        assetLoads++;
        const path = assetId + '.' + dataFormat;
        const file = findFileInZip(path);
        if (!file) {
          console.error('Asset is not in zip: ' + path);
          return Promise.resolve(null);
        }
        return file.async('uint8array').then((data) => storage.createAsset(assetType, dataFormat, data, assetId));
      }
    });

    const ensureOpen = () => {
      if (!opened) {
        opened = (async () => {
          // Exact-length view: JSZip scans backwards for the end-of-central-
          // directory record, so trailing decoder padding must not be included.
          const payload = takePayload();
          zip = await JSZip.loadAsync(new Uint8Array(payload.buffer, 0, payload.length));
          const file = findFileInZip('project.json');
          if (!file) throw new Error('project.json is not in zip');
          return file.async('arraybuffer');
        })();
      }
      return opened;
    };

    stats = () => ({
      mode: 'tw',
      assetLoads,
      zipEntries: zip ? Object.keys(zip.files).length : 0
    });

    return {
      getProjectData: ensureOpen,
      warmUp: () => {
        if (!preload) return null;
        if (warm) return warm;
        warm = opened ? opened.then(() => {
          if (!zip) return null;
          const jobs = [];
          for (const name of Object.keys(zip.files)) {
            const entry = zip.files[name];
            if (entry.dir) continue;
            jobs.push(entry.async('uint8array'));
          }
          return Promise.all(jobs);
        }) : null;
        return warm;
      },
      stats,
      assetLoads: () => assetLoads
    };
  }

  // ---------------------------------------------------------------- fast ---
  const openContainer = localOpenBlpk();
  let containerPromise = null;
  let warm = null;

  const ensureOpen = () => {
    if (!containerPromise) {
      const payload = takePayload();
      containerPromise = openContainer(payload.buffer, inflateRaw, {
        length: payload.length,
        copyStored: copyAssets
      });
    }
    return containerPromise;
  };

  storage.addHelper({
    load: (assetType, assetId, dataFormat) => {
      assetLoads++;
      const name = assetId + '.' + dataFormat;
      return ensureOpen().then(async (container) => {
        // Ownership is settled by the container reader (copyStored), so the
        // returned bytes are handed over as-is — no second copy here.
        const bytes = await container.getAsset(name);
        if (!bytes) {
          console.error('Asset is not in container: ' + name);
          return null;
        }
        return storage.createAsset(assetType, dataFormat, bytes, assetId);
      });
    }
  });

  stats = () => {
    const base = {mode: 'fast', assetLoads, copyAssets, preload};
    if (!containerPromise) return base;
    return Object.assign(base, containerStats);
  };

  let containerStats = {};
  const collectStats = () => ensureOpen().then((container) => {
    containerStats = container.stats();
    containerStats.payloadOffset = container.payloadOffset;
    containerStats.totalBytes = container.totalBytes;
    return containerStats;
  });

  return {
    getProjectData: () => ensureOpen().then((container) => container.getProject()),

    // Fired as soon as project.json is available, i.e. while the VM is still
    // parsing it. With native async decompression the deflated payloads are
    // decoded concurrently off the main thread instead of one-at-a-time later.
    warmUp: () => {
      if (!preload) return null;
      if (warm) return warm;
      warm = ensureOpen().then((container) => container.warmUp()).then(collectStats);
      return warm;
    },

    stats,
    assetLoads: () => assetLoads
  };
};

// Dual target
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {createProjectSource, createInflateRaw};
}
