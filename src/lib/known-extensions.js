'use strict';

// Resolve extensions a project references without a URL and without a
// user-supplied source, by fetching the canonical source at pack time from a
// registry of well-known extensions. The packaged result stays fully offline:
// only the pack step may touch the network, and a failure degrades to the
// existing "this build needs a network" warning instead of failing the pack.
//
// This module is browser-safe (no node:* imports): the static-site build
// bundles it too, where fetch still works against the galleries because they
// send `Access-Control-Allow-Origin: *`.

const {readZip} = require('./zip');
const {declaredStrings} = require('./extensions');

// scratch-vm ships these; the packaged runtime already has their code, so no
// source is needed for them.
const BUILT_IN_EXTENSION_IDS = new Set([
  'pen', 'music', 'videoSensing', 'text2speech', 'translate',
  'makeymakey', 'microbit', 'ev3', 'wedo2', 'boost', 'gdxfor'
]);

// id -> canonical source URL. Every entry has been verified to declare exactly
// that id in its getInfo() (checked against the source at the URL). The editor
// galleries publish the id <-> slug mapping that same check uses:
//   extensions.turbowarp.org/generated-metadata/extensions-v0.json
//   extensions.bilup.org/generated-metadata/extensions-v0.json
// Additions must pass that check: a wrong source would silently register an
// extension under a different id and leave the project's blocks dead.
const KNOWN_EXTENSIONS = Object.freeze({
  // TurboWarp gallery (extensions.turbowarp.org)
  stretch: 'https://extensions.turbowarp.org/stretch.js',
  MouseCursor: 'https://extensions.turbowarp.org/cursor.js',
  jeremygamerTweening: 'https://extensions.turbowarp.org/JeremyGamer13/tween.js',
  lmsclonesplus: 'https://extensions.turbowarp.org/Lily/ClonesPlus.js',
  text: 'https://extensions.turbowarp.org/lab/text.js',
  Gamepad: 'https://extensions.turbowarp.org/gamepad.js',
  pointerlock: 'https://extensions.turbowarp.org/pointerlock.js',
  files: 'https://extensions.turbowarp.org/files.js',
  fetch: 'https://extensions.turbowarp.org/fetch.js',
  localstorage: 'https://extensions.turbowarp.org/local-storage.js',
  runtimeoptions: 'https://extensions.turbowarp.org/runtime-options.js',
  utilities: 'https://extensions.turbowarp.org/utilities.js',
  iframe: 'https://extensions.turbowarp.org/iframe.js',
  clipboard: 'https://extensions.turbowarp.org/clipboard.js',
  betterpen: 'https://extensions.turbowarp.org/penplus.js',
  navigatorinfo: 'https://extensions.turbowarp.org/navigator.js',
  griffpatch: 'https://extensions.turbowarp.org/box2d.js',
  // Bilup gallery (extensions.bilup.org)
  stringtools: 'https://extensions.bilup.org/stringtools.js',
  easyblock: 'https://extensions.bilup.org/easyblock.js',
  approaches: 'https://extensions.bilup.org/approaches.js',
  colortools: 'https://extensions.bilup.org/colortools.js',
  xiaoboluotoolbox: 'https://extensions.bilup.org/xiaoboluotoolbox.js',
  leishen: 'https://extensions.bilup.org/leishen.js',
  aiblocks: 'https://extensions.bilup.org/aiblocks.js'
});

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;

const basenameOf = (name) => {
  const slash = String(name).lastIndexOf('/');
  return slash === -1 ? name : name.slice(slash + 1);
};

// Same rule as src/lib/sb3.js: some archives wrap everything in one directory.
const findProjectEntry = (entries) => {
  if (entries.has('project.json')) return 'project.json';
  const candidates = [];
  for (const name of entries.keys()) {
    if (basenameOf(name) === 'project.json') candidates.push(name);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(`ambiguous sb3: ${candidates.length} project.json entries found`);
  }
  return null;
};

/**
 * Read just the extension-related fields of project.json. Cheaper than
 * loadSb3(): no block renumbering, no PNG work — this only needs the ids the
 * VM will ask the extension manager for.
 */
