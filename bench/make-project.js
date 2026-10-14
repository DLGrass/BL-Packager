'use strict';

// Builds a synthetic but structurally valid .sb3 with a realistic asset mix:
//
//   * PNG costumes with random pixels  -> DEFLATE cannot shrink them, so any
//     loader that inflates them is doing the work for nothing
//   * SVG costumes with lots of path data -> DEFLATE shrinks them ~85%
//   * WAV sounds with PCM audio         -> DEFLATE shrinks them ~50%
//
// The archive is written with forced DEFLATE for every entry, which is what
// Scratch's own serializer produces (verified against the real .sb3 fixtures in
// TurboWarp/packager/test), so both benchmark variants see the same input a real
// project would give them.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const {crc32} = require('../src/lib/crc32');
const {writeZip} = require('../src/lib/zip');

// deterministic PRNG so the fixture is reproducible
const makeRandom = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const md5 = (bytes) => crypto.createHash('md5').update(bytes).digest('hex');

// ------------------------------------------------------------------ png ----
const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
};

const encodePng = (width, height, rgb) => {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, {level: 6})),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
};

const makePng = (random, width, height) => {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (random() * 256) | 0;
  return encodePng(width, height, rgb);
};

// A canvas-style bitmap. Real Scratch costumes are anti-aliased raster art, so
// this draws a gradient background plus stroked segments with soft edges and a
// little sensor noise — local structure that per-row PNG filters exploit and
// that deflate alone cannot. Written the way Chromium's PNG encoder writes it
// (filter=0 on every row, a mid-range zlib level), which is what the editor
// produces for every bitmap costume and every imported image.
const makeArtPng = (random, width, height) => {
  const rgb = Buffer.alloc(width * height * 3);
  const top = [(random() * 256) | 0, (random() * 256) | 0, (random() * 256) | 0];
  const bottom = [(random() * 256) | 0, (random() * 256) | 0, (random() * 256) | 0];
  for (let y = 0; y < height; y++) {
    const t = height > 1 ? y / (height - 1) : 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      rgb[i] = (top[0] + (bottom[0] - top[0]) * t) | 0;
      rgb[i + 1] = (top[1] + (bottom[1] - top[1]) * t) | 0;
      rgb[i + 2] = (top[2] + (bottom[2] - top[2]) * t) | 0;
    }
  }

  // Stroked segments with a 3px soft edge: the anti-aliasing is what makes the
  // image resist deflate while still being predictable row to row.
  const stamp = (cx, cy, colour, alpha) => {
    for (let dy = -2; dy <= 2; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= height) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= width) continue;
        const d = Math.sqrt(dx * dx + dy * dy);
        const cover = Math.max(0, Math.min(1, 2.2 - d)) * alpha;
        if (cover <= 0) continue;
        const i = (y * width + x) * 3;
        rgb[i] = rgb[i] * (1 - cover) + colour[0] * cover;
        rgb[i + 1] = rgb[i + 1] * (1 - cover) + colour[1] * cover;
        rgb[i + 2] = rgb[i + 2] * (1 - cover) + colour[2] * cover;
      }
    }
  };

  const segments = 30 + Math.floor(random() * 30);
  for (let s = 0; s < segments; s++) {
    const colour = [(random() * 256) | 0, (random() * 256) | 0, (random() * 256) | 0];
    const alpha = 0.35 + random() * 0.65;
    let x = random() * width;
    let y = random() * height;
    const steps = 40 + Math.floor(random() * 220);
    const ang = random() * Math.PI * 2;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    for (let k = 0; k < steps; k++) {
      stamp(Math.round(x), Math.round(y), colour, alpha);
      x += dx;
      y += dy;
    }
  }

  // Light noise, as a lossy source would have.
  for (let i = 0; i < rgb.length; i++) {
    const n = ((random() * 6) | 0) - 3;
    rgb[i] = Math.max(0, Math.min(255, rgb[i] + n));
  }

  return encodePng(width, height, rgb);
};

