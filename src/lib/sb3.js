'use strict';

// Load a .sb3 into something the packager can embed, and trim it the way
// TurboWarp does before embedding.
//
// Ported from TurboWarp/packager:
//   src/packager/download-project.js (mutateScratch3InPlace / analyzeScratch3)
//   src/packager/minify/sb3.js       (optimizeSb3Json)

const {readZip} = require('./zip');
const {recompressPng} = require('./png');
const {createHash} = require('node:crypto');

// ---------------------------------------------------------------------------
// project.json optimization
// ---------------------------------------------------------------------------

// Numeric ids are deliberately not used: their enumeration order affects script
// execution order because integer-like keys always come first.
// https://tc39.es/ecma262/#sec-ordinaryownpropertykeys
const SOUP = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#%()*+,-./:;=?@[]^_`{|}~';

const generateId = (i) => {
  let str = '';
  while (i >= 0) {
    str = SOUP[i % SOUP.length] + str;
    i = Math.floor(i / SOUP.length) - 1;
  }
  return str;
};

class Pool {
  constructor () {
    this.generatedIds = new Map();
    this.references = new Map();
    this.skippedIds = new Set();
    // Ids in Object.keys(vm.runtime.monitorBlocks._blocks) already have meaning.
    this.skippedIds.add('of');
  }
  addReference (id) {
    this.references.set(id, (this.references.get(id) || 0) + 1);
  }
  generateNewIds () {
    // Most-referenced ids get the shortest names.
    const entries = Array.from(this.references.entries()).sort((a, b) => b[1] - a[1]);
    let i = 0;
    for (const [oldId] of entries) {
      let newId = generateId(i);
      while (this.skippedIds.has(newId)) {
        i++;
        newId = generateId(i);
      }
      this.generatedIds.set(oldId, newId);
      i++;
    }
  }
  getNewId (originalId) {
    return this.generatedIds.has(originalId) ? this.generatedIds.get(originalId) : originalId;
  }
}

/**
 * Rewrites the project in place. Semantically equivalent, materially smaller.
 * @param {object} projectData
 */
const optimizeSb3Json = (projectData) => {
  const blockPool = new Pool();

  for (const target of projectData.targets) {
    for (const [blockId, block] of Object.entries(target.blocks)) {
      blockPool.addReference(blockId);
      if (Array.isArray(block)) continue;
      if (block.parent) blockPool.addReference(block.parent);
      if (block.next) blockPool.addReference(block.next);
      if (block.inputs) {
        for (const input of Object.values(block.inputs)) {
          for (let i = 1; i < input.length; i++) {
            if (typeof input[i] === 'string') blockPool.addReference(input[i]);
          }
        }
      }
    }
  }

  blockPool.generateNewIds();

  if (projectData.monitors) {
    for (const monitor of projectData.monitors) {
      // Monitor values are re-derived at runtime; keeping them is pure weight.
      monitor.value = Array.isArray(monitor.value) ? [] : 0;
    }
  }

  for (const target of projectData.targets) {
    const newBlocks = {};
    const newComments = {};

    for (const [blockId, block] of Object.entries(target.blocks)) {
      newBlocks[blockPool.getNewId(blockId)] = block;
      if (Array.isArray(block)) continue;

      if (block.parent) block.parent = blockPool.getNewId(block.parent);
      if (block.next) block.next = blockPool.getNewId(block.next);

      if (block.inputs) {
        for (const input of Object.values(block.inputs)) {
          for (let i = 1; i < input.length; i++) {
            if (typeof input[i] === 'string') input[i] = blockPool.getNewId(input[i]);
          }
        }
      }

      if (!block.shadow) delete block.shadow;
      if (!block.topLevel) delete block.topLevel;
      delete block.x;
      delete block.y;
      delete block.comment;
    }

    if (target.comments) {
      for (const [commentId, comment] of Object.entries(target.comments)) {
        const text = comment.text || '';
        // Only comments that carry packager/addon configuration survive.
        if (text.includes(' // _twconfig_') || text.includes(' // _gamepad_')) {
          newComments[commentId] = comment;
        }
      }
    }

    target.blocks = newBlocks;
    target.comments = newComments;
  }

  if (projectData.meta) {
    delete projectData.meta.agent;
    delete projectData.meta.vm;
  }

  return projectData;
};

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

const ASSET_NAME = /^([0-9a-f]{32}|[0-9a-zA-Z]+)\.([a-z0-9]+)$/i;

const basename = (name) => {
  const slash = name.lastIndexOf('/');
  return slash === -1 ? name : name.slice(slash + 1);
};

