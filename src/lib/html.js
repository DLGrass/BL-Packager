'use strict';

// Assembles the single-file HTML.
//
// The document order mirrors TurboWarp's packager so that both modes differ
// only in the parts we actually want to measure:
//
//   1. the scaffolding runtime, inlined
//   2. boot script: create scaffolding, configure the VM, wire controls
//   3. base85 decoder + decodeChunk + takePayload
//   4. the data, as <script data="..."> chunks
//   5. the loader runtime (BLPK reader / pure-JS inflate, when needed)
//   6. createProjectSource + run()

const fs = require('node:fs');
const path = require('node:path');

const {encodeChunk, decoderSource} = require('./base85');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');

const readRuntime = (name) => fs.readFileSync(path.join(RUNTIME_DIR, name), 'utf8');

/** Chunk size, matching upstream. Must be a multiple of 4 to avoid padding waste. */
const CHUNK_SIZE = 1024 * 64;

const escapeXML = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const escapeScriptBody = (source) => source.replace(/<\/script>/g, "</scri'+'pt>");

const DEFAULT_OPTIONS = () => ({
  mode: 'fast',
  title: 'Packaged Project',
  autoplay: false,
  turbo: false,
  framerate: 30,
  interpolation: false,
  maxClones: 300,
  fencing: true,
  miscLimits: true,
  stageWidth: 480,
  stageHeight: 360,
  username: 'player####',
  accent: '#4d97ff',
  background: '#000000',
  foreground: '#ffffff',
  controls: {greenFlag: false, stopAll: false, fullscreen: false},
  loadingText: '',
  csp: "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src * data: blob:",
  // Hand the VM owned buffers, not views into the decoded container. Required
  // for correctness and speed: see container-reader.js. `--view-assets` opts
  // back into aliasing, which exists only to demonstrate the regression.
  copyAssets: true,
  preload: false,
  instrument: false,
  // 1 = "unknown, so include": the pure-JS inflate fallback is only needed when
  // the container actually holds deflated entries. pack.js passes the real count.
  deflatedEntries: 1,
  scaffoldingSource: null,
  buildInfo: ''
});

/**
 * @param {object} project result of loadSb3()
 * @param {Buffer|Uint8Array} payload the bytes to embed (sb3 for tw, BLPK for fast)
 * @param {object} [userOptions]
 * @returns {{html: Buffer, stats: object}}
 */
