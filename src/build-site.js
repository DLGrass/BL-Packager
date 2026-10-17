'use strict';

// Builds the static site in site/: index.html + app.js + local-api.js +
// worker.js + favicon.svg.
//
// There is no bundler dependency here on purpose -- the rest of this repository
// has none either, and what is needed is small: walk the require() graph of
// src/lib from pipeline.js, wrap each module in a function, and provide the four
// Node builtins the packing code touches (fs, path, zlib, crypto). The result is
// a classic script, so a Worker can pull it in with importScripts and the page
// can stay a plain file.
//
//   node src/build-site.js          -> site/
//   node src/build-site.js --check  -> build, then assert the invariants below
//
// The site is a generated directory and is not committed; see .gitignore.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'site');
const ENTRY = 'src/lib/pipeline.js';

// Extra modules that are not reachable through require() but that the bundle
// needs anyway: inflate-raw is what the zlib shim decodes with, and client is
// the entry the generated bootstrap calls.
const SEEDS = [
  'src/lib/bytes.js',
  'src/lib/deflate.js',
  'src/lib/md5.js',
  'src/runtime/inflate-raw.js',
  'src/site/client.js'
];

// Source text that src/lib reads with fs at render time. In the browser there is
// no fs, so the bundle serves them from a virtual file system keyed by basename.
const VFS_FILES = [
  'vendor/scaffolding-min.js',
  'vendor/scaffolding-full.js',
  'src/runtime/inflate-raw.js',
  'src/runtime/container-reader.js',
  'src/runtime/loader.js'
];

const REQUIRE_CALL = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;

const toId = (absolute) => path.relative(ROOT, absolute).split(path.sep).join('/');

const resolveSpec = (fromId, spec) => {
  const base = fromId.slice(0, fromId.lastIndexOf('/'));
  const parts = (base + '/' + spec).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  let id = out.join('/');
  if (!/\.js$/.test(id)) id += '.js';
  return id;
};

/** Walk require() from the entry and return {id: source} for everything reached. */
const collect = () => {
  const modules = {};
  const builtins = new Set();
  const queue = [ENTRY, ...SEEDS];

  while (queue.length > 0) {
    const id = queue.shift();
    if (modules[id]) continue;
    const absolute = path.join(ROOT, id);
    if (!fs.existsSync(absolute)) throw new Error(`missing module ${id}`);
    const source = fs.readFileSync(absolute, 'utf8');
    modules[id] = source;

    REQUIRE_CALL.lastIndex = 0;
    let match;
    while ((match = REQUIRE_CALL.exec(source)) !== null) {
      const spec = match[2];
      if (spec.startsWith('.')) {
        queue.push(resolveSpec(id, spec));
      } else {
        builtins.add(spec);
      }
    }
  }

  return {modules, builtins: [...builtins].sort()};
};

const readVfs = () => {
  const files = {};
  for (const relative of VFS_FILES) {
    const absolute = path.join(ROOT, relative);
    if (!fs.existsSync(absolute)) continue;
    // Keyed by basename: every reader in src/lib resolves a path and then asks
    // for it, and basenames are unique across the five files that are read.
    files[path.basename(relative)] = fs.readFileSync(absolute, 'utf8');
  }
  return files;
};

