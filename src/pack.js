#!/usr/bin/env node
'use strict';

// sb3 -> single-file HTML packager.
//
//   node src/pack.js project.sb3 -o out.html
//   node src/pack.js project.sb3 --mode=both --out-dir out --instrument
//   node src/pack.js project.sb3 --options @opts.json
//
// Modes:
//   fast (default)  embed a BLPK container: index lookup + no JS inflate
//   tw              embed the raw sb3 and let Scaffolding.JSZip unpack it
//                   (TurboWarp's own strategy, kept for A/B measurement)
//   both            emit both, for benchmarking
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
  loadOptionSet
} = require('./lib/pipeline');

const USAGE = `
Usage: node src/pack.js <project.sb3> [options]

Options:
  -o, --out <file>        output html path (single mode)
      --out-dir <dir>     output directory when --mode=both
      --mode <m>          fast | tw | both            (default: fast)
      --options <spec>    JSON of the runtime/player options, or @file.json
                          (the shape the web UI's 导出 button writes)
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
      case '--mode': options.mode = next(); break;
      case '--options': options.options = next(); break;
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
  for (const key of ['title', 'autoplay', 'turbo', 'framerate', 'username', 'preload']) {
    if (options[key] !== undefined) out[key] = options[key];
  }
  return out;
};

const run = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.positional.length === 0) {
    console.log(USAGE);
    process.exit(options.help ? 0 : 1);
  }

  const optionSet = loadOptionSet(options.options);
  const inputPath = path.resolve(options.positional[0]);
  const input = fs.readFileSync(inputPath);

  const prepared = prepareProject(input, {
    fullRuntime: options.fullRuntime || optionSet.fullRuntime === true,
    scaffolding: pickScaffoldingSource(options),
    noDeflate: options.noDeflate || optionSet.noDeflate === true,
    deflateIndex: options.deflateIndex || optionSet.deflateIndex === true,
    optimizePng: options.noOptimizePng ? false : optionSet.optimizePng !== false,
    onWarn: (message) => console.warn(`warning: ${message}`)
  });
  const {project, containerStats, scaffoldingSource} = prepared;

  const mode = options.mode || optionSet.mode || 'fast';
  const renderOptions = Object.assign({}, optionSet, flagOverrides(options));
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

  const report = {
    input: inputPath,
    project: project.analysis,
    container: containerStats,
    scaffolding: path.basename(scaffoldingSource),
    options: renderOptions,
    outputs: results
  };

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
  console.log(`container    payload ${human(containerStats.payloadBytes)}, index ${human(containerStats.indexBytes)}, ` +
    `${containerStats.assetsDeflated} deflated / ${containerStats.assetsRaw} raw, saved ${human(containerStats.deflatedBytesSaved)}`);
  for (const r of results) {
    console.log(`->[${r.mode}]     ${r.out}  (${human(r.htmlBytes)}, ${r.chunks} chunks)`);
  }
};

try {
  run();
} catch (error) {
  console.error(`error: ${error.message}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exit(1);
}
