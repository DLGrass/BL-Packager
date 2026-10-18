#!/usr/bin/env node
'use strict';

// sb3 -> single-file HTML packager.
//
//   node src/pack.js project.sb3 -o out.html
//   node src/pack.js project.sb3 --mode=both --out-dir out --instrument
//   node src/pack.js project.sb3 --options @opts.json
//   node src/pack.js project.sb3 --target zip -o out/site.zip
//   node src/pack.js project.sb3 --extension my-ext.js --pointerlock
//
// Modes:
//   fast (default)  embed a BLPK container: index lookup + no JS inflate
//   tw              embed the raw sb3 and let Scaffolding.JSZip unpack it
//                   (TurboWarp's own strategy, kept for A/B measurement)
//   both            emit both, for benchmarking
//
// Targets:
//   html (default)  one file, everything inside
//   zip             index.html + project.json + assets/, for a static host
//
// Most of the runtime/player settings are not flags: there are thirty of them,
// they all take simple values, and the web UI can already export exactly this
// shape as JSON. `--options` takes that file (or the JSON itself), so the two
// front ends cannot drift and adding an option does not mean adding a flag.

const fs = require('node:fs');
const path = require('node:path');

const {
  ROOT,
  defaultTitle,
  human,
  prepareProject,
  renderProjectHtml,
  packToZip,
  resolveImage,
  loadOptionSet
} = require('./lib/pipeline');
const {collectExtensions} = require('./lib/extension-source');

const USAGE = `
Usage: node src/pack.js <project.sb3> [options]

Options:
  -o, --out <file>        output path (single mode)
      --out-dir <dir>     output directory when --mode=both
      --target <t>        html | zip          (default: html)
                          zip = index.html + project.json + assets/ next to it,
                          for a static host. It has to be served over http(s):
                          fetch() cannot read a directory on file://
      --mode <m>          fast | tw | both            (default: fast)
      --options <spec>    JSON of the runtime/player options, or @file.json
                          (the shape the web UI's 导出 button writes)
      --extension <spec>  bake a custom extension into the output: a .js path,
                          or an http(s) URL fetched once at pack time.
                          Repeatable. Without this, a project whose extension
                          lives on the internet cannot open offline
      --loading-image <f> picture on the loading screen (png/jpeg/gif/webp/svg)
      --loading-image-mode <m>  normal | stretch      (default: normal)
      --cursor-image <f>  custom cursor image; implies cursor=custom
      --cursor-center <x,y>     cursor hotspot        (default: 0,0)
      --pointerlock       enable the pointer-lock addon
      --gamepad           enable the gamepad addon
      --special-cloud-behaviors   ☁ url / redirect / username / … as behaviours
      --unsafe-cloud-behaviors    ☁ eval / open link / … as behaviours
      --scaffolding <f>   override the runtime script
      --full-runtime      use scaffolding-full even if the project has no music
      --title <text>      window title                (default: derived from the file name)
      --autoplay          start the project immediately
      --turbo             enable Turbo Mode
      --framerate <n>     default 30
      --username <name>   default player####
      --preload           warm up compressed assets in parallel as soon as
                          project.json is ready
      --view-assets       hand the VM views into the decoded container instead
                          of owned copies. ON by default, this is a REGRESSION:
                          scratch-audio then copies the whole container per
                          sound. Only useful for demonstrating that.
      --no-deflate        store every entry raw (output never inflates anything)
      --no-optimize-png   keep PNG assets exactly as stored in the sb3. By
                          default they are losslessly re-encoded (unfilter,
                          re-choose the per-row filter, re-deflate), which
                          typically saves the most of any single step because
                          Scratch's editor emits filter=0 at the default level
      --deflate-index     also try to compress the container index
      --instrument        add benchmark hooks and POST timings to /__result
      --json              print the stats as JSON
  -h, --help
`.trim();

