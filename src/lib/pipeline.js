'use strict';

// The packing pipeline, shared by every front end.
//
//   src/pack.js      CLI  -> single-file HTML
//   src/pack-exe.js  CLI  -> single-file .exe resources
//   ui/server.js     web  -> both, from a browser
//
// All three call into this module rather than re-deriving the steps, so a given
// option can only mean one thing and the entry points cannot drift apart. The
// interesting logic all lives in the sibling modules (sb3 / container / html);
// what is collected here is the *order* and the *defaults*.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {spawnSync} = require('node:child_process');

const {loadSb3} = require('./sb3');
const {buildContainer} = require('./container');
const {renderHtml} = require('./html');
const {applyBakedExtensions} = require('./extensions');
const {parseDataUri, imageDataUri, sniffImage} = require('./datauri');
const {writeZip} = require('./zip');
const {basename} = require('./container');

const ROOT = path.join(__dirname, '..', '..');
const EXE_DIR = path.join(ROOT, 'exe');
const BUILD_DIR = path.join(EXE_DIR, 'build');
const VENDOR_DIR = path.join(ROOT, 'vendor');

/** Deflate an entry only when the measurement says it saves more than this. */
const MIN_SAVING = 0.05;
/** "Never deflate": no achievable ratio clears 200%. */
const MIN_SAVING_OFF = 2;

const SCAFFOLDING_FULL = 'scaffolding-full.js';
const SCAFFOLDING_MIN = 'scaffolding-min.js';
const SCAFFOLDING_ADDONS = 'scaffolding-addons.js';

/** Largest loading-screen image / cursor accepted, before base64 inflation. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Options that travel straight from a front end to the rendered page. Each one
 * is honoured by the inlined scaffolding (see html.js); nothing is listed here
 * that would be inert. Keeping the list in one place is what stops the CLI, the
 * exe path and the web UI from each supporting a different subset.
 */
const RENDER_OPTION_KEYS = [
  // runtime
  'interpolation', 'highQualityPen', 'maxClones', 'fencing', 'miscLimits',
  'compilerEnabled', 'warpTimer', 'stageWidth', 'stageHeight', 'resizeMode',
  'maxTextureDimension', 'username', 'closeWhenStopped', 'cursor',
  'cloudMode', 'projectId',
  // player
  'accent', 'background', 'foreground', 'loadingText', 'progressBar',
  'loadingImage', 'loadingImageMode',
  'controlGreenFlag', 'controlStopAll', 'controlPause', 'controlFullscreen',
  'editableLists', 'variableColor', 'listColor', 'packagedRuntime',
  'customCSS', 'customJS',
  // interaction
  'cursorCustom', 'cursorCenterX', 'cursorCenterY',
  'pointerlock', 'gamepad', 'specialCloudBehaviors', 'unsafeCloudBehaviors'
];

/** The addon bundle has to be inlined when any of these is on. */
const ADDON_KEYS = ['pointerlock', 'gamepad', 'specialCloudBehaviors', 'unsafeCloudBehaviors'];

/** Only the keys the caller actually supplied — undefined must not win. */
const pickRenderOptions = (source = {}) => {
  const out = {};
  for (const key of RENDER_OPTION_KEYS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
};

/**
 * Read an option set: the JSON itself, or `@path`, and tolerating the
 * `{app, version, options}` wrapper the web UI writes. Shared by both CLIs so
 * the file the page exports is exactly what they accept.
 */
const loadOptionSet = (spec) => {
  if (!spec) return {};
  const text = String(spec).startsWith('@')
    ? fs.readFileSync(path.resolve(String(spec).slice(1)), 'utf8')
    : String(spec);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`option set is not valid JSON: ${error.message}`);
  }
  const source = parsed && typeof parsed === 'object' && parsed.options ? parsed.options : parsed;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('an option set must be a JSON object');
  }
  return source;
};

/**
 * Where a given repo root keeps its exe build output. Exposed so callers (the
 * web UI, the tests) can be pointed at a scratch root instead of clobbering the
 * real exe/build/ — a test run writes app.html.gz, and that file is the payload
 * of whatever exe was compiled last.
 */
const buildDirFor = (root = ROOT) =>
  (path.resolve(root) === path.resolve(ROOT) ? BUILD_DIR : path.join(root, 'exe', 'build'));

/**
 * TurboWarp-compatible title derivation. Deliberately drops non-ASCII so the
 * result is safe to use as a file name and inside a resource script; the web UI
 * pre-fills a separate free-text field instead of relying on this.
 */
