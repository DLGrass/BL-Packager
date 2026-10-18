'use strict';

// Baking custom extensions into a packaged project, so an offline build can
// still start.
//
// The problem this solves is the one README §7 calls the most common reason a
// packaged project "does not open": a project's project.json carries
// `extensionURLs: {id: url}`, the VM resolves them at load time with
// `extensionManager.loadExtensionURL(url)`, and a packaged page has no network.
// TurboWarp's packager solves it with the same two steps implemented here:
//
//   1. wrap the source in an IIFE that takes `Scratch` as its argument, so an
//      extension written for the sandbox cannot leak globals into the page, and
//      turn it into a `data:` URL (the only scheme Scaffolding's
//      `_isValidExtensionURL` accepts besides http/https/file — `blob:` throws
//      "Invalid extension URL", which is why this is not a blob URL);
//   2. put that data URL where the VM will look for it.
//
// Step 2 is done twice on purpose. Upstream only loads the baked URLs eagerly,
// leaving project.json's https URL in place; here the map entry is *also*
// replaced when the extension's id can be identified, so the VM never reaches
// for the network even if the eager load did not happen first. The eager load is
// what actually makes it work — see the comment in bakeExtensions().
//
// Sources arrive as `{name, source}`. Reading a file, or downloading a URL, is
// the caller's job — the browser build has no filesystem and the point of this
// module is that it runs identically in both.

const WRAP_PREFIX = '(function(Scratch) {';
const WRAP_SUFFIX = '})(Scratch);';

/** Same wrapper as upstream: an extension must not rely on leaking globals. */
const wrapExtensionSource = (source) => `${WRAP_PREFIX}\n${source}\n${WRAP_SUFFIX}`;

/** `data:` payloads are compared by length; base64 wins on average, percent on tiny sources. */
const base64DataUri = (text) =>
  `data:text/javascript;base64,${Buffer.from(text, 'utf8').toString('base64')}`;
const percentDataUri = (text) =>
  `data:text/javascript;charset=utf-8,${encodeURIComponent(text)}`;

const encodeExtension = (source) => {
  const wrapped = wrapExtensionSource(String(source));
  const candidates = [base64DataUri(wrapped), percentDataUri(wrapped)];
  return candidates[0].length <= candidates[1].length ? candidates[0] : candidates[1];
};

const isDataUri = (value) => /^data:/i.test(String(value || ''));

/**
 * Every short string literal in the source, which is how an extension's own id
 * is found without parsing JavaScript: `getInfo() { return {id: 'myExtension'} }`.
 * Intersecting this set with the ids project.json actually needs is what makes
 * the match trustworthy — a random string in a comment cannot collide with a
 * project's extension id and be picked by accident twice.
 */
