#!/usr/bin/env node
'use strict';

// sb3 -> single-file Windows .exe.
//
//   node src/pack-exe.js project.sb3 -o out/project.exe
//   node src/pack-exe.js project.sb3 --title "My Game" --width 800 --height 600 --build
//
// What this does, and why each step exists:
//
//   1. Reuse the normal HTML pipeline. The exe runs exactly the artifact the
//      HTML packager produces, so the two can never drift.
//   2. gzip that HTML into one RT_RCDATA resource, so the payload stays
//      compressed inside the exe at no cost to the host. The host does NOT get
//      to declare `Content-Encoding: gzip` and be done with it: WebView2 skips
//      HTTP content decoding for injected responses (README 6.2), so a tiny
//      bootstrap page inflates the resource itself.
//   3. Emit app.rc + app.meta and hand off to exe/build.cmd (MSVC).
//
// The size story is therefore:  exe = host code + gzip(packed html) + resources.

const fs = require('node:fs');
const path = require('node:path');

const {
  defaultTitle,
  human,
  writeExeResources,
  buildExe,
  readBuiltExe,
  resolveIcon,
  resolveImage,
  loadOptionSet,
  WINDOW_MODES
} = require('./lib/pipeline');
const {collectExtensions} = require('./lib/extension-source');

const USAGE = `
Usage: node src/pack-exe.js <project.sb3> [options]

Options:
  -o, --out <file>       output exe path        (default: out/<title>.exe)
      --title <text>     window title           (default: derived from the file name)
      --width <n>        window width           (default: 640)
      --height <n>       window height          (default: 480)
      --window-mode <m>  window | maximize | fullscreen      (default: window)
      --icon <file.ico>  application icon (Explorer, title bar, taskbar)
      --version <x.y.z>  file version shown in the exe's properties
      --options <spec>   JSON of the runtime/player options, or @file.json
                         (the shape the web UI's 导出 button writes) — an exe is
                         the same page in a WebView, so it takes the same ones
      --extension <spec> bake a custom extension in (a .js path or a URL);
                         repeatable, same as in src/pack.js
      --loading-image <f>, --cursor-image <f>, --pointerlock, --gamepad, …
                         see "node src/pack.js --help"
      --preload          warm compressed assets in parallel (see README)
      --no-deflate       store every container entry raw
      --no-optimize-png  keep PNG assets exactly as stored in the sb3. By
                         default they are losslessly re-encoded, which is
                         usually the single largest saving available because
                         PNG is the dominant asset class in a real project
      --no-gzip          store the HTML resource uncompressed (debugging aid)
      --gzip-level <n>   resource compression level, 1-9 (default: 9)
      --devtools <0|1>   allow F12 devtools     (default: 1)
      --probe <file>     smoke test: launch the exe, ask the live VM how many
                         targets it built, write the answer to <file>, exit
      --build            compile the exe with exe/build.cmd. Opt-in because a
                         sandbox may block spawning cmd.exe from Node; running
                         exe/build.cmd yourself always works
      --json             print stats as JSON
  -h, --help
`.trim();

