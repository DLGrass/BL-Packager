'use strict';

// Headless benchmark runner.
//
// Serves out/bench over HTTP (the instrumented pages POST their timings back to
// /__result), then opens each variant in headless Edge one run at a time and
// collects the marks.
//
//   node bench/run.js                  # every *.html under out/bench, 3 runs each
//   node bench/run.js --runs=5
//   node bench/run.js --only=fast
//
// Marks are relative to the first line of script the page executes:
//   boot          scaffolding constructed and configured
//   decoded       base85 payload fully decoded (same work in every variant)
//   projectData   project.json handed to the VM
//   projectLoaded VM finished loadProject -> every costume and sound is in
//                 (this is the "how long until the project is ready" number)
//   done          benchmark payload posted

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BENCH_DIR = path.join(ROOT, 'out', 'bench');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

const parseArgs = () => {
  const options = {runs: 3, timeout: 240000, only: null};
  for (const arg of process.argv.slice(2)) {
    const match = /^--([a-z-]+)=([\s\S]*)$/.exec(arg);
    if (!match) continue;
    const [, key, value] = match;
    if (key === 'runs') options.runs = Math.max(1, parseInt(value, 10) || 1);
    else if (key === 'timeout') options.timeout = Math.max(10000, parseInt(value, 10) || 0);
    else if (key === 'only') options.only = value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return options;
};

const findBrowser = () => {
  for (const candidate of EDGE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('no Chromium-based browser found; edit EDGE_CANDIDATES in bench/run.js');
};

const findVariants = () => {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) {
        const group = path.relative(BENCH_DIR, dir).split(path.sep).pop() || 'root';
        found.push({
          id: `${group}/${entry.name}`,
          file: full,
          url: '/' + path.relative(BENCH_DIR, full).split(path.sep).join('/')
        });
      }
    }
  };
  walk(BENCH_DIR);
  return found.sort((a, b) => a.id.localeCompare(b.id));
};

const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json'};

const startServer = () => new Promise((resolve) => {
  let onResult = null;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/__result') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(204);
        res.end();
        if (onResult) {
          const handler = onResult;
          onResult = null;
          handler(body);
        }
      });
      return;
    }

    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const filePath = path.join(BENCH_DIR, urlPath);
    if (!filePath.startsWith(BENCH_DIR) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': fs.statSync(filePath).size
    });
    fs.createReadStream(filePath).pipe(res);
  });

  server.listen(0, '127.0.0.1', () => {
    resolve({
      port: server.address().port,
      waitForResult: () => new Promise((res) => { onResult = res; }),
      close: () => server.close()
    });
  });
});

const runOnce = async (browser, server, variant, runIndex, timeout) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blbench-'));
  const url = `http://127.0.0.1:${server.port}${variant.url}?run=${runIndex}`;
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--mute-audio',
    '--window-size=800,600',
    `--user-data-dir=${userDataDir}`,
    url
  ];

  const child = spawn(browser, args, {stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const resultPromise = server.waitForResult();
  const timer = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${timeout}ms`)), timeout);
  });

  try {
    const body = await Promise.race([resultPromise, timer]);
    return JSON.parse(body);
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    try {
      fs.rmSync(userDataDir, {recursive: true, force: true});
    } catch (error) {
      // Windows sometimes holds the profile dir briefly; not worth failing on.
    }
  }
};

const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const fmt = (value) => (value === undefined || value === null ? '   -   ' : `${value.toFixed(0)} ms`.padStart(9));

const main = async () => {
  const options = parseArgs();
  const browser = findBrowser();
  // Match the variant's directory exactly: a substring test would let `--only=preload`
  // also pull in a `nopreload/` directory.
  const variants = findVariants().filter((v) =>
    !options.only || options.only.includes(v.id.split('/')[0]));

  if (variants.length === 0) {
    console.error(`no variants found under ${BENCH_DIR}`);
    process.exit(1);
  }

  const server = await startServer();
  console.log(`browser   ${browser}`);
  console.log(`server    http://127.0.0.1:${server.port}`);
  console.log(`variants  ${variants.length}, runs each ${options.runs}\n`);

  const report = {};

  // Interleave: run every variant once per round instead of running one
  // variant's runs back to back. Machine speed drifts over minutes (thermal,
  // background load), and a back-to-back layout attributes that drift to
  // whichever variant happened to run later. Round-robin makes every variant
  // sample the same spread of conditions.
  const runsById = new Map(variants.map((v) => [v.id, []]));

  for (let i = 0; i < options.runs; i++) {
    for (const variant of variants) {
      process.stdout.write(`  round ${i + 1}/${options.runs}  ${variant.id} ... `);
      try {
        const result = await runOnce(browser, server, variant, i, options.timeout);
        runsById.get(variant.id).push(result);
        const marks = result.marks || {};
        console.log(`${fmt(marks.projectLoaded)} loaded   (projectData ${fmt(marks.projectData)}, done ${fmt(result.done)})`);
      } catch (error) {
        console.log(`FAILED: ${error.message}`);
        runsById.get(variant.id).push(null);
      }
    }
  }

  for (const variant of variants) {
    const runs = runsById.get(variant.id);
    const good = runs.filter(Boolean);
    report[variant.id] = {
      runs: good.length,
      marks: {},
      stats: good.length ? good[good.length - 1].stats : null,
      errors: runs.filter((r) => r && r.stats && r.stats.error).map((r) => r.stats.error)
    };
    for (const mark of ['boot', 'decoded', 'projectData', 'projectLoaded', 'started', 'done']) {
      const values = good.map((r) => (mark === 'done' ? r.done : (r.marks || {})[mark])).filter((v) => typeof v === 'number');
      if (values.length) {
        const sorted = values.slice().sort((a, b) => a - b);
        report[variant.id].marks[mark] = {
          median: median(values),
          min: sorted[0],
          max: sorted[sorted.length - 1],
          values
        };
      }
    }
  }

  console.log('\n=== summary (median ms from first script statement) ===\n');
  const header = ['variant', 'decoded', 'project.json', 'ALL LOADED', 'min..max'];
  console.log(
    `${header[0].padEnd(26)}${header[1].padStart(11)}${header[2].padStart(14)}` +
    `${header[3].padStart(12)}${header[4].padStart(22)}`
  );
  for (const [id, data] of Object.entries(report)) {
    const loaded = data.marks.projectLoaded;
    console.log(
      `${id.padEnd(26)}` +
      `${fmt(data.marks.decoded && data.marks.decoded.median)}` +
      `${fmt(data.marks.projectData && data.marks.projectData.median)}` +
      `${fmt(loaded && loaded.median)}` +
      `${loaded ? `${loaded.min.toFixed(0)}..${loaded.max.toFixed(0)}`.padStart(22) : ' '.repeat(22)}`
    );
  }

  const outPath = path.join(BENCH_DIR, 'results.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nraw results -> ${outPath}`);

  server.close();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