const defaultTitle = (inputPath) => {
  const base = path.basename(String(inputPath || '')).replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/[^\-a-z0-9 ]/gi, '').trim().replace(/ +/g, ' ');
  return cleaned || 'Packaged Project';
};

const human = (bytes) => {
  if (bytes === null || bytes === undefined) return 'n/a';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

/**
 * The runtime is not vendored with the repo (it is a 1.7-2.5 MB TurboWarp
 * artifact), so a missing file has to become an actionable message rather than
 * an ENOENT three stack frames deeper.
 */
const pickScaffolding = (project, options = {}) => {
  const {fullRuntime = false, root = ROOT, onWarn = () => {}} = options;
  const wantFull = fullRuntime || project.analysis.usesMusic;
  const wanted = wantFull ? SCAFFOLDING_FULL : SCAFFOLDING_MIN;
  const wantedPath = path.join(root, 'vendor', wanted);
  if (fs.existsSync(wantedPath)) return wantedPath;

  const minPath = path.join(root, 'vendor', SCAFFOLDING_MIN);
  if (fs.existsSync(minPath)) {
    if (wantFull) {
      onWarn(`${wanted} not found, falling back to ${SCAFFOLDING_MIN} ` +
        '(the music extension needs scaffolding-full)');
    }
    return minPath;
  }
  throw new Error(
    'no runtime found. Download one into vendor/:\n' +
    '  https://packager.turbowarp.org/scaffolding/scaffolding-min.js\n' +
    '  https://packager.turbowarp.org/scaffolding/scaffolding-full.js'
  );
};

/**
 * Resolve the addon bundle, the way pickScaffolding resolves the runtime.
 *
 * The distinction between "needed" and "nice to have" is deliberate:
 * pointer lock, gamepad and the special cloud behaviours exist *only* in this
 * bundle, so asking for one without it is an error. The pause button works
 * without it too — it just keeps the vanilla pause — so a missing bundle there
 * must not turn a working setup into a failed pack.
 */
const pickAddons = (root, renderOptions = {}) => {
  const file = path.join(root, 'vendor', SCAFFOLDING_ADDONS);
  const present = fs.existsSync(file);
  const required = ADDON_KEYS.filter((key) => renderOptions[key]);
  if (required.length > 0) {
    if (!present) {
      throw new Error(`the ${required.join(' / ')} option needs vendor/${SCAFFOLDING_ADDONS}, ` +
        'which is not in this checkout. Download it into vendor/:\n' +
        '  https://packager.turbowarp.org/scaffolding/addons.js');
    }
    return file;
  }
  return present && renderOptions.controlPause ? file : null;
};

/** @returns {string} a data: URL, or '' when no file was given */
const readImageFile = (file, label = 'image') => {
  if (!file) return '';
  const absolute = path.resolve(file);
  const bytes = fs.readFileSync(absolute);
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`${label} ${path.basename(absolute)} is ${human(bytes.length)}; ` +
      `the limit is ${human(MAX_IMAGE_BYTES)}`);
  }
  return imageDataUri(bytes, `${label} ${path.basename(absolute)}`);
};

/** The exe icon has to be a real .ico (rc.exe's ICON statement is literal). */
const readIconFile = (file) => {
  if (!file) return null;
  const absolute = path.resolve(file);
  const bytes = fs.readFileSync(absolute);
  if (sniffImage(bytes) !== 'ico') {
    throw new Error(`icon ${path.basename(absolute)} is not a .ico file ` +
      '(png/jpeg are not accepted: Windows wants an icon container)');
  }
  return {name: path.basename(absolute), bytes};
};

/**
 * The same two shapes as resolveImage(), for the icon: a path from a flag or a
 * hand-written options file, or the data URL the web UI exports.
 */
const resolveIcon = (value) => {
  if (!value) return null;
  const text = String(value);
  if (/^data:/i.test(text)) {
    const parsed = parseDataUri(text);
    if (!parsed) throw new Error('icon is not a valid data: URL');
    if (parsed.bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(`icon is ${human(parsed.bytes.length)}; the limit is ${human(MAX_IMAGE_BYTES)}`);
    }
    if (sniffImage(parsed.bytes) !== 'ico') {
      throw new Error('icon is not a .ico file (Windows wants an icon container)');
    }
    return {name: 'app.ico', bytes: parsed.bytes};
  }
  return readIconFile(text);
};

