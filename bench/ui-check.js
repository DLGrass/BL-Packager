'use strict';

// Drive the web UI (ui/) in a real browser over the DevTools protocol.
//
//   node bench/ui-check.js                                   # out/bench/bench.sb3, HTML
//   node bench/ui-check.js --target exe                      # the exe resource path
//   node bench/ui-check.js --sb3 out/bench/bench.sb3 --shot out/ui.png
//   node bench/ui-check.js --theme dark --shot out/ui-dark.png
//   node bench/ui-check.js --site --shot out/site.png        # the static site
//
// test/run.js covers the HTTP API but stops at the socket: it cannot tell
// whether the page's own wiring works — the drop handler, the option plumbing,
// the blob download. Only a browser can. So this starts the server in-process on
// an ephemeral port, opens the page in headless Edge, sets the file input
// through DOM.setFileInputFiles (a real file, not a synthetic File object),
// clicks 打包, waits for the page to report success, and then reads the
// *downloaded blob's byte length* back out of the page.
//
// That last step is the point: the assertion is that the bytes the browser ends
// up holding equal what src/pack.js writes for the same project. With --site the
// page packs through a Worker instead of the server, so the two numbers cannot be
// equal (the bundle carries its own deflate); the assertion there is that the
// page really took the local path and that the artifact is the right order of
// magnitude, with both numbers printed for the record.

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {spawn} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const {createServer, listen} = require('../ui/server');
const {packToHtml} = require('../src/lib/pipeline');

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const findBrowser = () => {
  for (const candidate of BROWSER_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('no Chromium-based browser found; edit BROWSER_CANDIDATES');
};

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const {port} = probe.address();
    probe.close(() => resolve(port));
  });
});

const getJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
    });
  }).on('error', reject);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The site is static files only; Pages would serve them exactly like this.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json'
};

const staticServer = (root) => http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root))) {
    res.writeHead(403);
    res.end('outside the site');
    return;
  }
  fs.readFile(file, (error, bytes) => {
    if (error) {
      res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': bytes.length
    });
    res.end(bytes);
  });
});