const readProjectExtensionIds = (input) => {
  const entries = readZip(input);
  const projectEntryName = findProjectEntry(entries);
  if (!projectEntryName) return {extensions: [], extensionURLs: {}};
  let projectData;
  try {
    projectData = JSON.parse(entries.get(projectEntryName).data.toString('utf8'));
  } catch (error) {
    throw new Error(`not an sb3: project.json could not be parsed (${error.message})`);
  }
  return {
    extensions: Array.isArray(projectData.extensions) ? projectData.extensions : [],
    extensionURLs: projectData.extensionURLs || {}
  };
};

const nameFromUrl = (url) => {
  try {
    const parsed = new URL(url);
    return basenameOf(parsed.pathname) || `${parsed.hostname}.js`;
  } catch {
    return 'extension.js';
  }
};

const fetchSource = async (url, fetchImpl) => {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch available in this build');
  const response = await fetchImpl(url, {signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const source = await response.text();
  if (source.length > MAX_SOURCE_BYTES) {
    throw new Error(`source is ${source.length} bytes; the limit is ${MAX_SOURCE_BYTES}`);
  }
  return source;
};

/**
 * Fetch sources for every extension the project needs but whose code is not
 * already guaranteed:
 *
 *   1. ids with an http(s) URL in project.json's extensionURLs — the project
 *      names the URL, so that exact URL is fetched once at pack time (the
 *      project's pinned version wins over the registry);
 *   2. ids with no URL at all (TurboWarp, Bilup and other editors register a
 *      known set of extensions without writing URLs) — resolved through
 *      KNOWN_EXTENSIONS.
 *
 * Built-ins are skipped, and ids the user already supplied a source for are
 * left alone (their declared id — or, failing that, their file name — marks
 * them as covered).
 *
 * @param {Buffer|Uint8Array} input raw sb3 bytes
 * @param {{provided?: {name?, source}[]}} [options]
 * @returns {Promise<{sources: {name, source, origin}[], resolved: {id, url}[],
 *                    missing: string[]}>}
 */
const resolveMissingExtensions = async (input, options = {}) => {
  const {onWarn = () => {}, fetchImpl = globalThis.fetch, provided = []} = options;
  const {extensions, extensionURLs} = readProjectExtensionIds(input);

  // An id a provided source declares is covered: fetching it again would be
  // wasted work, and a *failed* second fetch must not mark it missing — the
  // user's own source is what bakes it.
  const covered = new Set();
  for (const entry of provided) {
    if (!entry || typeof entry.source !== 'string') continue;
    for (const value of declaredStrings(entry.source)) covered.add(value);
    const stem = String(entry.name || '').replace(/\.[^.]+$/, '');
    if (stem) covered.add(stem);
  }

  const targets = [];
  const seen = new Set();
  for (const id of extensions) {
    if (!id || BUILT_IN_EXTENSION_IDS.has(id) || covered.has(id) || seen.has(id)) continue;
    seen.add(id);
    const url = extensionURLs[id];
    if (typeof url === 'string' && /^https?:/i.test(url)) {
      targets.push({id, url});
    } else if (!url) {
      const known = KNOWN_EXTENSIONS[id];
      if (known) targets.push({id, url: known});
    }
  }

  const sources = [];
  const resolved = [];
  const missing = [];
  for (const {id, url} of targets) {
    try {
      const source = await fetchSource(url, fetchImpl);
      sources.push({name: nameFromUrl(url), source, origin: url});
      resolved.push({id, url});
    } catch (error) {
      missing.push(id);
      onWarn(`extension "${id}": could not fetch ${url} (${error.message}); ` +
        (extensionURLs[id]
          ? 'the packaged project will need a network for it'
          : 'pass its source with --extension to bake it in'));
    }
  }

  return {sources, resolved, missing};
};

module.exports = {
  BUILT_IN_EXTENSION_IDS,
  KNOWN_EXTENSIONS,
  readProjectExtensionIds,
  resolveMissingExtensions
};