/**
 * An image option may hold either shape: a `data:` URL (what the web UI has, and
 * what the renderer demands) or a path (what a hand-written options file or a
 * CLI flag naturally contains). One function decides, so neither front end has
 * to know about the other.
 */
const resolveImage = (value, label = 'image') => {
  if (!value) return '';
  const text = String(value);
  if (/^data:image\//i.test(text)) return text;
  return readImageFile(text, label);
};

/**
 * Remove extension ids from a loaded project that no source could be obtained
 * for. The blocks that reference them stay behind and become inert; the VM no
 * longer tries to load them from the network when the packaged page opens.
 */
const dropProjectExtensions = (project, ids, {onWarn = () => {}} = {}) => {
  const data = project.projectData;
  const drop = new Set(ids);
  const before = data.extensions ? data.extensions.length : 0;
  if (Array.isArray(data.extensions)) {
    data.extensions = data.extensions.filter((id) => !drop.has(id));
  }
  if (data.extensionURLs) {
    for (const id of drop) delete data.extensionURLs[id];
  }
  project.projectJSONBytes = Buffer.from(JSON.stringify(data), 'utf8');
  if (project.analysis) project.analysis.extensions = Array.from(data.extensions || []);
  if (before !== (data.extensions || []).length) {
    for (const id of ids) {
      onWarn(`extension "${id}" has no fetchable source; it was dropped from ` +
        'project.json, so its blocks do nothing in the packaged project');
    }
  }
};

/**
 * Stage 1: parse the sb3, bake any supplied extensions in, pick the runtime,
 * build the container.
 *
 * Split out from rendering because `--mode=both` renders two artifacts from one
 * parse — and because the web UI wants to show the analysis before it commits to
 * emitting a 19 MB file.
 *
 * @param {Buffer|Uint8Array} input raw sb3
 * @param {{extensions?: {name?: string, source: string}[],
 *          dropExtensions?: string[]}} [options]
 * @returns {{project: object, container: Buffer, containerStats: object,
 *            scaffoldingSource: string, extensions: object}}
 */
const prepareProject = (input, options = {}) => {
  const {
    fullRuntime = false,
    scaffolding = null,
    noDeflate = false,
    deflateIndex = false,
    optimizePng = true,
    root = ROOT,
    extensions = [],
    dropExtensions = [],
    onWarn = () => {}
  } = options;

  const project = loadSb3(input, {optimize: true, optimizePng});
  // Extensions auto-resolve could not get a source for are dropped from
  // project.json, so the VM never reaches for the network on them at load time
  // (a load the offline runtime cannot answer is what makes a packaged project
  // "not open"). Their blocks stay in the project and simply do nothing.
  // Ids the user supplied a source for are never here — see known-extensions.js.
  if (dropExtensions.length) {
    dropProjectExtensions(project, dropExtensions, {onWarn});
  }
  // Before the container is built: the rewrite lands in project.json, which is
  // what both the container and the zip target ship.
  const baked = applyBakedExtensions(project, extensions, {onWarn});
  const scaffoldingSource = scaffolding || pickScaffolding(project, {fullRuntime, root, onWarn});

  const {container, stats: containerStats} = buildContainer(project, {
    minSaving: noDeflate ? MIN_SAVING_OFF : MIN_SAVING,
    deflateIndex
  });

  return {project, container, containerStats, scaffoldingSource, extensions: baked};
};

/**
 * Parse a project far enough to answer "what is in here?" without paying for a
 * container build or a PNG re-encode.
 *
 * This backs the web UI's 载入作品 step: the user gets to see 101 角色 / 171 素材
 * / which runtime will be used *before* committing to a 19 MB render. PNG
 * recompression is deliberately off — it is the single most expensive step and
 * its result would only be thrown away here.
 *
 * @returns {{analysis: object, scaffolding: string, byExtension: object,
 *            scaffoldingAvailable: {min: boolean, full: boolean}}}
 */
const inspectProject = (input, options = {}) => {
  const {
    root = ROOT,
    fullRuntime = false,
    onWarn = () => {}
  } = options;

  const project = loadSb3(input, {optimize: true, optimizePng: false});
  const scaffoldingSource = pickScaffolding(project, {fullRuntime, root, onWarn});

  // Names are enough to say what the payload is made of; reading the bytes
  // would double the parse cost for a number nobody acts on.
  const byExtension = {};
  for (const name of project.assets.keys()) {
    const dot = name.lastIndexOf('.');
    const ext = (dot === -1 ? 'other' : name.slice(dot + 1)).toLowerCase();
    byExtension[ext] = (byExtension[ext] || 0) + 1;
  }

  return {
    analysis: project.analysis,
    scaffolding: path.basename(scaffoldingSource),
    byExtension,
    scaffoldingAvailable: {
      min: fs.existsSync(path.join(root, 'vendor', SCAFFOLDING_MIN)),
      full: fs.existsSync(path.join(root, 'vendor', SCAFFOLDING_FULL))
    }
  };
};

/**
 * Stage 2: embed the payload in a single-file HTML.
 *
 * @param {object} prepared result of prepareProject()
 * @param {object} [options]
 * @param {'fast'|'tw'|'http'} [options.mode] fast = BLPK container, tw =
 *        upstream strategy, http = no payload (the zip target)
 * @param {string} [options.inputPath] used only to derive the default title
 * @returns {{html: Buffer, stats: object, payloadBytes: number, deflatedEntries: number}}
 */
const renderProjectHtml = (prepared, options = {}) => {
  const {
    mode = 'fast',
    inputPath = '',
    title,
    autoplay = false,
    turbo = false,
    framerate = 30,
    preload = false,
    root = ROOT,
    // Handing the VM views into the decoded container is a documented
    // regression (scratch-audio then copies the whole thing per sound). It is
    // reachable from the CLI on purpose, to reproduce the measurement.
    viewAssets = false,
    instrument = false
  } = options;

  if (mode !== 'fast' && mode !== 'tw' && mode !== 'http') throw new Error(`unknown mode ${mode}`);

  const {project, container, containerStats, scaffoldingSource} = prepared;
  const renderOptions = pickRenderOptions(options);
  const payload = mode === 'http'
    ? null
    : (mode === 'tw' ? project.originalBytes : container);
  const deflatedEntries = mode === 'tw' || mode === 'http'
    ? 0
    : (containerStats.assetsDeflated + (containerStats.indexDeflated ? 1 : 0));

  const {html, stats} = renderHtml(project, payload, Object.assign({
    mode,
    title: title || defaultTitle(inputPath),
    autoplay,
    turbo,
    framerate,
    preload,
    copyAssets: !viewAssets,
    instrument,
    deflatedEntries,
    scaffoldingSource,
    addonsSource: pickAddons(root, renderOptions),
    eagerExtensions: prepared.extensions ? prepared.extensions.eager : [],
    buildInfo: `runtime: ${path.basename(scaffoldingSource)}`
  }, renderOptions));

  return {html, stats, payloadBytes: payload ? payload.length : 0, deflatedEntries};
};

/**
 * sb3 bytes -> single-file HTML, in one call. Convenience for the front ends
 * that only ever emit one artifact.
 *
 * @returns {{html: Buffer, stats: object, project: object, container: object,
 *            containerStats: object, scaffoldingSource: string,
 *            payloadBytes: number, deflatedEntries: number}}
 */
const packToHtml = (input, options = {}) => {
  const prepared = prepareProject(input, options);
  const rendered = renderProjectHtml(prepared, options);
  return Object.assign({}, prepared, rendered);
};

/**
 * sb3 bytes -> a zip for a static host: `index.html`, `project.json`, `assets/`.
 *
 * This is upstream's "zip" target, and it is the one target where inlining is
 * the wrong answer: with the assets as separate files the browser fetches them
 * in parallel while the VM is still building targets, and caches each one, so a
 * second visit only re-reads the HTML. The trade is that the page has to be
 * *served* — `file://` gives fetch no directory to read from, and the error
 * message in loader.js says so instead of hanging.
 *
 * @returns {{zip: Buffer, entries: object[], html: Buffer, stats: object,
 *            project: object, containerStats: object, scaffoldingSource: string}}
 */
const packToZip = (input, options = {}) => {
  const prepared = prepareProject(input, options);
  const rendered = renderProjectHtml(prepared, Object.assign({}, options, {mode: 'http'}));

  const entries = [
    {name: 'index.html', data: rendered.html},
    {name: 'project.json', data: prepared.project.projectJSONBytes}
  ];
  for (const [name, data] of prepared.project.assets) {
    // Flattened on purpose: the VM only ever asks for `<md5ext>`, so a
    // subdirectory in the original sb3 is not information worth keeping.
    entries.push({name: `assets/${basename(name)}`, data});
  }

  return Object.assign({}, prepared, rendered, {zip: writeZip(entries), entries});
};

/** `=` and newlines would corrupt the key/value file the host parses. */
const metaValue = (value) => String(value).replace(/[\r\n]+/g, ' ').replace(/^\s*|\s*$/g, '');

const WINDOW_MODES = ['window', 'maximize', 'fullscreen'];

/**
 * A VERSIONINFO block for app.rc, so the exe shows a product name and version in
 * Explorer instead of "unknown application".
 *
 * Everything here has to be ASCII: rc.exe parses the script in the OEM code
 * page, which is exactly why the document title lives in app.meta (read as
 * UTF-8) instead. So a Chinese title becomes `?` characters *in the file
 * properties only* — the window title, which comes from the meta file, keeps it.
 */
const rcVersionBlock = (version, title) => {
  const ascii = (value) => String(value == null ? '' : value).replace(/[^\x20-\x7e]/g, '?');
  const parts = ascii(version).split('.').map((part) => parseInt(part, 10));
  const quad = [];
  for (let i = 0; i < 4; i++) {
    quad.push(Number.isFinite(parts[i]) && parts[i] >= 0 ? Math.min(parts[i], 65535) : 0);
  }
  const text = ascii(version || '0.0.0') || '0.0.0';
  const name = (ascii(title).replace(/"/g, "'").trim() || 'Bilup Player');
  return [
    '',
    // Resource *type* differs from the icon group, so id 1 is free here and is
    // what Explorer looks for in the file-properties dialog.
    '1 VERSIONINFO',
    `FILEVERSION ${quad.join(',')}`,
    `PRODUCTVERSION ${quad.join(',')}`,
    'FILEFLAGSMASK 0x3fL',
    'FILEFLAGS 0x0L',
    'FILEOS 0x40004L',
    'FILETYPE 0x1L',
    'FILESUBTYPE 0x0L',
    'BEGIN',
    '  BLOCK "StringFileInfo"',
    '  BEGIN',
    '    BLOCK "040904b0"',
    '    BEGIN',
    '      VALUE "CompanyName", "Bilup"',
    `      VALUE "FileDescription", "${name}"`,
    `      VALUE "FileVersion", "${text}"`,
    `      VALUE "ProductName", "${name}"`,
    `      VALUE "ProductVersion", "${text}"`,
    '    END',
    '  END',
    '  BLOCK "VarFileInfo"',
    '  BEGIN',
    '    VALUE "Translation", 0x409, 1200',
    '  END',
    'END'
  ].join('\r\n');
};

/**
 * Render the HTML, compress it, and lay down everything exe/build.cmd needs:
 * app.html.gz (the RT_RCDATA payload), app.meta (title/geometry), an optional
 * app.ico, and app.rc tying them together.
 *
 * Nothing here touches the host binary, so the size story stays
 * `exe = host code + gzip(html) + resources`.
 *
 * @returns {{pack: object, htmlBytes: Buffer, payload: Buffer, gzipped: boolean,
 *            icon: object|null,
 *            paths: {payload: string, meta: string, rc: string, icon: string|null},
 *            metaLines: string[]}}
 */
const writeExeResources = (input, options = {}) => {
  const {
    title,
    inputPath = '',
    width = 640,
    height = 480,
    gzip = true,
    gzipLevel = 9,
    devtools = true,
    probe = null,
    preload = false,
    noDeflate = false,
    optimizePng = true,
    windowMode = 'window',
    version = '',
    icon = null,
    // The player-side options the web UI exposes for both targets. An exe is a
    // packaged page with a WebView around it, so it takes the same runtime
    // settings as the HTML build — going through packToHtml keeps them from
    // meaning two different things.
    autoplay = false,
    turbo = false,
    framerate = 30,
    root = ROOT
  } = options;

  const pack = packToHtml(input, Object.assign({
    mode: 'fast',
    inputPath,
    title,
    autoplay,
    turbo,
    framerate,
    preload,
    noDeflate,
    optimizePng,
    root
  }, pickRenderOptions(options)));

  const htmlBytes = Buffer.from(pack.html);
  const gzipped = gzip ? zlib.gzipSync(htmlBytes, {level: gzipLevel}) : null;
  const payload = gzipped || htmlBytes;

  const dir = buildDirFor(root);
  fs.mkdirSync(dir, {recursive: true});

  const resolvedTitle = title || defaultTitle(inputPath);
  const metaLines = [
    `title=${metaValue(resolvedTitle)}`,
    `width=${width}`,
    `height=${height}`,
    `gzip=${gzipped ? 1 : 0}`,
    `devtools=${devtools ? 1 : 0}`
  ];
  // Only when it is not the default: an existing payload keeps its exact bytes.
  if (WINDOW_MODES.includes(windowMode) && windowMode !== 'window') {
    metaLines.push(`window=${windowMode}`);
  }
  if (probe) metaLines.push(`probe=${path.resolve(probe)}`);

  const paths = {
    payload: path.join(dir, 'app.html.gz'),
    meta: path.join(dir, 'app.meta'),
    rc: path.join(dir, 'app.rc'),
    icon: null
  };
  fs.writeFileSync(paths.payload, payload);
  fs.writeFileSync(paths.meta, metaLines.join('\n') + '\n', 'utf8');

  // ASCII resource script: cmd.exe/rc.exe parse it in the OEM code page, and the
  // document title lives in app.meta (read as UTF-8) precisely to keep non-ASCII
  // out of this file.
  let rc = '101 RCDATA "app.html.gz"\r\n102 RCDATA "app.meta"\r\n';
  if (icon && icon.bytes) {
    paths.icon = path.join(dir, 'app.ico');
    fs.writeFileSync(paths.icon, icon.bytes);
    rc += '1 ICON "app.ico"\r\n';
  }
  if (version) rc += rcVersionBlock(version, resolvedTitle) + '\r\n';
  fs.writeFileSync(paths.rc, rc, 'ascii');

  return {pack, htmlBytes, payload, gzipped, icon, paths, metaLines};
};

/**
 * Compile the host with exe/build.cmd.
 *
 * Never throws: an environment without MSVC, or a sandbox that refuses to spawn
 * cmd.exe, has to be reportable rather than fatal — the resources written by
 * writeExeResources() are useful without a compiler.
 */
const buildExe = (options = {}) => {
  const {exeDir = EXE_DIR, timeout = 300000} = options;
  const script = path.join(exeDir, 'build.cmd');
  if (!fs.existsSync(script)) {
    return {ok: false, status: null, stdout: '', stderr: '', reason: `${script} not found`};
  }
  const result = spawnSync('cmd.exe', ['/c', script], {
    cwd: exeDir,
    encoding: 'utf8',
    timeout
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    reason: result.error ? result.error.message : null
  };
};

/**
 * Size of bl-player.exe, but only when it is at least as new as the payload it
 * claims to embed. A leftover binary from an earlier run would otherwise make
 * "host code" nonsense (or negative).
 */
const readBuiltExe = (payloadPath = path.join(BUILD_DIR, 'app.html.gz'), options = {}) => {
  const {buildDir = BUILD_DIR} = options;
  const exe = path.join(buildDir, 'bl-player.exe');
  if (!fs.existsSync(exe) || !fs.existsSync(payloadPath)) return null;
  if (fs.statSync(exe).mtimeMs < fs.statSync(payloadPath).mtimeMs - 2000) return null;
  return exe;
};

const hasScaffolding = (root = ROOT) => ({
  min: fs.existsSync(path.join(root, 'vendor', SCAFFOLDING_MIN)),
  full: fs.existsSync(path.join(root, 'vendor', SCAFFOLDING_FULL))
});

/** The addon bundle is optional; only the chunk options need it. */
const hasAddons = (root = ROOT) => fs.existsSync(path.join(root, 'vendor', SCAFFOLDING_ADDONS));

module.exports = {
  ROOT,
  EXE_DIR,
  BUILD_DIR,
  VENDOR_DIR,
  SCAFFOLDING_MIN,
  SCAFFOLDING_FULL,
  SCAFFOLDING_ADDONS,
  MAX_IMAGE_BYTES,
  WINDOW_MODES,
  buildDirFor,
  defaultTitle,
  human,
  pickScaffolding,
  pickAddons,
  readImageFile,
  readIconFile,
  resolveIcon,
  resolveImage,
  prepareProject,
  inspectProject,
  renderProjectHtml,
  packToHtml,
  packToZip,
  writeExeResources,
  buildExe,
  readBuiltExe,
  hasScaffolding,
  hasAddons,
  RENDER_OPTION_KEYS,
  ADDON_KEYS,
  pickRenderOptions,
  loadOptionSet
};
