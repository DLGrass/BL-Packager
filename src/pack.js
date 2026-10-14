#!/usr/bin/env node
'use strict';

// sb3 -> single-file HTML packager.
//
//   node src/pack.js project.sb3 -o out.html
//   node src/pack.js project.sb3 --mode=both --out-dir out --instrument
//
// Modes:
//   fast (default)  embed a BLPK container: index lookup + no JS inflate
//   tw              embed the raw sb3 and let Scaffolding.JSZip unpack it
//                   (TurboWarp's own strategy, kept for A/B measurement)
//   both            emit both, for benchmarking

const fs = require('node:fs');
const path = require('node:path');

const {
  ROOT,
  defaultTitle,
  human,
  prepareProject,
  renderProjectHtml
} = require('./lib/pipeline');

const USAGE = `
Usage: node src/pack.js <project.sb3> [options]

Options:
  -o, --out <file>        output html path (single mode)
      --out-dir <dir>     output directory when --mode=both
      --mode <m>          fast | tw | both            (default: fast)
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
  const options = {mode: 'fast', positional: []};
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

const pickScaffoldingSource = (options) => (options.scaffolding ? path.resolve(options.scaffolding) : null);

const run = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.positional.length === 0) {
    console.log(USAGE);
    process.exit(options.help ? 0 : 1);
  }

  const inputPath = path.resolve(options.positional[0]);
  const input = fs.readFileSync(inputPath);

  const prepared = prepareProject(input, {
    fullRuntime: !!options.fullRuntime,
    scaffolding: pickScaffoldingSource(options),
    noDeflate: !!options.noDeflate,
    deflateIndex: !!options.deflateIndex,
    optimizePng: !options.noOptimizePng,
    onWarn: (message) => console.warn(`warning: ${message}`)
  });
  const {project, containerStats, scaffoldingSource} = prepared;

  const modes = options.mode === 'both' ? ['fast', 'tw'] : [options.mode];
  const results = [];

  for (const mode of modes) {
    const rendered = renderProjectHtml(prepared, {
      mode,
      inputPath,
      title: options.title,
      autoplay: !!options.autoplay,
      turbo: !!options.turbo,
      framerate: options.framerate || 30,
      username: options.username || 'player####',
      preload: !!options.preload,
      viewAssets: !!options.viewAssets,
      instrument: !!options.instrument
    });

    let outPath;
    if (options.mode === 'both' || (!options.out && options.outDir)) {
      const dir = path.resolve(options.outDir || path.join(ROOT, 'out'));
      fs.mkdirSync(dir, {recursive: true});
      outPath = path.join(dir, `${defaultTitle(inputPath)}.${mode}.html`);
    } else {
      outPath = path.resolve(options.out || path.join(ROOT, 'out', `${defaultTitle(inputPath)}.html`));
      fs.mkdirSync(path.dirname(outPath), {recursive: true});
    }

    fs.writeFileSync(outPath, rendered.html);

    results.push({
      mode,
      out: outPath,
      htmlBytes: rendered.html.length,
      payloadBytes: rendered.payloadBytes,
      chunks: rendered.stats.chunks,
      deflatedEntries: rendered.deflatedEntries,
      preload: !!options.preload,
      copyAssets: !options.viewAssets
    });
  }

  const report = {
    input: inputPath,
    project: project.analysis,
    container: containerStats,
    scaffolding: path.basename(scaffoldingSource),
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