// The runtime shims. Each one is the smallest thing that satisfies src/lib:
// fs only ever reads; zlib only ever deflates or inflates; crypto only makes md5.
const SHIM_SOURCE = `
const pathShim = {
  join: function () {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) if (arguments[i]) parts.push(String(arguments[i]));
    return pathShim.normalize(parts.join('/'));
  },
  normalize: function (value) {
    const parts = String(value).split('/');
    const out = [];
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return (value.charAt(0) === '/' ? '/' : '') + out.join('/');
  },
  resolve: function (value) {
    const text = String(value);
    return text.charAt(0) === '/' ? pathShim.normalize(text) : pathShim.normalize('/' + text);
  },
  basename: function (value, ext) {
    const parts = String(value).split('/');
    let name = parts[parts.length - 1] || '';
    if (ext && name.slice(-ext.length) === ext) name = name.slice(0, -ext.length);
    return name;
  },
  dirname: function (value) {
    const text = String(value).replace(/\\/+$/, '');
    const at = text.lastIndexOf('/');
    return at <= 0 ? '/' : text.slice(0, at);
  },
  extname: function (value) {
    const name = pathShim.basename(value);
    const at = name.lastIndexOf('.');
    return at <= 0 ? '' : name.slice(at);
  }
};

const vfsHas = (target) => Object.prototype.hasOwnProperty.call(VFS, pathShim.basename(target));
const vfsRead = (target) => {
  const name = pathShim.basename(target);
  if (vfsHas(name)) return VFS[name];
  throw new Error('the browser build only ships ' + Object.keys(VFS).join(', ') +
    '; it was asked for ' + target);
};

const shims = {};
const builtin = (spec) => {
  if (shims[spec]) return shims[spec];
  let value;

  if (spec === 'node:fs') {
    value = {
      readFileSync: vfsRead,
      existsSync: vfsHas,
      writeFileSync: () => { throw new Error('the browser build cannot write files'); },
      mkdirSync: () => { throw new Error('the browser build cannot write files'); },
      statSync: () => { throw new Error('the browser build cannot stat files'); }
    };
  } else if (spec === 'node:path') {
    value = pathShim;
  } else if (spec === 'node:zlib') {
    const deflate = load('src/lib/deflate.js');
    const inflate = load('src/runtime/inflate-raw.js');
    const toBytes = (input) => (input instanceof Uint8Array ? input : new Uint8Array(input));
    value = {
      deflateRawSync: (input) => Buffer.from(deflate.deflateRaw(toBytes(input))),
      deflateSync: (input) => Buffer.from(deflate.deflateZlib(toBytes(input))),
      inflateRawSync: (input) => Buffer.from(inflate.inflateRawJS(toBytes(input))),
      inflateSync: (input) => {
        // A zlib stream is a two-byte header, deflate data, then Adler-32.
        const bytes = toBytes(input);
        return Buffer.from(inflate.inflateRawJS(bytes.subarray(2, bytes.length - 4)));
      },
      gzipSync: () => { throw new Error('gzip is not available in the browser build'); },
      constants: {Z_DEFAULT_STRATEGY: 0, Z_FILTERED: 1, Z_RLE: 3, Z_DEFAULT_COMPRESSION: -1}
    };
  } else if (spec === 'node:crypto') {
    const md5 = load('src/lib/md5.js');
    value = {createHash: (algorithm) => {
      if (algorithm !== 'md5') throw new Error(algorithm + ' is not available in the browser build');
      return md5.createHash();
    }};
  } else if (spec === 'node:child_process') {
    value = {spawnSync: () => { throw new Error('the browser build cannot spawn processes'); }};
  } else {
    throw new Error('the browser build has no shim for ' + spec);
  }

  shims[spec] = value;
  return value;
};
`;