const renderHtml = (project, payload, userOptions = {}) => {
  const options = Object.assign(DEFAULT_OPTIONS(), userOptions);

  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const payloadLength = bytes.length;
  const decodeBufferLength = Math.ceil(payloadLength / 4) * 4;

  if (!options.scaffoldingSource) {
    throw new Error('scaffoldingSource is required (path to scaffolding-full.js or scaffolding-min.js)');
  }
  const scaffolding = escapeScriptBody(fs.readFileSync(options.scaffoldingSource, 'utf8'));

  // --- 4. data chunks -----------------------------------------------------
  const chunks = [];
  for (let offset = 0; offset < payloadLength; offset += CHUNK_SIZE) {
    const part = bytes.subarray(offset, offset + CHUNK_SIZE);
    chunks.push(`<script data="${encodeChunk(part)}">decodeChunk(${part.length})</script>`);
  }

  // --- 5. loader runtime --------------------------------------------------
  const needsInflateFallback = options.mode === 'fast' && options.deflatedEntries !== 0;
  const loaderRuntime = [
    needsInflateFallback ? readRuntime('inflate-raw.js') : '',
    options.mode === 'fast' ? readRuntime('container-reader.js') : '',
    readRuntime('loader.js')
  ].filter(Boolean).join('\n');

  const header = `<!DOCTYPE html>
<!--
  Packaged with bl-packager.
  mode: ${options.mode}
  payload: ${payloadLength} bytes (${options.mode === 'tw' ? 'original sb3' : 'BLPK container'})
  source project: ${project.analysis.targetCount} targets, ${project.analysis.assetCount} assets, ${project.analysis.assetBytes} asset bytes
  ${options.buildInfo}
-->
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta http-equiv="Content-Security-Policy" content="${escapeXML(options.csp)}">
  <title>${escapeXML(options.title)}</title>
  <style>
    html, body { margin: 0; padding: 0; overflow: hidden; }
    body { background: ${options.background}; color: ${options.foreground}; font-family: sans-serif; }
    [hidden] { display: none !important; }
    a { color: inherit; text-decoration: underline; cursor: pointer; }
    #app, #launch, #loading, #error { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
    .screen {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      text-align: center; cursor: default; user-select: none; -webkit-user-select: none;
      background: ${options.background};
    }
    #launch { background: rgba(0, 0, 0, 0.7); cursor: pointer; }
    .green-flag {
      width: 80px; height: 80px; padding: 16px; box-sizing: border-box; border-radius: 100%;
      background: rgba(255, 255, 255, 0.75); border: 3px solid #fff;
      display: flex; align-items: center; justify-content: center;
    }
    .progress-bar-outer { border: 1px solid currentColor; height: 10px; width: 200px; }
    .progress-bar-inner { height: 100%; width: 0; background: currentColor; }
    .loading-text { font-weight: normal; font-size: 36px; margin: 0 0 16px; }
    .control-button {
      width: 2rem; height: 2rem; padding: 0.375rem; margin: 0.5rem; border: 0; border-radius: 4px;
      cursor: pointer; user-select: none; -webkit-user-select: none;
    }
    .control-button:hover { background: hsla(0, 100%, 65%, 0.15); }
    .control-button.active { background: hsla(0, 100%, 65%, 0.35); }
    #error-message, #error-stack {
      font-family: monospace; max-width: 600px; white-space: pre-wrap;
      user-select: text; -webkit-user-select: text;
    }
    #error-stack { text-align: left; max-height: 200px; overflow: auto; }
  </style>
</head>
<body>
  <div id="app"></div>

  <div id="launch" class="screen" hidden title="Click to start">
    <div class="green-flag">
      <svg viewBox="0 0 16.63 17.5" width="42" height="44">
        <path d="M.75 2A6.44 6.44 0 0 1 8.44 2h0a6.44 6.44 0 0 0 7.69 0V12.4a6.44 6.44 0 0 1-7.69 0h0a6.44 6.44 0 0 0-7.69 0" fill="#4cbf56" stroke="#45993d" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="0.75" y1="16.75" x2="0.75" y2="0.75" stroke="#45993d" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
  </div>

  <div id="loading" class="screen">
    <noscript>Enable JavaScript</noscript>
    ${options.loadingText ? `<h1 class="loading-text">${escapeXML(options.loadingText)}</h1>` : ''}
    <div class="progress-bar-outer"><div class="progress-bar-inner" id="loading-inner"></div></div>
  </div>

  <div id="error" class="screen" hidden>
    <h1>Error</h1>
    <details>
      <summary id="error-message"></summary>
      <p id="error-stack"></p>
    </details>
  </div>

  <!-- 0. benchmark hooks (a no-op in production builds) -->
  <script>${escapeScriptBody(instrumentScript(options))}</script>

  <!-- 1. Scratch runtime -->
  <script>${scaffolding}</script>

  <!-- 2. boot -->
  <script>${escapeScriptBody(bootScript(options))}</script>

  <!-- 3. base85 decoder -->
  <script>${escapeScriptBody(decoderScript(decodeBufferLength, payloadLength, options))}</script>

  <!-- 4. project payload -->
${chunks.join('\n')}

  <!-- 5+6. loader runtime and startup -->
  <script>${escapeScriptBody(`${loaderRuntime}\n${runScript(options)}`)}</script>
</body>
</html>
`;

  return {html: Buffer.from(header, 'utf8'), stats: {chunks: chunks.length, payloadLength, decodeBufferLength}};
};

// ---------------------------------------------------------------------------
// Script 0: benchmark hooks.
// Defined before anything else so t0 is the very start of script execution, and
// so boot/run can call benchMark unconditionally (one code path for both
// production and instrumented builds).
// ---------------------------------------------------------------------------
const instrumentScript = (options) => {
  if (!options.instrument) {
    return 'const benchMark = () => {};';
  }
  return `
const __bench = window.__bench = {t0: performance.now(), marks: {}, stats: {}};
const benchMark = (name) => { __bench.marks[name] = performance.now() - __bench.t0; };
const benchReport = (extra) => {
  if (extra) __bench.stats = extra;
  __bench.done = performance.now() - __bench.t0;
  const body = JSON.stringify(__bench);
  try {
    fetch('/__result', {method: 'POST', body, keepalive: true});
  } catch (e) {
    document.title = 'BENCH ' + body;
  }
};
`.trim();
};

