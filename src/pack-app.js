#!/usr/bin/env node
'use strict';

// sb3 -> macOS .app / Linux binary / Android .apk.
//
//   node src/pack-app.js project.sb3 --target macos
//   node src/pack-app.js project.sb3 --target macos --build
//   node src/pack-app.js project.sb3 --target all --title "My Game" --icon app.png
//
// The steps, and why each exists:
//
//   1. Reuse the normal HTML pipeline. All three hosts run exactly the artifact
//      the HTML packager produces, so a target cannot drift from the baseline.
//   2. gzip that HTML into one resource plus a small app.meta, laid down in
//      hosts/<target>/build/ (see src/lib/apps.js for the per-target layout).
//   3. Hand off to hosts/<target>/build.sh, which needs that platform's
//      toolchain: clang + Cocoa/WebKit on macOS, gcc + GTK3/WebKit2GTK on Linux,
//      aapt2 + javac + d8 + apksigner on Android. Those cannot run on Windows,
//      so --build is opt-in and CI (.github/workflows/hosts.yml) is where the
//      three of them actually get exercised.

const fs = require('node:fs');
const path = require('node:path');

const {
  defaultTitle,
  human,
  resolveImage,
  loadOptionSet,
  WINDOW_MODES
} = require('./lib/pipeline');
const {
  TARGETS,
  ORIENTATIONS,
  hostDir,
  writeAppResources,
  buildApp,
  resolveAppIcon
} = require('./lib/apps');
const {collectExtensions} = require('./lib/extension-source');
const {resolveMissingExtensions} = require('./lib/known-extensions');

const USAGE = `
Usage: node src/pack-app.js <project.sb3> --target <macos|linux|android|all> [options]

Targets:
  macos      a .app bundle (+ .zip and .dmg) via hosts/macos   — needs macOS
  linux      a single ELF binary (+ .tar.gz) via hosts/linux   — needs GTK3 + WebKit2GTK
  android    an .apk via hosts/android                        — needs the Android SDK
  all        write the resources for all three from one render

Options:
  -o, --out <file>       copy the first built artifact here
      --build            run hosts/<target>/build.sh (needs that platform's toolchain)
      --title <text>     window title / app label  (default: derived from the file name;
                         unlike the .exe, UTF-8 is fine everywhere)
      --name <text>      file/bundle name          (default: a slug of the title)
      --id <reverse.dns> bundle id / Android package (default: dev.bilup.<slug>)
      --version <x.y.z>  version shown by the OS   (default: 1.0.0)
      --width <n>        initial window width      (default: 640)
      --height <n>       initial window height     (default: 480)
      --window-mode <m>  window | maximize | fullscreen      (default: window)
      --orientation <m>  auto | landscape | portrait  (Android only, default landscape)
      --icon <file.png>  application icon; macOS converts it to .icns
      --probe <file>     smoke test: the app writes the live VM's
                         {targets, assets, canvas, ms} there and exits
      --options <spec>   JSON of the runtime/player options, or @file.json
      --extension <spec> bake a custom extension in (a .js path or a URL); repeatable
      --no-auto-extensions
                         don't fetch extension sources at pack time (same
                         behavior as src/pack.js: known gallery extensions and
                         http(s) extension URLs are auto-baked by default)
      --loading-image <f>, --cursor-image <f>, --pointerlock, --gamepad, …
                         see "node src/pack.js --help"
      --preload          warm compressed assets in parallel (see README)
      --no-deflate       store every container entry raw
      --no-optimize-png  keep PNG assets exactly as stored in the sb3
      --no-gzip          store the HTML resource uncompressed (debugging aid)
      --gzip-level <n>   resource compression level, 1-9 (default: 9)
      --devtools <0|1>   allow the inspector  (F12 on macOS/Linux; default: 1)
      --json             print stats as JSON
  -h, --help
`.trim();