const build = () => {
  const {modules, builtins} = collect();
  const vfs = readVfs();
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

  const parts = [];
  parts.push('/* Generated by src/build-site.js -- do not edit. */');
  parts.push('/* The whole packing pipeline, plus the browser-side codecs it needs. */');
  parts.push('(function () {');
  parts.push("'use strict';");
  parts.push(`const VERSION = ${JSON.stringify(version)};`);
  parts.push(`const VFS = ${JSON.stringify(vfs)};`);

  parts.push('const factories = {};');
  for (const id of Object.keys(modules).sort()) {
    parts.push(`factories[${JSON.stringify(id)}] = function (module, exports, require, __dirname, __filename) {`);
    parts.push(modules[id]);
    parts.push('};');
  }

  parts.push('const cache = {};');
  parts.push(`
const resolveId = (fromId, spec) => {
  const base = fromId.slice(0, fromId.lastIndexOf('/'));
  const parts = (base + '/' + spec).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  let id = out.join('/');
  if (!/\\.js$/.test(id)) id += '.js';
  return id;
};

function load(id) {
  if (cache[id]) return cache[id].exports;
  const factory = factories[id];
  if (!factory) throw new Error('module not found: ' + id);
  const module = {exports: {}};
  cache[id] = module;
  const dir = '/' + (id.indexOf('/') === -1 ? '' : id.slice(0, id.lastIndexOf('/')));
  const requireFor = (spec) => (spec.charAt(0) === '.' ? load(resolveId(id, spec)) : builtin(spec));
  factory(module, module.exports, requireFor, dir, '/' + id);
  return module.exports;
}
`);
  parts.push(SHIM_SOURCE);
  // Buffer has to exist before any module runs: the packing code was written
  // against it and does not import it.
  parts.push("const Buffer = load('src/lib/bytes.js').Buffer;");
  parts.push("const pipeline = load('src/lib/pipeline.js');");
  parts.push("const client = load('src/site/client.js').createClient({pipeline: pipeline, version: VERSION});");
  parts.push('client.version = VERSION;');
  parts.push('client.pipeline = pipeline;');
  parts.push("if (typeof self !== 'undefined') self.BLPackager = client;");
  parts.push('})();');

  fs.mkdirSync(OUT, {recursive: true});
  fs.writeFileSync(path.join(OUT, 'app.js'), parts.join('\n'), 'utf8');

  // The worker is three lines of glue because app.js is a classic script: it
  // defines self.BLPackager, and importScripts gives this context the same one.
  fs.writeFileSync(path.join(OUT, 'worker.js'), `/* Generated by src/build-site.js -- do not edit. */
importScripts('app.js');

self.onmessage = function (event) {
  const message = event.data;
  try {
    if (message.kind === 'inspect') {
      self.postMessage({id: message.id, ok: true, result: self.BLPackager.inspect(message.bytes, message.options)});
      return;
    }
    if (message.kind === 'pack') {
      const packed = self.BLPackager.pack(message.bytes, message.options);
      self.postMessage({id: message.id, ok: true, result: {
        name: packed.name,
        stats: packed.stats,
        html: packed.html.buffer
      }}, [packed.html.buffer]);
      return;
    }
    throw new Error('unknown message ' + message.kind);
  } catch (error) {
    self.postMessage({id: message.id, ok: false, error: String((error && error.message) || error)});
  }
};
`, 'utf8');

  fs.copyFileSync(path.join(__dirname, 'site', 'local-api.js'), path.join(OUT, 'local-api.js'));
  // The tab icon: ui/index.html links it relatively, so it has to travel with
  // the page or the deployed site asks for a file that is not there.
  fs.copyFileSync(path.join(ROOT, 'ui', 'favicon.svg'), path.join(OUT, 'favicon.svg'));

  const page = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  if (!page.includes('<!-- BL:SITE -->')) {
    throw new Error('ui/index.html is missing the <!-- BL:SITE --> marker');
  }
  const injected = [
    `<script>window.__BL_SITE__ = true; window.__BL_VERSION__ = ${JSON.stringify(version)};</script>`,
    '<script src="local-api.js"></script>',
    // The exe target needs MSVC and a file system; the site has neither, and an
    // option that cannot work is worse than an absent one.
    '<style>label.option:has(input[name="target"][value="exe"]) { display: none; }</style>'
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'index.html'), page.replace('<!-- BL:SITE -->', injected), 'utf8');

  return {modules: Object.keys(modules).length, builtins, vfs: Object.keys(vfs), version};
};

const summary = build();
console.log(`site/      app.js  ${(fs.statSync(path.join(OUT, 'app.js')).size / 1024).toFixed(0)} KB`);
console.log(`           worker.js, local-api.js, favicon.svg, index.html`);
console.log(`modules    ${summary.modules} (${summary.builtins.join(', ')})`);
console.log(`runtime    ${summary.vfs.join(', ')}`);
console.log(`version    ${summary.version}`);
