#!/usr/bin/env node
'use strict';

// Local web front end for the packager.
//
//   node ui/server.js            -> http://127.0.0.1:8788
//   node ui/server.js --port 9000
//
// Zero dependencies on purpose: this only has to be a thin shell over
// src/lib/pipeline.js. The browser does the drag & drop and the download; the
// packing itself stays here, because loadSb3() and friends need node:zlib.
//
// Security posture — this process accepts file uploads and writes to exe/build/,
// so it:
//   * binds to 127.0.0.1 only (never 0.0.0.0),
//   * checks the Host header (DNS rebinding would otherwise let a website reach
//     a loopback service through the user's browser),
//   * caps the upload size,
//   * serves /api/artifact from a name allowlist, resolved inside exe/build/.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn} = require('node:child_process');

const {
  ROOT,
  defaultTitle,
  human,
  buildDirFor,
  inspectProject,
  packToHtml,
  packToZip,
  writeExeResources,
  buildExe,
  readBuiltExe,
  hasScaffolding,
  hasAddons,
  resolveIcon,
  MAX_IMAGE_BYTES,
  WINDOW_MODES
} = require('../src/lib/pipeline');
const {normalizeImageDataUri} = require('../src/lib/datauri');
const {resolveMissingExtensions} = require('../src/lib/known-extensions');

const UI_DIR = __dirname;
const DEFAULT_PORT = 8788;
const MAX_UPLOAD = 512 * 1024 * 1024;

/**
 * The page sends every option in the query string, which keeps the body free for
 * the sb3 itself (one request, no multipart parser). Loading-screen images and
 * baked extension sources ride along the same way, so the default 16 KB header
 * ceiling would cut them off — hence a deliberately larger one for a server
 * bound to loopback. The per-item caps below are what actually bound the input.
 */
const MAX_HEADER_BYTES = 12 * 1024 * 1024;
const MAX_EXTENSION_BYTES = 2 * 1024 * 1024;
const MAX_EXTENSIONS_TOTAL = 6 * 1024 * 1024;

const ARTIFACT_ALLOWLIST = [
  'bl-player.exe',
  'bl-player-dyn.exe',
  'app.html.gz',
  'app.meta',
  'app.rc',
  'app.ico',
  'WebView2Loader.dll'
];

const badRequest = (message) => Object.assign(new Error(message), {status: 400});

// --- helpers --------------------------------------------------------------

const flag = (params, name, fallback = false) => {
  const value = params.get(name);
  if (value === null) return fallback;
  return value === '1' || value === 'true' || value === 'on' || value === '';
};

const str = (params, name, fallback = '') => {
  const value = params.get(name);
  return value === null || value === '' ? fallback : value;
};