/** Minimal CDP client: Node 22 ships a global WebSocket, so no dependency. */
const connect = async (wsUrl) => {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, {once: true});
    ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), {once: true});
  });

  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = message.id && pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
    else waiter.resolve(message.result);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, {resolve, reject});
    ws.send(JSON.stringify({id, method, params}));
  });

  const evaluate = async (expression, awaitPromise = false) => {
    const result = await send('Runtime.evaluate', {expression, awaitPromise, returnByValue: true});
    if (result.exceptionDetails) {
      throw new Error(`page threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    }
    return result.result.value;
  };

  return {ws, send, evaluate};
};

/**
 * Connect to *our* page, not merely the first one that shows up. A fresh
 * Chromium profile can briefly expose more than one page target, and attaching
 * to the wrong one looks exactly like "the page did not load".
 */
const waitForTarget = async (port, expectedUrl, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  let fallback = null;
  while (Date.now() < deadline) {
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      const match = pages.find((t) => t.url && t.url.startsWith(expectedUrl));
      if (match) return match;
      if (pages.length && !fallback) fallback = pages[0];
    } catch { /* the debug endpoint is not listening yet */ }
    await sleep(150);
  }
  if (fallback) return fallback;
  throw new Error('no page target appeared on the debug port');
};

// Every option the page offers, by the id of its control. Kept here rather than
// scraped from the DOM so that a control disappearing is a failure and not just
// a shorter list.
const CONTROL_IDS = [
  // 运行选项
  'turbo', 'framerate', 'interpolation', 'highQualityPen', 'infiniteClones',
  'removeFencing', 'removeMiscLimits', 'username', 'closeWhenStopped',
  'stageWidth', 'stageHeight',
  // 展示选项
  'title', 'progressBar', 'loadingText', 'autoplay',
  'controlGreenFlag', 'controlStopAll', 'controlPause', 'controlFullscreen',
  'background', 'foreground', 'accent',
  'editableLists', 'variableColor', 'listColor',
  // 云变量
  'projectId',
  // 高级选项
  'compilerEnabled', 'warpTimer', 'customCSS', 'customJS', 'packagedRuntime', 'bigTexture',
  // 本打包器专用
  'mode', 'optimizePng', 'noDeflate', 'preload',
  // 运行环境 / 应用设置
  'width', 'height', 'devtools', 'build'
];

const RADIO_NAMES = ['target', 'resizeMode', 'cursor', 'cloudMode'];

const main = async () => {
  const sb3Path = path.resolve(arg('--sb3', path.join(ROOT, 'out', 'bench', 'bench.sb3')));
  const shotPath = arg('--shot', null);
  const theme = arg('--theme', null);
  const target = arg('--target', 'html') === 'exe' ? 'exe' : 'html';
  const siteMode = argv.includes('--site');
  if (siteMode && target === 'exe') throw new Error('--site has no exe target: the site hides it on purpose');
  if (!fs.existsSync(sb3Path)) {
    throw new Error(`${sb3Path} not found — run: node bench/make-project.js`);
  }
  const sb3 = fs.readFileSync(sb3Path);
  const fileName = path.basename(sb3Path);
  console.log(`check       ${fileName} -> ${target}${siteMode ? ' (static site)' : ''}`);

  // What the CLI would produce for this project with the UI's defaults. For the
  // exe target the artifact the page offers is the gzipped resource, not the HTML.
  // The site defaults PNG recompression off, so the reference has to match.
  const expectedHtml = packToHtml(sb3, {
    mode: 'fast',
    inputPath: fileName,
    optimizePng: siteMode ? false : true
  }).html;
  const expectedBytes = target === 'exe'
    ? zlib.gzipSync(expectedHtml, {level: 9}).length
    : expectedHtml.length;
  // Without --build the page cannot offer an exe, so the first download is the
  // resource itself. Match it by name rather than by position. The links live on
  // the status line (`#downloads`), not in a result card.
  const artifactSelector = target === 'exe'
    ? '#downloads a[download="app.html.gz"]'
    : '#downloads a[download]';

  if (siteMode && !fs.existsSync(path.join(ROOT, 'site', 'app.js'))) {
    throw new Error('site/app.js is missing — run: node src/build-site.js');
  }

  const server = siteMode ? staticServer(path.join(ROOT, 'site')) : createServer();
  const uiPort = await listen(server, 0, '127.0.0.1');
  const uiUrl = `http://127.0.0.1:${uiPort}/`;
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-ui-check-'));

  const browser = spawn(findBrowser(), [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=1240,1900',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    uiUrl
  ], {stdio: ['ignore', 'ignore', 'pipe']});

  let browserStderr = '';
  browser.stderr.on('data', (chunk) => { browserStderr += chunk; });

  let cdp = null;
  try {
    // NB: not `target` — that name belongs to the --target CLI option, and
    // shadowing it here is a trap this script already fell into once.
    const pageTarget = await waitForTarget(debugPort, uiUrl);
    cdp = await connect(pageTarget.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');

    // The report lives in collapsed <details> now, so innerText is empty until
    // they are opened. A user clicks them; so do we.
    const readText = async (selector) => {
      await cdp.evaluate(`document.querySelectorAll('details').forEach((d) => { d.open = true; })`);
      return cdp.evaluate(`(document.querySelector('${selector}') || {}).innerText || ''`)
        .then((text) => text.replace(/\s+/g, ' ').trim());
    };

    if (theme === 'light' || theme === 'dark') {
      // The page picks its theme from <head>, before the first paint, so it has
      // to be seeded before a load — poking the attribute in afterwards would
      // not tell us whether the boot path works. This drives the same
      // localStorage key the footer's theme selector writes.
      await cdp.send('Page.enable');
      await cdp.evaluate(`localStorage.setItem('BLPackager.theme', ${JSON.stringify(theme)})`);
      await cdp.send('Page.reload');
      await sleep(400);
      const applied = await cdp.evaluate(`document.documentElement.getAttribute('theme')`);
      if (applied !== theme) throw new Error(`asked for the ${theme} theme, page booted as ${applied}`);
      const accent = await cdp.evaluate(
        `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
      console.log(`theme       ${applied} (--accent ${accent})`);
    }

    const ready = Date.now() + 15000;
    while (Date.now() < ready) {
      if (await cdp.evaluate('document.readyState') === 'complete') break;
      await sleep(100);
    }

    // `readyState === 'complete'` and "the parser has actually put #fileInput in
    // the document" are not the same event, and the debugger can attach while
    // the page is still being replaced. Poll for the element itself; a single
    // DOM.querySelector here is a race that has produced a false
    // "the page did not load" before.
    // A DOM node id belongs to one document. If the page is still finishing its
    // first navigation between DOM.getDocument and the query -- or anything
    // reloads it in between -- CDP answers -32000 "Could not find node with
    // given id" and the run dies with nothing else in the output. That is a
    // race, not a page bug: it showed up on a CI runner that attaches the
    // debugger about nine seconds into the load, and never on the machine this
    // was written on. So every query is re-anchored on a fresh root instead of
    // trusting the id obtained earlier.
    const findNode = async (selector) => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const {root} = await cdp.send('DOM.getDocument');
        try {
          const found = await cdp.send('DOM.querySelector', {nodeId: root.nodeId, selector});
          if (found.nodeId) return found.nodeId;
        } catch (error) {
          if (!/Could not find node with given id/.test(String((error && error.message) || error))) throw error;
        }
        await sleep(250);
      }
      return 0;
    };

    let nodeId = 0;
    const inputDeadline = Date.now() + 20000;
    while (Date.now() < inputDeadline && !nodeId) {
      nodeId = await findNode('#fileInput');
      if (!nodeId) await sleep(200);
    }
    if (!nodeId) {
      const seen = await cdp.evaluate(`JSON.stringify({
        url: location.href,
        title: document.title,
        ids: [...document.querySelectorAll('[id]')].map((el) => el.id).slice(0, 20)
      })`);
      throw new Error(`#fileInput never appeared — ${seen}`);
    }

    // --- structural checks -------------------------------------------------
    // The page was rebuilt against TurboWarp's option inventory: 作品 and
    // 打包结果 are gone, the download link sits on the status line, and every
    // option the pipeline honours has a control. All three are easy to undo by
    // accident, so they are asserted rather than eyeballed.
    const structure = JSON.parse(await cdp.evaluate(`JSON.stringify({
      removed: ['projectCard', 'resultCard', 'downloadsHint'].filter((id) => document.getElementById(id)),
      downloadsInStatus: !!document.querySelector('#statusCard #downloads'),
      missing: ${JSON.stringify(CONTROL_IDS)}.filter((id) => !document.getElementById(id)),
      missingRadios: ${JSON.stringify(RADIO_NAMES)}.filter((name) =>
        !document.querySelector('input[name="' + name + '"]'))
    })`));
    if (structure.removed.length) {
      throw new Error(`cards that should be gone are still in the page: ${structure.removed.join(', ')}`);
    }
    if (!structure.downloadsInStatus) throw new Error('#downloads is not on the status line');
    if (structure.missing.length || structure.missingRadios.length) {
      throw new Error(`options with no control: ${structure.missing.concat(structure.missingRadios).join(', ')}`);
    }
    console.log(`page        ${CONTROL_IDS.length + RADIO_NAMES.length} option controls present, ` +
      '2 cards removed, download link on the status line');

    // The three checkboxes that are not wire options have to survive the trip
    // through readOptions(), and 重置全部 has to put them back.
    const derived = JSON.parse(await cdp.evaluate(`(() => {
      document.getElementById('infiniteClones').checked = true;
      document.getElementById('removeFencing').checked = true;
      document.getElementById('bigTexture').checked = true;
      document.querySelector('input[name="cursor"][value="none"]').checked = true;
      document.querySelector('input[name="cloudMode"][value="local"]').checked = true;
      const on = readOptions();
      document.getElementById('resetBtn').click();
      const off = readOptions();
      return JSON.stringify({
        on: {
          infinite: on.maxClones === Infinity, fencing: on.fencing,
          texture: on.maxTextureDimension, cursor: on.cursor, cloud: on.cloudMode
        },
        off: {
          clones: off.maxClones, fencing: off.fencing,
          texture: off.maxTextureDimension, cursor: off.cursor, cloud: off.cloudMode
        }
      });
    })()`));

    const expectedOn = {infinite: true, fencing: false, texture: 4096, cursor: 'none', cloud: 'local'};
    const expectedOff = {clones: 300, fencing: true, texture: 2048, cursor: 'auto', cloud: 'off'};
    if (JSON.stringify(derived.on) !== JSON.stringify(expectedOn) ||
        JSON.stringify(derived.off) !== JSON.stringify(expectedOff)) {
      throw new Error(`the derived switches do not round trip: ${JSON.stringify(derived)}`);
    }
    console.log('page        derived switches map to maxClones/fencing/maxTextureDimension and reset');

    // A real file, handed to the input the drop handler feeds. Re-resolved
    // rather than reusing the id from above: the structural checks in between
    // take a while, and a stale id here fails with the same unhelpful -32000.
    const inputNode = await findNode('#fileInput') || nodeId;
    await cdp.send('DOM.setFileInputFiles', {files: [sb3Path], nodeId: inputNode});
    await sleep(300);

    const readSelection = () => cdp.evaluate(`JSON.stringify({
      name: document.getElementById('dropTitle').textContent,
      canLoad: !document.getElementById('loadBtn').disabled
    })`).then(JSON.parse);

    let selection = await readSelection();
    if (!selection.canLoad) {
      // Chromium normally fires input+change for us; if this build does not,
      // dispatch it so the page's own handler runs.
      await cdp.evaluate(`document.getElementById('fileInput').dispatchEvent(new Event('change'))`);
      await sleep(200);
      selection = await readSelection();
    }
    if (!selection.canLoad) throw new Error('the 载入作品 button stayed disabled after a file was chosen');
    console.log(`page        ${selection.name}`);

    // The upstream UI loads the project in-page before it shows any options.
    // Here the archive has to be parsed server-side, so loading is a round trip.
    await cdp.evaluate(`document.getElementById('loadBtn').click()`);
    const loadDeadline = Date.now() + 120000;
    let armed = null;
    while (Date.now() < loadDeadline) {
      armed = JSON.parse(await cdp.evaluate(`JSON.stringify({
        options: !document.getElementById('optionsRoot').classList.contains('hidden'),
        packable: !document.getElementById('packBtn').disabled,
        failed: document.getElementById('statusCard').classList.contains('error'),
        title: document.getElementById('title').value
      })`));
      if (armed.options && armed.packable) break;
      if (armed.failed) {
        throw new Error(`loading the project failed: ${await cdp.evaluate(`document.getElementById('status').textContent`)}`);
      }
      await sleep(200);
    }
    if (!armed.options || !armed.packable) throw new Error('the options never appeared after loading');
    console.log(`page        loaded, title field "${armed.title}"`);
    console.log(`project     ${await readText('#projectStats')}`);

    if (target === 'exe') {
      await cdp.evaluate(`document.querySelector('input[name="target"][value="exe"]').click()`);
      await sleep(400);
      const tab = JSON.parse(await cdp.evaluate(`JSON.stringify({
        target: document.querySelector('input[name="target"]:checked').value,
        appSettings: !document.getElementById('appSettings').classList.contains('hidden'),
        previewHidden: document.getElementById('previewBtn').classList.contains('hidden')
      })`));
      console.log(`page        target -> ${tab.target}, 应用设置 visible: ${tab.appSettings}, 预览 hidden: ${tab.previewHidden}`);
      if (tab.target !== 'exe' || !tab.appSettings) {
        throw new Error(`selecting the EXE environment did not take effect: ${JSON.stringify(tab)}`);
      }
    }

    const chosenTarget = await cdp.evaluate(`document.querySelector('input[name="target"]:checked').value`);
    console.log(`page        packing with target=${chosenTarget}`);
    await cdp.evaluate(`document.getElementById('packBtn').click()`);

    const deadline = Date.now() + 180000;
    let status = '';
    let failed = false;
    while (Date.now() < deadline) {
      status = await cdp.evaluate(`document.getElementById('status').textContent`);
      failed = await cdp.evaluate(`document.getElementById('statusCard').classList.contains('error')`);
      if (status.includes('打包完成') || failed) break;
      await sleep(400);
    }
    if (failed) throw new Error(`the page reported a failure: ${status}`);
    if (!status.includes('打包完成')) throw new Error(`packing did not finish: ${status}`);

    // Pull the artifact back out of the page: this is the browser's own copy,
    // produced by its own fetch -> blob -> anchor path.
    const result = JSON.parse(await cdp.evaluate(`(async () => {
      const link = document.querySelector('${artifactSelector}');
      const bytes = link
        ? await fetch(link.href).then((r) => r.arrayBuffer()).then((b) => b.byteLength)
        : null;
      return JSON.stringify({
        bytes,
        download: link ? link.getAttribute('download') : null,
        links: [...document.querySelectorAll('#downloads a')].map((a) => a.getAttribute('download')),
        status: document.getElementById('status').textContent,
        onStatusLine: !!document.querySelector('#statusCard #downloads a[download]')
      });
    })()`, true));

    if (result.bytes === null) {
      throw new Error(`no "${artifactSelector}" link — status "${result.status}", ` +
        `links ${JSON.stringify(result.links)}`);
    }
    if (!result.onStatusLine) throw new Error('the download link is not on the status line');

    console.log(`page        ${status}`);
    console.log(`report      ${await readText('#stats')}`);
    console.log(`download    ${result.download}  ${result.bytes} bytes`);
    console.log(`cli         ${expectedBytes} bytes`);
    const buildLog = await readText('#log');
    if (buildLog) console.log(`log         ${buildLog}`);

    // The site has to have taken the local path. If a stray fetch('/api/pack')
    // ever crept back in, the page would 404 on Pages and this is what would say
    // so, instead of a size comparison that happens to pass.
    let matches;
    if (siteMode) {
      const client = JSON.parse(await cdp.evaluate(`JSON.stringify({
        local: !!window.__BL_LOCAL__,
        version: window.__BL_VERSION__,
        line: document.getElementById('versionLine').textContent
      })`));
      if (!client.local) throw new Error('window.__BL_LOCAL__ is missing: the page would call a server that is not there');
      if (!client.line.includes('浏览器内打包')) {
        throw new Error(`the version line still claims a local server: ${client.line}`);
      }
      console.log(`client      ${client.line}`);

      // Not byte equality: the bundle's encoder is fixed-Huffman, so its output
      // is a little larger. A band is the honest assertion -- wide enough to
      // survive an encoder tweak, narrow enough to catch a truncated artifact.
      const ratio = result.bytes / expectedBytes;
      matches = ratio > 0.9 && ratio < 1.25;
      console.log(`delta       ${(100 * ratio).toFixed(1)}% of the CLI artifact` +
        ` (the bundle carries its own deflate)`);
      console.log(matches
        ? 'MATCH       the page packed in the browser and produced a plausible artifact'
        : `MISMATCH    ${result.bytes} bytes is not within 0.9-1.25x ${expectedBytes}`);
    } else {
      matches = result.bytes === expectedBytes;
      console.log(matches
        ? 'MATCH       the browser downloaded exactly what the CLI writes'
        : `MISMATCH    ${result.bytes} vs ${expectedBytes}`);
    }

    if (shotPath) {
      // The page is far taller than the headless window, and the interesting
      // part (the download links, the size report) is at the bottom. Growing
      // the viewport for the capture gets the whole thing in one image.
      const height = await cdp.evaluate('Math.min(8000, Math.max(1200, document.documentElement.scrollHeight + 40))');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1240, height, deviceScaleFactor: 1, mobile: false
      });
      await sleep(400);
      const shot = await cdp.send('Page.captureScreenshot');
      fs.mkdirSync(path.dirname(path.resolve(shotPath)), {recursive: true});
      fs.writeFileSync(path.resolve(shotPath), Buffer.from(shot.data, 'base64'));
      console.log(`shot        ${path.resolve(shotPath)} (1240x${height})`);
    }

    process.exitCode = matches ? 0 : 1;
  } finally {
    if (cdp) cdp.ws.close();
    browser.kill();
    await Promise.race([
      new Promise((resolve) => browser.once('exit', resolve)),
      sleep(2000)
    ]);
    server.closeAllConnections?.();
    server.close();
    try { fs.rmSync(profile, {recursive: true, force: true}); } catch { /* the browser may still hold it */ }
    if (process.exitCode) console.error(`browser stderr (tail): ${browserStderr.slice(-400)}`);
  }
};

main().catch((error) => {
  console.error(`error: ${error.message}`);
  if (process.env.DEBUG) console.error(error.stack);
  // Not process.exit(1): stdout is async when it is a pipe, and exiting would
  // discard whatever has not been flushed yet — which is exactly the diagnostic
  // output this script exists to produce.
  process.exitCode = 1;
});