const parseArgs = (argv) => {
  const options = {positional: [], targets: []};
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
      case '--target':
        for (const one of next().split(',')) options.targets.push(one.trim());
        break;
      case '--title': options.title = next(); break;
      case '--name': options.name = next(); break;
      case '--id': options.id = next(); break;
      case '--version': options.version = next(); break;
      case '--width': options.width = Number(next()); break;
      case '--height': options.height = Number(next()); break;
      case '--window-mode': options.windowMode = next(); break;
      case '--orientation': options.orientation = next(); break;
      case '--icon': options.icon = next(); break;
      case '--probe': options.probe = next(); break;
      case '--options': options.options = next(); break;
      case '--extension':
        (options.extensions = options.extensions || []).push(next());
        break;
      case '--no-auto-extensions': options.noAutoExtensions = true; break;
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

/** `--target` is required: a default would silently write the wrong platform. */
const pickTarget = (targets) => {
  if (targets.length === 0) {
    throw new Error('no --target given (macos | linux | android | all)');
  }
  const out = [];
  for (const target of targets) {
    if (target === 'all') return 'all';
    if (!TARGETS.includes(target)) {
      throw new Error(`unknown --target ${target} (macos | linux | android | all)`);
    }
    if (!out.includes(target)) out.push(target);
  }
  // Repeatable --target macos --target linux is the same request as "all" minus
  // the target that was not asked for, so it stays an explicit list.
  return out.length === 1 ? out[0] : out.join(',');
};

const run = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.positional.length === 0) {
    console.log(USAGE);
    process.exit(options.help ? 0 : 1);
  }

  const target = pickTarget(options.targets);
  const inputPath = path.resolve(options.positional[0]);
  const input = fs.readFileSync(inputPath);
  const optionSet = loadOptionSet(options.options);
  const title = options.title || optionSet.title || defaultTitle(inputPath);

  const windowMode = options.windowMode || optionSet.windowMode || 'window';
  if (!WINDOW_MODES.includes(windowMode)) {
    throw new Error(`unknown --window-mode ${windowMode} (window | maximize | fullscreen)`);
  }
  const orientation = options.orientation || optionSet.orientation || 'landscape';
  if (!Object.prototype.hasOwnProperty.call(ORIENTATIONS, orientation)) {
    throw new Error(`unknown --orientation ${orientation} (auto | landscape | portrait)`);
  }

  const extensions = await collectExtensions(optionSet, options.extensions || []);

  // Same auto-bake as src/pack.js: http(s) extension URLs and known gallery
  // extensions are fetched once at pack time unless opted out.
  const auto = (!options.noAutoExtensions && optionSet.autoExtensions !== false)
    ? await resolveMissingExtensions(input, {onWarn: (message) => console.warn(`warning: ${message}`), provided: extensions})
    : {sources: [], resolved: [], missing: []};
  extensions.push(...auto.sources);
  if (auto.missing.length) {
    console.warn(`warning: could not auto-resolve extensions: ${auto.missing.join(', ')}`);
  }

  const resolved = writeAppResources(input, Object.assign({}, optionSet, {
    target,
    inputPath,
    title,
    name: options.name || optionSet.name,
    id: options.id || optionSet.id,
    version: options.version || optionSet.version || '1.0.0',
    width: options.width || 640,
    height: options.height || 480,
    windowMode,
    orientation,
    icon: resolveAppIcon(options.icon || optionSet.icon),
    extensions,
    dropExtensions: auto.missing,
    loadingImage: resolveImage(options.loadingImage || optionSet.loadingImage, 'loading image'),
    cursorCustom: resolveImage(options.cursorImage || optionSet.cursorCustom, 'cursor image'),
    gzip: !options.noGzip,
    gzipLevel: options.gzipLevel || 9,
    devtools: options.devtools !== false,
    probe: options.probe || optionSet.probe || null,
    preload: options.preload === undefined ? !!optionSet.preload : !!options.preload,
    noDeflate: options.noDeflate === undefined ? !!optionSet.noDeflate : !!options.noDeflate,
    optimizePng: options.noOptimizePng ? false : optionSet.optimizePng !== false,
    ...(options.loadingImageMode ? {loadingImageMode: options.loadingImageMode} : {}),
    ...(options.pointerlock ? {pointerlock: true} : {}),
    ...(options.gamepad ? {gamepad: true} : {}),
    ...(options.specialCloudBehaviors ? {specialCloudBehaviors: true} : {}),
    ...(options.unsafeCloudBehaviors ? {unsafeCloudBehaviors: true} : {}),
    ...(options.cursorCenter ? (() => {
      const [x, y = 0] = String(options.cursorCenter).split(',');
      return {cursorCenterX: Number(x) || 0, cursorCenterY: Number(y) || 0};
    })() : {})
  }));

  const names = Object.keys(resolved.targets);

  // --- build ---------------------------------------------------------------
  const builds = {};
  for (const name of names) {
    if (!options.build) continue;
    const build = buildApp({target: name});
    builds[name] = build;
    if (!build.ok) {
      if (build.stdout) process.stderr.write(build.stdout);
      if (build.stderr) process.stderr.write(build.stderr);
      if (build.reason) console.error(build.reason);
      throw new Error(`${name} build failed (exit ${build.status}); ` +
        `it needs that platform's toolchain — see ${path.join(hostDir(name), 'build.sh')}`);
    }
  }

  const firstArtifact = names
    .map((name) => (builds[name] && builds[name].artifacts[0]) || null)
    .find(Boolean) || null;

  const report = {
    input: inputPath,
    title: resolved.title,
    name: resolved.name,
    id: resolved.id,
    version: resolved.version,
    targets: names,
    project: resolved.pack.project.analysis,
    container: resolved.pack.containerStats,
    scaffolding: path.basename(resolved.pack.scaffoldingSource),
    htmlBytes: resolved.htmlBytes.length,
    resourceBytes: resolved.payload.length,
    resourceGzip: !!resolved.gzipped,
    icon: resolved.icon ? resolved.icon.source : null,
    built: Object.keys(builds).length > 0 ? Object.values(builds).every((b) => b.ok) : null,
    artifacts: Object.fromEntries(names.map((name) => [name, builds[name]
      ? builds[name].artifacts
      : null]))
  };

  if (options.out && firstArtifact) {
    const outPath = path.resolve(options.out);
    fs.mkdirSync(path.dirname(outPath), {recursive: true});
    // A .app is a directory: copy the tree, not the bundle root as a file.
    fs.cpSync(firstArtifact, outPath, {recursive: true});
    report.out = outPath;
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const analysis = resolved.pack.project.analysis;
  console.log(`input       ${inputPath}  (${human(input.length)})`);
  console.log(`project     ${analysis.targetCount} targets, ` +
    `${analysis.assetCount} assets (${human(analysis.assetBytes)})`);
  if (analysis.png && analysis.png.optimized) {
    console.log(`png         ${analysis.png.optimized} re-encoded losslessly, ` +
      `${human(analysis.png.before)} -> ${human(analysis.png.after)} ` +
      `(saved ${human(analysis.png.before - analysis.png.after)})`);
  }
  for (const baked of (analysis.bakedExtensions || [])) {
    console.log(`extension   ${baked.name} -> ${baked.id || '(eager)'} [${baked.how}]`);
  }
  console.log(`runtime     ${path.basename(resolved.pack.scaffoldingSource)}`);
  console.log(`container   payload ${human(resolved.pack.containerStats.payloadBytes)}` +
    ` (${resolved.pack.containerStats.assetsDeflated} deflated / ` +
    `${resolved.pack.containerStats.assetsRaw} raw)`);
  console.log(`title       ${resolved.title}`);
  console.log(`id          ${resolved.id}`);
  if (resolved.icon) console.log(`icon        ${resolved.icon.source} (${human(resolved.icon.bytes.length)})`);
  console.log('');
  console.log(`html        ${human(resolved.htmlBytes.length)}`);
  console.log(`resource    ${human(resolved.payload.length)}` +
    `${resolved.gzipped ? ` (gzip -${options.gzipLevel || 9})` : ' (uncompressed)'}`);
  for (const name of names) {
    const {dir} = resolved.targets[name];
    console.log(`resources   ${name.padEnd(8)} -> ${dir}`);
    const build = builds[name];
    if (build && build.artifacts.length > 0) {
      for (const artifact of build.artifacts) {
        const size = fs.existsSync(artifact) ? fs.statSync(artifact) : null;
        console.log(`            ${(size && !size.isDirectory()) ? human(size.size).padStart(9)
          : '       dir'}  ${artifact}`);
      }
    } else if (!options.build) {
      console.log(`            not built (run hosts/${name}/build.sh, or pass --build)`);
    }
  }
  if (report.out) console.log(`copied to   ${report.out}`);
};

run().catch((error) => {
  console.error(`error: ${error.message}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exit(1);
});