/**
 * Some archives wrap everything in one directory (TurboWarp keeps a fixture for
 * exactly this case: "this is a subdirectory/project.json"). Resolve the real
 * entry name rather than assuming the root.
 */
const findProjectEntry = (entries) => {
  if (entries.has('project.json')) return 'project.json';
  const candidates = [];
  for (const name of entries.keys()) {
    if (basename(name) === 'project.json') candidates.push(name);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(`ambiguous sb3: ${candidates.length} project.json entries found`);
  }
  return null;
};

/**
 * Asset filenames are the md5 of their own contents, so re-writing the bytes
 * means the name has to move with them — otherwise every costume in the project
 * would point at a hash that no longer describes its data.
 */
const renameAssets = (projectData, renames) => {
  for (const target of projectData.targets) {
    for (const list of [target.costumes, target.sounds]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item || !item.md5ext || !renames.has(item.md5ext)) continue;
        const next = renames.get(item.md5ext);
        item.md5ext = next;
        if (item.assetId) item.assetId = next.replace(/\.[^.]+$/, '');
      }
    }
  }
};

/**
 * @param {Buffer|Uint8Array} input raw .sb3 bytes
 * @param {{optimize?: boolean, optimizePng?: boolean}} [options]
 */
const loadSb3 = (input, options = {}) => {
  const optimize = options.optimize !== false;
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const entries = readZip(bytes);

  const projectEntryName = findProjectEntry(entries);
  if (!projectEntryName) {
    throw new Error('not an sb3: project.json is missing from the archive');
  }
  const projectEntry = entries.get(projectEntryName);

  const projectData = JSON.parse(projectEntry.data.toString('utf8'));
  const stage = projectData.targets && projectData.targets.find((t) => t.isStage);
  if (!stage) {
    throw new Error('not a valid sb3: no stage target');
  }

  // A variable whose name starts with the cloud symbol is a cloud variable even
  // if the isCloud flag was never set.
  for (const variable of Object.values(stage.variables || {})) {
    if (typeof variable[0] === 'string' && variable[0].startsWith('\u2601')) {
      variable[2] = true;
    }
  }

  const assets = new Map();
  let assetBytes = 0;
  for (const [name, entry] of entries) {
    if (name === projectEntryName) continue;
    // Match on the basename: scratch-vm always asks for "<md5>.<ext>", and the
    // archive is allowed to keep assets one level down.
    if (!ASSET_NAME.test(basename(name))) continue;
    assets.set(name, entry.data);
    assetBytes += entry.data.length;
  }

  if (optimize) optimizeSb3Json(projectData);

  // Losslessly re-encode PNG assets. Weights the asset name along with the
  // bytes, because a Scratch asset name is its own md5.
  const png = {optimized: 0, before: 0, after: 0};
  if (options.optimizePng) {
    const renames = new Map();
    const rewritten = [];
    for (const [name, data] of assets) {
      if (!/\.png$/i.test(name)) continue;
      const smaller = recompressPng(data);
      if (!smaller) continue;
      const base = basename(name);
      const nextBase = createHash('md5').update(smaller).digest('hex') + base.slice(base.lastIndexOf('.'));
      renames.set(base, nextBase);
      rewritten.push([name, name.slice(0, name.length - base.length) + nextBase, smaller]);
      png.optimized++;
      png.before += data.length;
      png.after += smaller.length;
    }
    for (const [oldName, newName, bytes] of rewritten) {
      assets.delete(oldName);
      assets.set(newName, bytes);
    }
    if (renames.size) renameAssets(projectData, renames);
    let total = 0;
    for (const data of assets.values()) total += data.length;
    assetBytes = total;
  }

  const projectJSONBytes = Buffer.from(JSON.stringify(projectData), 'utf8');

  return {
    type: 'sb3',
    originalBytes: bytes,
    projectData,
    projectJSONBytes,
    assets,
    analysis: {
      usesMusic: (projectData.extensions || []).includes('music'),
      extensions: Array.from(projectData.extensions || []),
      extensionURLs: projectData.extensionURLs || {},
      rootPrefix: projectEntryName === 'project.json' ? '' : projectEntryName.replace(/project\.json$/, ''),
      targetCount: projectData.targets.length,
      assetCount: assets.size,
      assetBytes,
      projectJSONBytes: projectJSONBytes.length,
      originalBytes: bytes.length,
      png
    }
  };
};

module.exports = {loadSb3, optimizeSb3Json, SOUP, generateId};