const num = (params, name, fallback) => {
  const value = Number(params.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * `num` refuses 0, but 0 is a legal frame rate (it means "uncapped") and a
 * clamped integer is the only thing worth handing to the renderer either way.
 */
const boundedInt = (params, name, fallback, min, max) => {
  const raw = params.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Math.round(Number(raw));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};

/** Query-string -> render option types. One table, so a new option is one line. */
const BOOL_PARAMS = [
  'turbo', 'interpolation', 'highQualityPen', 'fencing', 'miscLimits',
  'compilerEnabled', 'warpTimer', 'closeWhenStopped', 'autoplay', 'progressBar',
  'controlGreenFlag', 'controlStopAll', 'controlPause', 'controlFullscreen',
  'editableLists', 'packagedRuntime',
  'pointerlock', 'gamepad', 'specialCloudBehaviors', 'unsafeCloudBehaviors'
];

/** name -> [min, max, fallback] */
const NUMBER_PARAMS = {
  framerate: [0, 240, 30],
  maxClones: [1, 1000000, 300],
  stageWidth: [1, 4096, 480],
  stageHeight: [1, 4096, 360],
  maxTextureDimension: [1, 16384, 2048],
  cursorCenterX: [-1024, 1024, 0],
  cursorCenterY: [-1024, 1024, 0]
};

const STRING_PARAMS = [
  'username', 'loadingText', 'resizeMode', 'cursor', 'loadingImageMode',
  'accent', 'background', 'foreground', 'variableColor', 'listColor',
  'customCSS', 'customJS', 'cloudMode', 'projectId'
];

/** Images are data: URLs in the query string; validated and re-encoded here. */
const IMAGE_PARAMS = {
  loadingImage: 'loading screen image',
  cursorCustom: 'cursor image'
};

/**
 * The player/runtime options both targets accept, read from one place.
 *
 * A parameter that is absent is left out of the result entirely, so html.js's
 * own default applies. Filling in our default here instead would look harmless
 * and then quietly win over anything else that set the same option.
 */
const playerOptions = (params) => {
  const out = {};
  for (const key of BOOL_PARAMS) {
    if (params.has(key)) out[key] = flag(params, key);
  }
  for (const [key, [min, max, fallback]] of Object.entries(NUMBER_PARAMS)) {
    if (!params.has(key)) continue;
    // "Infinity" is how the page spells 无限克隆; boundedInt would reject it.
    if (key === 'maxClones' && params.get(key) === 'Infinity') {
      out[key] = Infinity;
      continue;
    }
    out[key] = boundedInt(params, key, fallback, min, max);
  }
  for (const key of STRING_PARAMS) {
    if (params.has(key)) out[key] = str(params, key, '');
  }
  for (const [key, label] of Object.entries(IMAGE_PARAMS)) {
    if (!params.has(key)) continue;
    // '' means "no image", which is also what an invalid one must turn into.
    let value;
    try {
      value = normalizeImageDataUri(params.get(key), {maxBytes: MAX_IMAGE_BYTES, name: label});
    } catch (error) {
      // A bad image is the caller's mistake, not a broken server.
      throw badRequest(error.message);
    }
    if (value) out[key] = value;
  }
  return out;
};

/**
 * Baked extension sources, as JSON in the query string:
 * `[{name, source}, …]` — the shape the page's file pickers produce.
 *
 * Each source becomes a `data:` URL inside the packed page, so the caps are not
 * about this process's memory (the 512 MiB body cap covers the sb3); they are
 * about refusing to build a page that no browser would open.
 */
const readExtensions = (params) => {
  const raw = params.get('extensions');
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest('extensions is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw badRequest('extensions must be an array');

  let total = 0;
  return parsed.map((entry, index) => {
    const source = typeof entry === 'string' ? entry : entry && entry.source;
    if (typeof source !== 'string' || !source.trim()) {
      throw badRequest(`extension ${index} has no source`);
    }
    if (source.length > MAX_EXTENSION_BYTES) {
      throw Object.assign(new Error(`extension ${index} is ${human(source.length)}; ` +
        `the limit is ${human(MAX_EXTENSION_BYTES)}`), {status: 413});
    }
    total += source.length;
    if (total > MAX_EXTENSIONS_TOTAL) {
      throw Object.assign(new Error(`extensions total ${human(total)}; ` +
        `the limit is ${human(MAX_EXTENSIONS_TOTAL)}`), {status: 413});
    }
    const name = (entry && typeof entry.name === 'string' && entry.name) || `extension-${index}.js`;
    return {name: safeFileName(name), source};
  });
};

/** Keep characters Windows refuses in a file name out of the download name. */
const safeFileName = (name) => String(name).replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/^\.+/, '').trim() || 'project';

const contentDisposition = (name) => {
  const ascii = safeFileName(name).replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(safeFileName(name))}`;
};

const sendJson = (res, status, body) => {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store'
  });
  res.end(payload);
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let total = 0;
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > MAX_UPLOAD) {
      reject(Object.assign(new Error(`upload exceeds ${human(MAX_UPLOAD)}`), {status: 413}));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

/** Detect the toolchain build.cmd will call, by reading it rather than guessing. */
const detectMsvc = () => {
  try {
    const script = fs.readFileSync(path.join(ROOT, 'exe', 'build.cmd'), 'utf8');
    const match = /set "VCVARS=([^"]+)"/.exec(script);
    return match ? fs.existsSync(match[1]) : false;
  } catch {
    return false;
  }
};

/**
 * What this run actually produced.
 *
 * The build directory is shared and never cleaned, so it can hold binaries from
 * an earlier project (and from the old dynamic-linking experiment, whose
 * WebView2Loader.dll has no business being offered to anyone). Everything this
 * run writes lands at or after the payload's mtime; anything older is somebody
 * else's build and must not become a download link.
 */
const listArtifacts = (payloadPath, buildDir) => {
  if (!fs.existsSync(payloadPath)) return [];
  const writtenAt = fs.statSync(payloadPath).mtimeMs - 2000;
  const out = [];
  for (const name of ARTIFACT_ALLOWLIST) {
    const file = path.join(buildDir, name);
    if (!fs.existsSync(file)) continue;
    if (fs.statSync(file).mtimeMs < writtenAt) continue;
    out.push({name, bytes: fs.statSync(file).size});
  }
  return out;
};

// Model swaps the payload file on every request, so two concurrent exe requests
// would clobber each other's app.html.gz. Serialise instead of corrupting.
let exeQueue = Promise.resolve();
const serializeExe = (fn) => {
  const next = exeQueue.then(() => fn());
  exeQueue = next.then(() => {}, () => {});
  return next;
};

// --- routes ---------------------------------------------------------------

const serveUi = (res) => {
  const file = path.join(UI_DIR, 'index.html');
  // Read per request: editing the UI should not need a server restart.
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
};

const serveFavicon = (res) => {
  const body = fs.readFileSync(path.join(UI_DIR, 'favicon.svg'));
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml',
    'Content-Length': body.length,
    // The mark changes about never; a day of caching saves a request per page.
    'Cache-Control': 'public, max-age=86400'
  });
  res.end(body);
};

const handleHealth = (res) => sendJson(res, 200, {
  ok: true,
  node: process.version,
  scaffolding: hasScaffolding(ROOT),
  // Optional: only pointer lock / gamepad / the cloud behaviours need it.
  addons: hasAddons(ROOT),
  msvc: detectMsvc(),
  maxUpload: MAX_UPLOAD
});

/**
 * Parse only. The page's 载入作品 step calls this so it can show what is inside
 * the archive before the user commits to a full render; the file itself stays in
 * the browser, so nothing is cached here.
 */
const handleInspect = async (req, res, params, ctx) => {
  const input = await readBody(req);
  if (!input.length) throw Object.assign(new Error('empty request body'), {status: 400});

  const started = Date.now();
  let warning = null;
  const info = inspectProject(input, {
    root: ctx.buildRoot,
    fullRuntime: flag(params, 'fullRuntime'),
    onWarn: (message) => { warning = message; }
  });

  sendJson(res, 200, {
    ok: true,
    ms: Date.now() - started,
    filename: str(params, 'filename', ''),
    warning,
    analysis: info.analysis,
    byExtension: info.byExtension,
    scaffolding: info.scaffolding,
    scaffoldingAvailable: info.scaffoldingAvailable
  });
};

const handlePack = async (req, res, params) => {
  const input = await readBody(req);
  if (!input.length) throw Object.assign(new Error('empty request body'), {status: 400});

  const started = Date.now();
  const title = str(params, 'title', '');
  const mode = str(params, 'mode', 'fast') === 'tw' ? 'tw' : 'fast';
  const target = str(params, 'target', 'html') === 'zip' ? 'zip' : 'html';
  const extensions = readExtensions(params);

  // Same auto-bake as the CLIs: known gallery extensions and http(s) extension
  // URLs are fetched once at pack time, so a project with no extension sources
  // still packs offline-capable. The page can opt out per request with
  // `autoExtensions=false`.
  let dropExtensions = [];
  if (flag(params, 'autoExtensions', true)) {
    const auto = await resolveMissingExtensions(input, {onWarn: () => {}, provided: extensions});
    extensions.push(...auto.sources);
    dropExtensions = auto.missing;
  }

  const common = Object.assign({
    inputPath: str(params, 'filename', ''),
    title,
    extensions,
    dropExtensions,
    preload: flag(params, 'preload'),
    noDeflate: flag(params, 'noDeflate'),
    optimizePng: flag(params, 'optimizePng', true),
    // viewAssets is intentionally unreachable from the web UI: it is a
    // documented performance regression, not a feature.
    onWarn: () => {}
  }, playerOptions(params));

  const resolvedTitle = safeFileName(title || defaultTitle(str(params, 'filename', '')));

  // --- zip target: index.html + project.json + assets/ ---------------------
  if (target === 'zip') {
    const zipped = packToZip(input, common);
    const name = `${resolvedTitle}.zip`;
    const stats = {
      title: title || defaultTitle(str(params, 'filename', '')),
      target,
      zipBytes: zipped.zip.length,
      htmlBytes: zipped.html.length,
      entries: zipped.entries.length,
      scaffolding: path.basename(zipped.scaffoldingSource),
      project: zipped.project.analysis,
      extensions: extensions.map((entry) => entry.name),
      ms: Date.now() - started
    };
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': zipped.zip.length,
      'Content-Disposition': contentDisposition(name),
      'X-Pack-Stats': encodeURIComponent(JSON.stringify(stats)).replace(/[^\x20-\x7e]/g, ''),
      'X-Pack-Filename': encodeURIComponent(name),
      'Cache-Control': 'no-store'
    });
    res.end(zipped.zip);
    return;
  }

  const packed = packToHtml(input, Object.assign({}, common, {mode}));

  const name = mode === 'tw' ? `${resolvedTitle}.tw.html` : `${resolvedTitle}.html`;

  const stats = {
    title: title || defaultTitle(str(params, 'filename', '')),
    mode,
    htmlBytes: packed.html.length,
    chunks: packed.stats.chunks,
    payloadBytes: packed.payloadBytes,
    deflatedEntries: packed.deflatedEntries,
    scaffolding: path.basename(packed.scaffoldingSource),
    container: packed.containerStats,
    project: packed.project.analysis,
    extensions: extensions.map((entry) => entry.name),
    ms: Date.now() - started
  };

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': packed.html.length,
    'Content-Disposition': contentDisposition(name),
    'X-Pack-Stats': encodeURIComponent(JSON.stringify(stats)).replace(/[^\x20-\x7e]/g, ''),
    'X-Pack-Filename': encodeURIComponent(name),
    'Cache-Control': 'no-store'
  });
  res.end(packed.html);
};

/**
 * The exe's icon arrives as a data: URL (the page's file picker) and has to be
 * a real icon container: rc.exe's `ICON` statement will not take a PNG, and a
 * failed resource compile is an unhelpful way to learn that. resolveIcon() is
 * the same check the CLI applies to `--icon`.
 */
const readIconParam = (params) => {
  const raw = params.get('icon');
  if (!raw) return null;
  try {
    return resolveIcon(raw);
  } catch (error) {
    throw badRequest(error.message);
  }
};

const handlePackExe = async (req, res, params, ctx) => {
  const input = await readBody(req);
  if (!input.length) throw Object.assign(new Error('empty request body'), {status: 400});

  const wantBuild = flag(params, 'build');
  const title = str(params, 'title', '');
  const windowMode = WINDOW_MODES.includes(str(params, 'windowMode', 'window'))
    ? str(params, 'windowMode', 'window')
    : 'window';
  const icon = readIconParam(params);
  const extensions = readExtensions(params);

  // Same auto-bake as the CLIs: known gallery extensions and http(s) extension
  // URLs are fetched once at pack time, so a project with no extension sources
  // still packs offline-capable. The page can opt out per request with
  // `autoExtensions=false`.
  let dropExtensions = [];
  if (flag(params, 'autoExtensions', true)) {
    const auto = await resolveMissingExtensions(input, {onWarn: () => {}, provided: extensions});
    extensions.push(...auto.sources);
    dropExtensions = auto.missing;
  }

  const result = await serializeExe(() => {
    const started = Date.now();
    const resources = writeExeResources(input, Object.assign({
      inputPath: str(params, 'filename', ''),
      title,
      width: boundedInt(params, 'width', 640, 160, 8192),
      height: boundedInt(params, 'height', 480, 160, 8192),
      windowMode,
      icon,
      version: str(params, 'version', ''),
      gzip: flag(params, 'gzip', true),
      gzipLevel: num(params, 'gzipLevel', 9),
      devtools: flag(params, 'devtools', true),
      preload: flag(params, 'preload'),
      noDeflate: flag(params, 'noDeflate'),
      optimizePng: flag(params, 'optimizePng', true),
      extensions,
      dropExtensions,
      root: ctx.buildRoot
    }, playerOptions(params)));

    let build = {attempted: false, ok: null, status: null, reason: null, stdout: '', stderr: ''};
    if (wantBuild) {
      const outcome = buildExe();
      build = Object.assign({attempted: true}, outcome);
    }

    const builtExe = readBuiltExe(resources.paths.payload, {buildDir: ctx.buildDir});
    const exeBytes = builtExe ? fs.statSync(builtExe).size : null;
    const {pack} = resources;

    return {
      ms: Date.now() - started,
      builtExe,
      build,
      artifacts: listArtifacts(resources.paths.payload, ctx.buildDir),
      report: {
        input: str(params, 'filename', ''),
        title: title || defaultTitle(str(params, 'filename', '')),
        windowMode,
        icon: icon ? 'app.ico' : null,
        project: pack.project.analysis,
        container: pack.containerStats,
        scaffolding: path.basename(pack.scaffoldingSource),
        extensions: extensions.map((entry) => entry.name),
        htmlBytes: resources.htmlBytes.length,
        resourceBytes: resources.payload.length,
        resourceGzip: !!resources.gzipped,
        hostBytes: exeBytes !== null ? exeBytes - resources.payload.length : null,
        exeBytes,
        built: build.attempted ? build.ok : null
      }
    };
  });

  sendJson(res, 200, {
    ok: true,
    ms: result.ms,
    report: result.report,
    build: result.build,
    artifacts: result.artifacts
  });
};

const handleArtifact = (res, params, ctx) => {
  const name = params.get('name') || '';
  if (!ARTIFACT_ALLOWLIST.includes(name)) {
    return sendJson(res, 404, {error: `not an artifact: ${name}`});
  }
  const file = path.resolve(ctx.buildDir, name);
  if (!file.startsWith(path.resolve(ctx.buildDir) + path.sep) || !fs.existsSync(file)) {
    return sendJson(res, 404, {error: `${name} has not been built yet`});
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': body.length,
    'Content-Disposition': contentDisposition(name),
    'Cache-Control': 'no-store'
  });
  res.end(body);
};

// --- server ---------------------------------------------------------------

const createServer = ({allowAnyHost = false, buildRoot = ROOT} = {}) => {
  const ctx = {buildRoot, buildDir: buildDirFor(buildRoot)};

  // maxHeaderSize: the request line carries the option set, including data: URLs
  // for images and extension sources. Loopback-only, and each item is capped by
  // its own limit, so the ceiling here is a backstop rather than the guard.
  return http.createServer({maxHeaderSize: MAX_HEADER_BYTES}, (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    // Loopback-only guard. A page on the public internet can reach 127.0.0.1;
    // requiring a loopback Host header stops it from driving this server. Lifted
    // only when the operator deliberately binds beyond loopback.
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    const loopback = host === '' || host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
    if (!allowAnyHost && !loopback) {
      return sendJson(res, 403, {error: 'this server only answers requests addressed to loopback'});
    }

    const route = async () => {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return serveUi(res);
      if (req.method === 'GET' && url.pathname === '/favicon.svg') return serveFavicon(res);
      if (req.method === 'GET' && url.pathname === '/api/health') return handleHealth(res);
      if (req.method === 'GET' && url.pathname === '/api/artifact') return handleArtifact(res, url.searchParams, ctx);
      if (req.method === 'POST' && url.pathname === '/api/inspect') return handleInspect(req, res, url.searchParams, ctx);
      if (req.method === 'POST' && url.pathname === '/api/pack') return handlePack(req, res, url.searchParams);
      if (req.method === 'POST' && url.pathname === '/api/pack-exe') return handlePackExe(req, res, url.searchParams, ctx);
      return sendJson(res, 404, {error: `no route for ${req.method} ${url.pathname}`});
    };

    route().catch((error) => {
      const status = error.status || 500;
      if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, error);
      sendJson(res, status, {error: error.message || String(error)});
    });
  });
};

const listen = (server, port, host, attempt = 0) => new Promise((resolve, reject) => {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && attempt < 20) {
      resolve(listen(server, port + 1, host, attempt + 1));
    } else {
      reject(error);
    }
  });
  server.listen(port, host, () => resolve(server.address().port));
});

const main = async () => {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log('Usage: node ui/server.js [--port 8788] [--host 127.0.0.1] [--open]');
    return;
  }

  const host = arg('--host', '127.0.0.1');
  const allowAnyHost = host !== '127.0.0.1' && host !== 'localhost';
  const port = await listen(createServer({allowAnyHost}), Number(arg('--port', DEFAULT_PORT)), host);
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;

  const scaffolding = hasScaffolding(ROOT);
  console.log(`bl-packager web UI   ${url}`);
  console.log(`runtime              ${scaffolding.min ? 'vendor/scaffolding-min.js ok' : 'MISSING vendor/scaffolding-min.js'}` +
    (scaffolding.full ? ' + scaffolding-full.js ok' : ''));
  console.log(`MSVC                 ${detectMsvc() ? 'found (exe can be compiled in-page)' : 'not found (exe resources only)'}`);
  console.log('Ctrl+C to stop.');

  if (argv.includes('--open')) {
    try {
      spawn('cmd.exe', ['/c', 'start', '', url], {detached: true, stdio: 'ignore'}).unref();
    } catch {
      console.log(`(could not open a browser automatically — visit ${url})`);
    }
  }
};

module.exports = {
  createServer,
  listen,
  safeFileName,
  playerOptions,
  readExtensions,
  MAX_UPLOAD,
  MAX_EXTENSION_BYTES,
  MAX_EXTENSIONS_TOTAL
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