const declaredStrings = (source) => {
  const out = new Set();
  const literal = /(['"`])((?:\\.|(?!\1)[^\\\r\n]){1,80})\1/g;
  const text = String(source);
  let match;
  while ((match = literal.exec(text)) !== null) {
    const value = match[2];
    // A template literal with interpolation is not an id; neither is a long
    // string (ids are short, and `%20`-style noise only makes false positives).
    if (value.includes('${') || value.includes('\n')) continue;
    out.add(value);
  }
  return out;
};

const stemOf = (name) => String(name || '').replace(/\.[^.]+$/, '').split(/[\\/]/).pop();

/**
 * Decide which project extension a source replaces.
 *
 * Order matters: an id the source *declares* and the project *needs* is proof;
 * a file called `myExtension.js` matching id `myExtension` is a convention; the
 * one-leftover case is a last resort so a single opaque file still works.
 *
 * @param {string} source the extension's JavaScript
 * @param {string} [name] the file name, used for the convention check
 * @param {string[]} neededIds ids project.json still points at a URL for
 */
const matchExtension = (source, name, neededIds) => {
  const declared = declaredStrings(source);
  const hits = neededIds.filter((id) => declared.has(id));
  if (hits.length === 1) return {id: hits[0], how: 'declares'};

  const stem = stemOf(name || '');
  if (stem) {
    const byName = neededIds.filter((id) => id.toLowerCase() === stem.toLowerCase());
    if (byName.length === 1) return {id: byName[0], how: 'filename'};
  }
  return null;
};

/**
 * Rewrite a loaded project so its extensions resolve without a network.
 *
 * @param {object} project result of loadSb3()
 * @param {{name?: string, source: string}[]} sources
 * @param {{onWarn?: (message: string) => void}} [options]
 * @returns {{urls: object, eager: string[], report: object[], remote: string[],
 *            changed: boolean}}
 *   `urls` is the extensionURLs map to put back on project.json, `eager` holds
 *   data URLs for extensions the project never referenced (they still have to
 *   be registered), `remote` lists ids that are still only reachable online.
 */
const bakeExtensions = (project, sources = [], options = {}) => {
  const {onWarn = () => {}} = options;
  const data = (project && project.projectData) || {};
  const urls = Object.assign({}, data.extensionURLs || {});
  const remaining = Object.keys(urls).filter((id) => !isDataUri(urls[id]));

  const report = [];
  // Every baked source is also loaded explicitly after boot, even when its id
  // was found and its project.json entry replaced. Two reasons, both learned the
  // hard way:
  //
  //   * Scaffolding's `_loadExtensions()` iterates the ids the *blocks* use, not
  //     project.json's `extensions` array. An extension the project lists but no
  //     block calls is therefore never loaded — and a project with no blocks at
  //     all is the extreme case of that.
  //   * loading it first makes the map entry a fallback rather than the primary
  //     path, which is the order upstream uses (`options.extensions` is loaded
  //     eagerly, full stop).
  //
  // Loading the same URL twice is a no-op: `isExtensionURLLoaded()` short-cuts
  // it, and `isExtensionLoaded(id)` short-cuts the map lookup afterwards.
  const eager = [];
  const unmatched = [];

  for (const entry of sources) {
    if (!entry || typeof entry.source !== 'string' || !entry.source.trim()) {
      onWarn(`extension ${(entry && entry.name) || '(unnamed)'} has no source; skipped`);
      continue;
    }
    const uri = encodeExtension(entry.source);
    eager.push(uri);
    const match = matchExtension(entry.source, entry.name, remaining);
    if (!match) {
      unmatched.push({entry, uri});
      continue;
    }
    urls[match.id] = uri;
    remaining.splice(remaining.indexOf(match.id), 1);
    report.push({
      name: entry.name || `${match.id}.js`,
      id: match.id,
      how: match.how,
      bytes: entry.source.length,
      uriBytes: uri.length
    });
  }

  // One opaque file and one unfilled id: pair them. Guessing is only acceptable
  // when there is exactly one way to guess, so anything else stays unmatched.
  if (unmatched.length === 1 && remaining.length === 1) {
    const [{entry, uri}] = unmatched.splice(0, 1);
    urls[remaining[0]] = uri;
    report.push({
      name: entry.name || `${remaining[0]}.js`,
      id: remaining[0],
      how: 'only-one-left',
      bytes: entry.source.length,
      uriBytes: uri.length
    });
    remaining.length = 0;
  }

  for (const {entry} of unmatched) {
    report.push({
      name: entry.name || 'extension.js',
      id: null,
      how: 'eager',
      bytes: entry.source.length,
      uriBytes: encodeExtension(entry.source).length
    });
    onWarn(`${entry.name || 'extension'} does not declare an id this project uses; ` +
      'it is loaded eagerly instead of replacing a project.json entry');
  }

  for (const id of remaining) {
    onWarn(`extension "${id}" is still loaded from ${urls[id]} — the packaged project ` +
      'needs a network for it. Pass its source with --extension to bake it in.');
  }

  return {urls, eager, report, remote: remaining, changed: report.length > 0};
};

/**
 * Apply the result of bakeExtensions() in place, so every downstream step
 * (container, zip, exe) sees the rewritten project.json without knowing that
 * extensions exist.
 *
 * @returns {{report: object[], eager: string[], remote: string[]}}
 */
const applyBakedExtensions = (project, sources = [], options = {}) => {
  const baked = bakeExtensions(project, sources, options);
  if (baked.changed) {
    project.projectData.extensionURLs = baked.urls;
    project.projectJSONBytes = Buffer.from(JSON.stringify(project.projectData), 'utf8');
    if (project.analysis) {
      project.analysis.extensionURLs = baked.urls;
      project.analysis.projectJSONBytes = project.projectJSONBytes.length;
      project.analysis.bakedExtensions = baked.report;
      project.analysis.remoteExtensions = baked.remote;
    }
  }
  return {report: baked.report, eager: baked.eager, remote: baked.remote};
};

module.exports = {
  bakeExtensions,
  applyBakedExtensions,
  encodeExtension,
  declaredStrings,
  matchExtension,
  isDataUri,
  wrapExtensionSource
};