const parseArgs = (argv) => {
  const options = {positional: []};
  // Normalise --key=value into --key value so both spellings work.
  const flattened = [];
  for (const arg of argv) {
    const match = /^(--[a-z-]+)=([\s\S]*)$/.exec(arg);
    if (match) {
      flattened.push(match[1], match[2]);
    } else {
      flattened.push(arg);
    }
  }
  for (let i = 0; i < flattened.length; i++) {
    const arg = flattened[i];
    const next = () => {
      const value = flattened[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case '-o': case '--out': options.out = next(); break;
      case '--out-dir': options.outDir = next(); break;
      case '--target': options.target = next(); break;
      case '--mode': options.mode = next(); break;
      case '--options': options.options = next(); break;
      case '--extension':
        // Repeatable, so a project with three custom extensions is three flags.
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
      case '--scaffolding': options.scaffolding = next(); break;
      case '--full-runtime': options.fullRuntime = true; break;
      case '--title': options.title = next(); break;
      case '--autoplay': options.autoplay = true; break;
      case '--turbo': options.turbo = true; break;
      case '--framerate': options.framerate = Number(next()); break;
      case '--username': options.username = next(); break;
      case '--preload': options.preload = true; break;
      case '--copy-assets': options.copyAssets = true; break;
      case '--view-assets': options.viewAssets = true; break;
      case '--no-deflate': options.noDeflate = true; break;
      case '--no-optimize-png': options.noOptimizePng = true; break;
      case '--deflate-index': options.deflateIndex = true; break;
      case '--instrument': options.instrument = true; break;
      case '--json': options.json = true; break;
      case '-h': case '--help': options.help = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        options.positional.push(arg);
    }
  }
  return options;
};

/** `--options` accepts the JSON itself or `@path`; pipeline.loadOptionSet reads it. */

const pickScaffoldingSource = (options) => (options.scaffolding ? path.resolve(options.scaffolding) : null);

/**
 * Flags beat the option set, and an absent flag never overrides it: `--options`
 * is the broad channel, the flags are the ones worth typing by hand.
 */
const flagOverrides = (options) => {
  const out = {};
  for (const key of ['title', 'autoplay', 'turbo', 'framerate', 'username', 'preload',
    'pointerlock', 'gamepad', 'specialCloudBehaviors', 'unsafeCloudBehaviors',
    'loadingImageMode']) {
    if (options[key] !== undefined) out[key] = options[key];
  }
  return out;
};

/** `--cursor-center 12,20` -> the two flattened options html.js clamps. */
const cursorCenter = (spec) => {
  if (!spec) return null;
  const [x, y = 0] = String(spec).split(',');
  return {cursorCenterX: Number(x) || 0, cursorCenterY: Number(y) || 0};
};

/**
 * Extension sources: `--extension` (paths or URLs) plus whatever the option
 * file carried. An entry that already holds its source is taken as-is, which is
 * the shape the web UI's in-memory state uses.
 */
const run = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.positional.length === 0) {
    console.log(USAGE);
    process.exit(options.help ? 0 : 1);
  }

  const optionSet = loadOptionSet(options.options);
  const inputPath = path.resolve(options.positional[0]);
  const input = fs.readFileSync(inputPath);
  const target = options.target || 'html';
  if (target !== 'html' && target !== 'zip') throw new Error(`unknown target ${target}`);

  const extensions = await collectExtensions(optionSet, options.extensions || []);
  const warn = (message) => console.warn(`warning: ${message}`);

  const packOptions = {
    fullRuntime: options.fullRuntime || optionSet.fullRuntime === true,
    scaffolding: pickScaffoldingSource(options),
    noDeflate: options.noDeflate || optionSet.noDeflate === true,
    deflateIndex: options.deflateIndex || optionSet.deflateIndex === true,
    optimizePng: options.noOptimizePng ? false : optionSet.optimizePng !== false,
    extensions,
    onWarn: warn
  };

  // Images arrive as a path (CLI) or a data URL (option file); resolveImage
  // accepts both and the renderer only ever sees the data URL.
  const renderOptions = Object.assign({}, optionSet, flagOverrides(options), {
    loadingImage: resolveImage(options.loadingImage || optionSet.loadingImage, 'loading image'),
    cursorCustom: resolveImage(options.cursorImage || optionSet.cursorCustom, 'cursor image')
  }, cursorCenter(options.cursorCenter) || {});

  // The option file may list extension specs (`["a.js", "https://…"]`); those
  // were already resolved into sources and handed to prepareProject. Leaving the
  // raw list here would let it overwrite the resolved sources when the zip path
  // spreads these options over the pack options.
  delete renderOptions.extensions;

  const baseReport = {
    input: inputPath,
    target,
    options: renderOptions,
    extensions: extensions.map((entry) => entry.name)
  };

  // --- zip: a folder-shaped package for a static host ---------------------
  if (target === 'zip') {
    // The zip target has no payload to encode, so --mode means nothing there.
    if (options.mode === 'tw' || options.mode === 'both') {
      warn('--target zip always uses the http loader; --mode is ignored');
    }
    const zipped = packToZip(input, Object.assign({}, packOptions, renderOptions, {inputPath}));
    const outPath = path.resolve(options.out ||
      path.join(ROOT, 'out', `${defaultTitle(inputPath)}.zip`));
    fs.mkdirSync(path.dirname(outPath), {recursive: true});
    fs.writeFileSync(outPath, zipped.zip);

    const report = Object.assign(baseReport, {
      out: outPath,
      zipBytes: zipped.zip.length,
      htmlBytes: zipped.html.length,
      entries: zipped.entries.length,
      project: zipped.project.analysis,
      scaffolding: path.basename(zipped.scaffoldingSource)
    });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const a = zipped.project.analysis;
    console.log(`input        ${inputPath}  (${human(a.originalBytes)})`);
    console.log(`project      ${a.targetCount} targets, ${a.assetCount} assets (${human(a.assetBytes)})`);
    console.log(`runtime      ${path.basename(zipped.scaffoldingSource)}`);
    if (extensions.length) console.log(`extensions   ${extensions.map((e) => e.name).join(', ')}`);
    console.log(`layout       index.html ${human(zipped.html.length)} + project.json + ${a.assetCount} assets`);
    console.log(`->[zip]      ${outPath}  (${human(zipped.zip.length)}, ${zipped.entries.length} entries)`);
    console.log('             serve the extracted folder over http(s); file:// cannot fetch assets');
    return;
  }

  const prepared = prepareProject(input, packOptions);
  const {project, containerStats, scaffoldingSource} = prepared;

  const mode = options.mode || optionSet.mode || 'fast';
  const modes = mode === 'both' ? ['fast', 'tw'] : [mode];
  const results = [];

  for (const outputMode of modes) {
    const rendered = renderProjectHtml(prepared, Object.assign({}, renderOptions, {
      mode: outputMode,
      inputPath,
      viewAssets: !!options.viewAssets,
      instrument: !!options.instrument
    }));

    let outPath;
    if (mode === 'both' || (!options.out && options.outDir)) {
      const dir = path.resolve(options.outDir || path.join(ROOT, 'out'));
      fs.mkdirSync(dir, {recursive: true});
      outPath = path.join(dir, `${defaultTitle(inputPath)}.${outputMode}.html`);
    } else {
      outPath = path.resolve(options.out || path.join(ROOT, 'out', `${defaultTitle(inputPath)}.html`));
      fs.mkdirSync(path.dirname(outPath), {recursive: true});
    }

    fs.writeFileSync(outPath, rendered.html);

    results.push({
      mode: outputMode,
      out: outPath,
      htmlBytes: rendered.html.length,
      payloadBytes: rendered.payloadBytes,
      chunks: rendered.stats.chunks,
      deflatedEntries: rendered.deflatedEntries,
      preload: !!renderOptions.preload,
      copyAssets: !options.viewAssets
    });
  }

  const report = Object.assign(baseReport, {
    project: project.analysis,
    container: containerStats,
    scaffolding: path.basename(scaffoldingSource),
    outputs: results
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const a = project.analysis;
  console.log(`input        ${inputPath}  (${human(a.originalBytes)})`);
  console.log(`project      ${a.targetCount} targets, ${a.assetCount} assets (${human(a.assetBytes)}), project.json ${human(a.projectJSONBytes)}`);
  if (a.png && a.png.optimized) {
    console.log(`png          ${a.png.optimized} re-encoded losslessly, ` +
      `${human(a.png.before)} -> ${human(a.png.after)} (saved ${human(a.png.before - a.png.after)})`);
  }
  console.log(`music ext    ${a.usesMusic ? 'yes -> scaffolding-full expected' : 'no -> scaffolding-min is enough'}`);
  console.log(`runtime      ${path.basename(scaffoldingSource)} (${human(fs.statSync(scaffoldingSource).size)})`);
  for (const baked of (a.bakedExtensions || [])) {
    console.log(`extension    ${baked.name} -> ${baked.id || '(eager)'} [${baked.how}] ` +
      `${human(baked.bytes)} -> ${human(baked.uriBytes)} in the page`);
  }
  if ((a.remoteExtensions || []).length) {
    console.log(`extension!   still remote: ${a.remoteExtensions.join(', ')}`);
  }
  console.log(`container    payload ${human(containerStats.payloadBytes)}, index ${human(containerStats.indexBytes)}, ` +
    `${containerStats.assetsDeflated} deflated / ${containerStats.assetsRaw} raw, saved ${human(containerStats.deflatedBytesSaved)}`);
  for (const r of results) {
    console.log(`->[${r.mode}]     ${r.out}  (${human(r.htmlBytes)}, ${r.chunks} chunks)`);
  }
};

run().catch((error) => {
  console.error(`error: ${error.message}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exit(1);
});