// ---------------------------------------------------------------------------

const bootScript = (options) => `
const appElement = document.getElementById('app');
const launchScreen = document.getElementById('launch');
const loadingScreen = document.getElementById('loading');
const loadingInner = document.getElementById('loading-inner');
const errorScreen = document.getElementById('error');
const errorScreenMessage = document.getElementById('error-message');
const errorScreenStack = document.getElementById('error-stack');

const handleError = (error) => {
  console.error(error);
  if (!errorScreen.hidden) return;
  errorScreen.hidden = false;
  errorScreenMessage.textContent = '' + error;
  let debug = (error && error.stack) || 'no stack';
  debug += '\\nUser agent: ' + navigator.userAgent;
  errorScreenStack.textContent = debug;
};
const setProgress = (progress) => {
  if (loadingInner) loadingInner.style.width = (progress * 100) + '%';
};
const interpolate = (a, b, t) => a + t * (b - a);

try {
  ${options.instrument ? "benchMark('boot');" : ''}

  const scaffolding = new Scaffolding.Scaffolding();
  scaffolding.width = ${options.stageWidth};
  scaffolding.height = ${options.stageHeight};
  scaffolding.resizeMode = 'preserve-ratio';
  scaffolding.editableLists = false;
  scaffolding.setup();
  scaffolding.appendTo(appElement);

  const vm = scaffolding.vm;
  window.scaffolding = scaffolding;
  window.vm = vm;
  window.Scratch = {
    vm,
    renderer: vm.renderer,
    audioEngine: vm.runtime.audioEngine,
    bitmapAdapter: vm.runtime.v2BitmapAdapter,
    videoProvider: vm.runtime.ioDevices.video.provider
  };

  scaffolding.setUsername(${JSON.stringify(options.username)}.replace(/#/g, () => Math.floor(Math.random() * 10)));
  scaffolding.setAccentColor(${JSON.stringify(options.accent)});

  vm.setTurboMode(${options.turbo});
  if (vm.setInterpolation) vm.setInterpolation(${options.interpolation});
  if (vm.setFramerate) vm.setFramerate(${options.framerate});
  if (vm.setRuntimeOptions) {
    vm.setRuntimeOptions({
      fencing: ${options.fencing},
      miscLimits: ${options.miscLimits},
      maxClones: ${options.maxClones}
    });
  }
  if (vm.renderer.setMaxTextureDimension) vm.renderer.setMaxTextureDimension(2048);
  if (vm.runtime.setEnforcePrivacy) vm.runtime.setEnforcePrivacy(false);
  scaffolding.setExtensionSecurityManager({
    getSandboxMode: () => 'unsandboxed',
    canLoadExtensionFromProject: () => true
  });

  ${options.controls.greenFlag ? `
  const greenFlagButton = document.createElement('img');
  greenFlagButton.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16.63 17.5"><path d="M.75 2a6.44 6.44 0 017.69 0h0a6.44 6.44 0 007.69 0v10.4a6.44 6.44 0 01-7.69 0h0a6.44 6.44 0 00-7.69 0" fill="#4cbf56" stroke="#45993d" stroke-linecap="round" stroke-linejoin="round"/><path stroke-width="1.5" fill="#4cbf56" stroke="#45993d" stroke-linecap="round" stroke-linejoin="round" d="M.75 16.75v-16"/></svg>');
  greenFlagButton.className = 'control-button';
  greenFlagButton.draggable = false;
  greenFlagButton.addEventListener('click', () => scaffolding.greenFlag());
  scaffolding.addEventListener('PROJECT_RUN_START', () => greenFlagButton.classList.add('active'));
  scaffolding.addEventListener('PROJECT_RUN_STOP', () => greenFlagButton.classList.remove('active'));
  scaffolding.addControlButton({element: greenFlagButton, where: 'top-left'});
  ` : ''}

  ${options.controls.stopAll ? `
  const stopAllButton = document.createElement('img');
  stopAllButton.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><path fill="#ec5959" stroke="#b84848" stroke-linecap="round" stroke-linejoin="round" d="M4.3.5h5.4l3.8 3.8v5.4l-3.8 3.8H4.3L.5 9.7V4.3z"/></svg>');
  stopAllButton.className = 'control-button';
  stopAllButton.draggable = false;
  stopAllButton.addEventListener('click', () => scaffolding.stopAll());
  scaffolding.addControlButton({element: stopAllButton, where: 'top-left'});
  ` : ''}

  ${options.controls.fullscreen ? `
  if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
    const fullscreenButton = document.createElement('img');
    fullscreenButton.className = 'control-button';
    fullscreenButton.draggable = false;
    let isFullscreen = false;
    const updateFullscreen = () => {
      isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
      document.body.classList.toggle('is-fullscreen', isFullscreen);
    };
    fullscreenButton.addEventListener('click', () => {
      if (isFullscreen) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        const el = document.body;
        (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
      }
    });
    document.addEventListener('fullscreenchange', updateFullscreen);
    document.addEventListener('webkitfullscreenchange', updateFullscreen);
    scaffolding.addControlButton({element: fullscreenButton, where: 'top-right'});
  }
  ` : ''}
} catch (e) {
  handleError(e);
}
`;

