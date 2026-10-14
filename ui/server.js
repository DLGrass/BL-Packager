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
  writeExeResources,
  buildExe,
  readBuiltExe,
  hasScaffolding
} = require('../src/lib/pipeline');

const UI_DIR = __dirname;
const DEFAULT_PORT = 8788;
const MAX_UPLOAD = 512 * 1024 * 1024;

const ARTIFACT_ALLOWLIST = [
  'bl-player.exe',
  'bl-player-dyn.exe',
  'app.html.gz',
  'app.meta',
  'app.rc',
  'WebView2Loader.dll'
];

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

/** The player/runtime options both targets accept, read from one place. */
const playerOptions = (params) => ({
  autoplay: flag(params, 'autoplay'),
  turbo: flag(params, 'turbo'),
  framerate: boundedInt(params, 'framerate', 30, 0, 240),
  username: str(params, 'username', 'player####')
});

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

const handleHealth = (res) => sendJson(res, 200, {
  ok: true,
  node: process.version,
  scaffolding: hasScaffolding(ROOT),
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

  const packed = packToHtml(input, {
    mode,
    inputPath: str(params, 'filename', ''),
    title,
    ...playerOptions(params),
    preload: flag(params, 'preload'),
    noDeflate: flag(params, 'noDeflate'),
    optimizePng: flag(params, 'optimizePng', true),
    // viewAssets is intentionally unreachable from the web UI: it is a
    // documented performance regression, not a feature.
    onWarn: () => {}
  });

  const resolvedTitle = safeFileName(title || defaultTitle(str(params, 'filename', '')));
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

const handlePackExe = async (req, res, params, ctx) => {
  const input = await readBody(req);
  if (!input.length) throw Object.assign(new Error('empty request body'), {status: 400});

  const wantBuild = flag(params, 'build');
  const title = str(params, 'title', '');

  const result = await serializeExe(() => {
    const started = Date.now();
    const resources = writeExeResources(input, {
      inputPath: str(params, 'filename', ''),
      title,
      width: boundedInt(params, 'width', 640, 160, 8192),
      height: boundedInt(params, 'height', 480, 160, 8192),
      gzip: flag(params, 'gzip', true),
      gzipLevel: num(params, 'gzipLevel', 9),
      devtools: flag(params, 'devtools', true),
      preload: flag(params, 'preload'),
      noDeflate: flag(params, 'noDeflate'),
      optimizePng: flag(params, 'optimizePng', true),
      ...playerOptions(params),
      root: ctx.buildRoot
    });

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
        project: pack.project.analysis,
        container: pack.containerStats,
        scaffolding: path.basename(pack.scaffoldingSource),
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

  return http.createServer((req, res) => {
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

module.exports = {createServer, listen, safeFileName, MAX_UPLOAD};

if (require.main === module) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