// ------------------------------------------------------------------ svg ----
const makeSvg = (index, shapes, size) => {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`];
  for (let i = 0; i < shapes; i++) {
    const x = (i * 37 + index * 11) % size;
    const y = (i * 53 + index * 7) % size;
    parts.push(`<path d="M${x} ${y}l24 17-13 9 6 21-17-11z" fill="hsl(${(i + index) % 360},72%,58%)" stroke="hsl(${(i * 3) % 360},60%,40%)" stroke-width="1.5"/>`);
  }
  parts.push('</svg>');
  return Buffer.from(parts.join(''), 'utf8');
};

// ------------------------------------------------------------------ wav ----
const encodeWav = (samples, sampleRate) => {
  const dataSize = samples.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  const body = Buffer.alloc(dataSize);
  for (let i = 0; i < samples.length; i++) {
    body.writeInt16LE(Math.max(-32768, Math.min(32767, samples[i] | 0)), i * 2);
  }
  return Buffer.concat([header, body]);
};

const makeWav = (index, seconds, sampleRate) => {
  const count = Math.floor(seconds * sampleRate);
  const samples = new Int16Array(count);
  const base = 180 + (index % 40) * 11;
  for (let i = 0; i < count; i++) {
    const t = i / sampleRate;
    // A few summed partials: compressible, but not trivially so.
    samples[i] = 12000 * Math.sin(2 * Math.PI * base * t) +
      4000 * Math.sin(2 * Math.PI * base * 2.01 * t) +
      1500 * Math.sin(2 * Math.PI * base * 3.03 * t);
  }
  return encodeWav(samples, sampleRate);
};

// ------------------------------------------------------------------ sb3 ----
const plan = {
  pngSprites: 40,
  svgSprites: 30,
  wavSprites: 30,
  pngWidth: 300,
  pngHeight: 250,
  svgShapes: 700,
  svgSize: 256,
  wavSeconds: 4,
  sampleRate: 22050
};

const build = (options = {}) => {
  const random = makeRandom(20261014);
  const makeBitmap = options.art ? makeArtPng : makePng;
  // Canvas-style bitmaps are worth sizing like real ones (a full-stage backdrop
  // is 480x360 at 1x); random-noise bitmaps stay small because DEFLATE ignores
  // their size anyway.
  const pngWidth = options.art ? 480 : plan.pngWidth;
  const pngHeight = options.art ? 360 : plan.pngHeight;
  const assets = [];
  const targets = [];

  const addAsset = (name, bytes, dataFormat) => {
    const assetId = md5(bytes);
    const md5ext = `${assetId}.${dataFormat}`;
    if (!assets.some((a) => a.name === md5ext)) {
      assets.push({name: md5ext, data: bytes});
    }
    return {assetId, md5ext, dataFormat};
  };

  const costume = (name, bytes, dataFormat, size) => {
    const {assetId, md5ext} = addAsset(name, bytes, dataFormat);
    return {
      assetId,
      name,
      md5ext,
      dataFormat,
      rotationCenterX: size / 2,
      rotationCenterY: size / 2
    };
  };

  const sound = (name, bytes) => {
    const {assetId, md5ext} = addAsset(name, bytes, 'wav');
    return {
      assetId,
      name,
      md5ext,
      dataFormat: 'wav',
      rate: plan.sampleRate,
      sampleCount: bytes.length / 2 - 22
    };
  };

  const sprite = (name, index) => ({
    isStage: false,
    name,
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: index === 0 ? {
      b1: {
        opcode: 'event_whenflagclicked', next: 'b2', parent: null, inputs: {}, fields: {},
        shadow: false, topLevel: true, x: 0, y: 0
      },
      b2: {
        opcode: 'looks_sayforsecs', next: null, parent: 'b1',
        inputs: {MESSAGE: [1, [10, 'loaded']], SECS: [1, [4, '1']]},
        fields: {}, shadow: false, topLevel: false
      }
    } : {},
    comments: {},
    currentCostume: 0,
    costumes: [],
    sounds: [],
    volume: 100,
    layerOrder: index + 1,
    visible: true,
    x: 0,
    y: 0,
    size: 100,
    direction: 90,
    draggable: false,
    rotationStyle: 'all around'
  });

  // --- stage -------------------------------------------------------------
  const stage = {
    isStage: true,
    name: 'Stage',
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [costume('backdrop1', makeSvg(0, plan.svgShapes * 2, plan.svgSize * 2), 'svg', plan.svgSize * 2)],
    sounds: [],
    volume: 100,
    layerOrder: 0,
    tempo: 60,
    videoTransparency: 50,
    videoState: 'off',
    textToSpeechLanguage: null
  };
  targets.push(stage);

  // --- bitmap sprites ----------------------------------------------------
  for (let i = 0; i < plan.pngSprites; i++) {
    const target = sprite(`Png${i}`, i);
    target.costumes.push(costume(`costume${i}`, makeBitmap(random, pngWidth, pngHeight), 'png', pngWidth));
    target.costumes.push(costume('icon', makeSvg(1000 + i, 12, 32), 'svg', 32));
    targets.push(target);
  }

  // --- vector sprites ----------------------------------------------------
  for (let i = 0; i < plan.svgSprites; i++) {
    const target = sprite(`Svg${i}`, i);
    target.costumes.push(costume(`costume${i}`, makeSvg(2000 + i, plan.svgShapes, plan.svgSize), 'svg', plan.svgSize));
    targets.push(target);
  }

  // --- sound sprites -----------------------------------------------------
  for (let i = 0; i < plan.wavSprites; i++) {
    const target = sprite(`Wav${i}`, i);
    target.costumes.push(costume('icon', makeSvg(3000 + i, 12, 32), 'svg', 32));
    target.sounds.push(sound(`sound${i}`, makeWav(i, plan.wavSeconds, plan.sampleRate)));
    targets.push(target);
  }

  const projectData = {
    targets,
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0', vm: '0.2.0', agent: ''}
  };

  const entries = [
    {name: 'project.json', data: Buffer.from(JSON.stringify(projectData), 'utf8')},
    ...assets
  ];

  return {projectData, entries, assets};
};

const main = () => {
  // --art swaps the random-pixel costumes for canvas-style artwork, which is
  // what a real project contains and what PNG re-compression has to work with.
  const art = process.argv.includes('--art');
  const outDir = path.join(__dirname, '..', 'out', art ? 'bench-art' : 'bench');
  fs.mkdirSync(outDir, {recursive: true});

  const {projectData, entries, assets} = build({art});

  // Forced DEFLATE to match what Scratch's serializer emits.
  const sb3 = writeZip(entries, {compression: 'deflate'});
  const outPath = path.join(outDir, art ? 'bench-art.sb3' : 'bench.sb3');
  fs.writeFileSync(outPath, sb3);

  const byFormat = new Map();
  for (const asset of assets) {
    const format = asset.name.split('.').pop();
    const current = byFormat.get(format) || {count: 0, bytes: 0, deflated: 0};
    current.count++;
    current.bytes += asset.data.length;
    current.deflated += zlib.deflateRawSync(asset.data, {level: 9}).length;
    byFormat.set(format, current);
  }

  const human = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
  console.log(`wrote ${outPath}`);
  console.log(`  targets ${projectData.targets.length}, assets ${assets.length}, sb3 ${human(sb3.length)}`);
  for (const [format, stats] of byFormat) {
    const ratio = ((stats.deflated / stats.bytes) * 100).toFixed(1);
    console.log(`  ${format.padEnd(5)} ${String(stats.count).padStart(3)} assets, ${human(stats.bytes).padStart(9)} raw, deflate keeps ${ratio}%`);
  }
};

if (require.main === module) {
  main();
}

module.exports = {build, plan};