const decoderScript = (decodeBufferLength, payloadLength, options) => `
${decoderSource()}
let projectDecodeBuffer = new ArrayBuffer(${decodeBufferLength});
let projectDecodeIndex = 0;
const PROJECT_PAYLOAD_LENGTH = ${payloadLength};

const decodeChunk = (size) => {
  try {
    if (!document.currentScript || document.currentScript.tagName.toUpperCase() !== 'SCRIPT') {
      throw new Error('document.currentScript is not a script');
    }
    base85decode(document.currentScript.getAttribute('data'), projectDecodeBuffer, projectDecodeIndex);
    document.currentScript.remove();
    projectDecodeIndex += size;
    setProgress(interpolate(0.1, 0.75, projectDecodeIndex / PROJECT_PAYLOAD_LENGTH));
  } catch (e) {
    handleError(e);
  }
};

// The decoder pads its buffer to a multiple of 4, so hand out the exact length.
const takePayload = () => {
  const buffer = projectDecodeBuffer;
  projectDecodeBuffer = null;
  return {buffer, length: PROJECT_PAYLOAD_LENGTH};
};
`;

const runScript = (options) => `
const projectSource = createProjectSource({
  mode: ${JSON.stringify(options.mode)},
  storage: scaffolding.storage,
  vm,
  Scaffolding: (typeof Scaffolding !== 'undefined' ? Scaffolding : undefined),
  takePayload,
  copyAssets: ${options.copyAssets},
  preload: ${options.preload}
});

const getProjectData = projectSource.getProjectData;

// Asset progress, so the loading bar covers asset loading too.
const storage = scaffolding.storage;
storage.onprogress = (total, loaded) => {
  if (total > 0) setProgress(interpolate(0.75, 1, loaded / total));
};

const run = async () => {
  benchMark('decoded');
  const projectData = await getProjectData();
  benchMark('projectData');
  if (projectSource.warmUp) projectSource.warmUp();
  await scaffolding.loadProject(projectData);
  benchMark('projectLoaded');
  setProgress(1);
  loadingScreen.hidden = true;
  if (${options.autoplay}) {
    scaffolding.start();
  } else {
    launchScreen.hidden = false;
    launchScreen.addEventListener('click', () => {
      launchScreen.hidden = true;
      scaffolding.start();
    });
    launchScreen.focus();
  }
  benchMark('started');
  ${options.instrument ? 'benchReport(projectSource.stats());' : ''}
};

run().catch((error) => {
  handleError(error);
  ${options.instrument ? 'benchReport({error: String(error)});' : ''}
});
`;

module.exports = {renderHtml, DEFAULT_OPTIONS, CHUNK_SIZE, escapeXML};
