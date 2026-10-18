'use strict';

// Node-only: turn `--extension` arguments into `{name, source}` pairs.
//
// A spec is either a path to a .js file or an http(s) URL. The URL case is the
// one TurboWarp's UI does by default (`bakeExtensions` fetches every http(s)
// entry), and it is worth having here for a different reason: projects reference
// extensions by URL, so "the URL from project.json" is the most likely thing a
// user has in hand. It is a *pack-time* fetch of a URL the user named — the
// packaged result never goes back to the network for it.
//
// This module is deliberately not reachable from src/lib/pipeline.js: the static
// site bundles that module graph into a browser worker, where `fetch` of another
// origin is a CORS lottery and there is no filesystem at all. The browser front
// end reads the user's own files instead.

const fs = require('node:fs');
const path = require('node:path');

/** Upstream caps nothing; a 40 MB "extension" is a mistake, not a feature. */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;

const isUrl = (spec) => /^https?:\/\//i.test(String(spec || ''));

const nameFromUrl = (url) => {
  try {
    const parsed = new URL(url);
    const base = parsed.pathname.split('/').filter(Boolean).pop();
    return base || `${parsed.hostname}.js`;
  } catch {
    return 'extension.js';
  }
};

/**
 * @param {string} spec path or URL
 * @returns {Promise<{name: string, source: string, origin: string}>}
 */
const loadExtension = async (spec, options = {}) => {
  const {fetchImpl = globalThis.fetch} = options;
  const text = String(spec || '');
  if (!text) throw new Error('empty extension spec');

  if (isUrl(text)) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('this Node has no fetch(); pass a local file instead');
    }
    let response;
    try {
      response = await fetchImpl(text, {signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)});
    } catch (error) {
      throw new Error(`could not download ${text}: ${error.message}`);
    }
    if (!response.ok) throw new Error(`could not download ${text}: HTTP ${response.status}`);
    const source = await response.text();
    if (source.length > MAX_SOURCE_BYTES) {
      throw new Error(`${text} is ${source.length} bytes; the limit is ${MAX_SOURCE_BYTES}`);
    }
    return {name: nameFromUrl(text), source, origin: text};
  }

  const absolute = path.resolve(text);
  if (!fs.existsSync(absolute)) throw new Error(`extension file not found: ${absolute}`);
  const bytes = fs.readFileSync(absolute);
  if (bytes.length > MAX_SOURCE_BYTES) {
    throw new Error(`${absolute} is ${bytes.length} bytes; the limit is ${MAX_SOURCE_BYTES}`);
  }
  return {name: path.basename(absolute), source: bytes.toString('utf8'), origin: absolute};
};

/** @param {string[]} specs @returns {Promise<{name, source, origin}[]>} */
const loadExtensions = async (specs = [], options = {}) => {
  const out = [];
  for (const spec of specs) out.push(await loadExtension(spec, options));
  return out;
};

/**
 * Merge what the option file lists with what the flags named.
 *
 * Two shapes are accepted because two front ends produce them: a string is a
 * path or URL (CLI flags, and anything hand-written), an object carrying
 * `source` is already-loaded content (the web UI's in-memory state, and the
 * shape `--options` gets if someone pastes an exported file back in).
 *
 * @param {object} optionSet result of pipeline.loadOptionSet()
 * @param {(string|object)[]} extra entries from flags
 */
const collectExtensions = async (optionSet = {}, extra = [], options = {}) => {
  const fromFile = Array.isArray(optionSet.extensions) ? optionSet.extensions : [];
  const all = [...fromFile, ...extra];
  const inline = all.filter((entry) => entry && typeof entry === 'object' &&
    typeof entry.source === 'string');
  const specs = all.filter((entry) => typeof entry === 'string');
  return [...inline, ...(await loadExtensions(specs, options))];
};

module.exports = {loadExtension, loadExtensions, collectExtensions, isUrl, MAX_SOURCE_BYTES};