const parseArgs = (argv) => {
  const options = {positional: []};
  const flat = [];
  for (const arg of argv) {
    const m = /^(--[a-z-]+)=([\s\S]*)$/.exec(arg);
    if (m) flat.push(m[1], m[2]); else flat.push(arg);
  }
  for (let i = 0; i < flat.length; i++) {
    const arg = flat[i];
    const next = () => {
      const v = flat[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case '-o': case '--out': options.out = next(); break;
      case '--title': options.title = next(); break;
      case '--width': options.width = Number(next()); break;
      case '--height': options.height = Number(next()); break;
      case '--window-mode': options.windowMode = next(); break;
      case '--icon': options.icon = next(); break;
      case '--version': options.version = next(); break;
      case '--options': options.options = next(); break;
      case '--extension':
        (options.extensions = options.extensions || []).push(next());
        break;
      case '--loading-image': options.loadingImage = next(); break;
      case '--loading-image-mode': options.loadingImageMode = next(); break;
      case '--cursor-image': options.cursorImage = next(); break;
      case '--cursor-center': options.cursorCenter = next(); break;
      case '--pointerlock': options.pointerlock = true; break;
      case '--gamepad': options.gamepad = true; break;
      case '--special-cloud-behaviors': options.specialCloudBehaviors = true; break;
      case '--unsafe-cloud-behaviors': options.unsafeCloudBehaviors = true; break;
      case '--preload': options.preload = true; break;
      case '--no-deflate': options.noDeflate = true; break;
      case '--no-optimize-png': options.noOptimizePng = true; break;
      case '--no-gzip': options.noGzip = true; break;
      case '--gzip-level': options.gzipLevel = Number(next()); break;
      case '--devtools': options.devtools = next() !== '0'; break;
      case '--probe': options.probe = next(); break;
      case '--build': options.build = true; break;
      case '--json': options.json = true; break;
      case '-h': case '--help': options.help = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        options.positional.push(arg);
    }
  }
  return options;
};

const run = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.positional.length === 0) {
    console.log(USAGE);
    process.exit(options.help ? 0 : 1);
  }

  const inputPath = path.resolve(options.positional[0]);
  const input = fs.readFileSync(inputPath);
  const optionSet = loadOptionSet(options.options);
  const title = options.title || optionSet.title || defaultTitle(inputPath);

  const windowMode = options.windowMode || optionSet.windowMode || 'window';
  if (!WINDOW_MODES.includes(windowMode)) {
    throw new Error(`unknown --window-mode ${windowMode} (window | maximize | fullscreen)`);
  }

  const extensions = await collectExtensions(optionSet, options.extensions || []);

  // --- 1 + 2. HTML payload, compressed -------------------------------------
  const {pack, htmlBytes, payload, gzipped, icon, paths} = writeExeResources(input, Object.assign({}, optionSet, {
    inputPath,
    title,
    width: options.width || 640,
    height: options.height || 480,
    windowMode,
    icon: resolveIcon(options.icon || optionSet.icon),
    version: options.version || optionSet.version || '',
    extensions,
    loadingImage: resolveImage(options.loadingImage || optionSet.loadingImage, 'loading image'),
    cursorCustom: resolveImage(options.cursorImage || optionSet.cursorCustom, 'cursor image'),
    gzip: !options.noGzip,
    gzipLevel: options.gzipLevel || 9,
    devtools: options.devtools !== false,
    probe: options.probe || null,
    preload: options.preload === undefined ? !!optionSet.preload : !!options.preload,
    noDeflate: options.noDeflate === undefined ? !!optionSet.noDeflate : !!options.noDeflate,
    optimizePng: options.noOptimizePng ? false : optionSet.optimizePng !== false,
    // Flags only beat the option set when they were actually given.
    ...(options.loadingImageMode ? {loadingImageMode: options.loadingImageMode} : {}),
    ...(options.pointerlock ? {pointerlock: true} : {}),
    ...(options.gamepad ? {gamepad: true} : {}),
    ...(options.specialCloudBehaviors ? {specialCloudBehaviors: true} : {}),
    ...(options.unsafeCloudBehaviors ? {unsafeCloudBehaviors: true} : {})
  }, (() => {
    if (!options.cursorCenter) return {};
    const [x, y = 0] = String(options.cursorCenter).split(',');
    return {cursorCenterX: Number(x) || 0, cursorCenterY: Number(y) || 0};
  })()));

  // --- 3. build ------------------------------------------------------------
  // Opt-in: some sandboxes block spawning cmd.exe from Node. Running
  // exe/build.cmd yourself always works.
  let buildOk = null;
  if (options.build) {
    const build = buildExe();
    buildOk = build.ok;
    if (!buildOk) {
      if (build.stdout) console.error(build.stdout);
      if (build.stderr) console.error(build.stderr);
      if (build.reason) console.error(build.reason);
      throw new Error(`exe build failed (exit ${build.status})`);
    }
  }

  // Only report an exe that was actually produced from THIS payload. A leftover
  // binary from an earlier run would make "host code" nonsense (or negative).
  const builtExe = readBuiltExe(paths.payload);
  const exeBytes = builtExe ? fs.statSync(builtExe).size : null;

  const report = {
    input: inputPath,
    title,
    windowMode,
    icon: icon ? icon.name : null,
    version: options.version || optionSet.version || null,
    project: pack.project.analysis,
    container: pack.containerStats,
    scaffolding: path.basename(pack.scaffoldingSource),
    htmlBytes: htmlBytes.length,
    resourceBytes: payload.length,
    resourceGzip: !!gzipped,
    hostBytes: exeBytes !== null ? exeBytes - payload.length : null,
    exeBytes,
    built: buildOk
  };

  if (options.out && builtExe) {
    const outPath = path.resolve(options.out);
    fs.mkdirSync(path.dirname(outPath), {recursive: true});
    fs.copyFileSync(builtExe, outPath);
    report.out = outPath;
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const analysis = pack.project.analysis;
  console.log(`input       ${inputPath}  (${human(input.length)})`);
  console.log(`project     ${analysis.targetCount} targets, ` +
    `${analysis.assetCount} assets (${human(analysis.assetBytes)})`);
  if (analysis.png && analysis.png.optimized) {
    console.log(`png         ${analysis.png.optimized} re-encoded losslessly, ` +
      `${human(analysis.png.before)} -> ${human(analysis.png.after)} (saved ${human(analysis.png.before - analysis.png.after)})`);
  }
  for (const baked of (analysis.bakedExtensions || [])) {
    console.log(`extension   ${baked.name} -> ${baked.id || '(eager)'} [${baked.how}]`);
  }
  console.log(`runtime     ${path.basename(pack.scaffoldingSource)}`);
  console.log(`container   payload ${human(pack.containerStats.payloadBytes)}` +
    ` (${pack.containerStats.assetsDeflated} deflated / ${pack.containerStats.assetsRaw} raw)`);
  if (icon) console.log(`icon        ${icon.name} (${human(icon.bytes.length)})`);
  if (windowMode !== 'window') console.log(`window      ${windowMode}`);
  console.log('');
  console.log(`html        ${human(htmlBytes.length)}`);
  console.log(`resource    ${human(payload.length)}${gzipped ? ` (gzip -${options.gzipLevel || 9})` : ' (uncompressed)'}`);
  if (exeBytes) {
    console.log(`host code   ${human(exeBytes - payload.length)}`);
    console.log(`EXE         ${human(exeBytes)}   ${builtExe}`);
    if (report.out) console.log(`copied to   ${report.out}`);
  } else if (!options.build) {
    console.log('EXE         absent or older than this payload ' +
      '(pass --build, or run exe/build.cmd)');
  }
};

run().catch((error) => {
  console.error(`error: ${error.message}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exit(1);
});
