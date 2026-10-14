'use strict';

// Where do the bytes actually go in a packaged .exe, and what can still be
// squeezed? Measures every candidate encoding of the same bench project.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const {loadSb3} = require('../src/lib/sb3');
const {buildContainer} = require('../src/lib/container');
const {encodeChunk} = require('../src/lib/base85');
const {renderHtml} = require('../src/lib/html');

const ROOT = path.join(__dirname, '..');
const MB = 1024 * 1024;
const fmt = (n) => `${(n / MB).toFixed(3)} MiB`;
const pct = (a, b) => `${(100 * a / b).toFixed(1)}%`;

const rows = [];
const say = (s) => rows.push(s);

const input = fs.readFileSync(path.join(ROOT, 'out', 'bench', 'bench.sb3'));
const project = loadSb3(input, {optimize: true});
const scaffoldingSource = path.join(ROOT, 'vendor', 'scaffolding-min.js');
const scaffolding = fs.readFileSync(scaffoldingSource);

const {container, stats} = buildContainer(project, {minSaving: 0.05});

// --- 1. the raw material ---------------------------------------------------
say('## 1. 原始素材');
say('');
say(`sb3 输入                 ${fmt(input.length).padStart(12)}  (zip, 每条目已 DEFLATE)`);
say(`容器 BLPK               ${fmt(container.length).padStart(12)}  (${stats.assetsDeflated} 条 deflate / ${stats.assetsRaw} 条 raw)`);
say(`scaffolding (运行时 JS)  ${fmt(scaffolding.length).padStart(12)}`);
say('');
say('素材分类（容器内的字节）:');
const byExt = new Map();
for (const [name, bytes] of project.assets) {
  const ext = (name.split('.').pop() || '?').toLowerCase();
  const cur = byExt.get(ext) || {count: 0, bytes: 0};
  cur.count++;
  cur.bytes += bytes.length;
  byExt.set(ext, cur);
}
for (const [ext, v] of [...byExt].sort((a, b) => b[1].bytes - a[1].bytes)) {
  say(`  ${ext.padEnd(6)} ${String(v.count).padStart(4)} 个   ${fmt(v.bytes).padStart(12)}`);
}
const assetBytes = [...byExt.values()].reduce((n, v) => n + v.bytes, 0);
say('');

// --- 2. one outer gzip over the whole HTML ---------------------------------
const {html} = renderHtml(project, container, {
  mode: 'fast',
  title: 'Bench',
  copyAssets: true,
  scaffoldingSource,
  buildInfo: 'size measurement'
});
const htmlBytes = Buffer.isBuffer(html) ? html : Buffer.from(html, 'utf8');
const htmlText = htmlBytes.toString('utf8');

const gz = (b, level = 9) => zlib.gzipSync(b, {level});
const br = (b) => zlib.brotliCompressSync(b, {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length
  }
});

// Locate the data-chunk block so we can rebuild the page around a different
// payload encoding without allocating a copy per chunk.
const CHUNK_RE = /<script data="[^"]*">decodeChunk\(\d+\)<\/script>/g;
let firstChunk = -1, lastChunk = -1, m;
while ((m = CHUNK_RE.exec(htmlText)) !== null) {
  if (firstChunk < 0) firstChunk = m.index;
  lastChunk = m.index + m[0].length;
}
const shellPrefix = htmlText.slice(0, firstChunk);
const shellSuffix = htmlText.slice(lastChunk);
const dataChunksFor = (buf) => {
  const parts = [];
  for (let off = 0; off < buf.length; off += 64 * 1024) {
    const part = buf.subarray(off, off + 64 * 1024);
    parts.push(`<script data="${encodeChunk(part)}">decodeChunk(${part.length})</script>`);
  }
  return parts.join('');
};

// The HTML shell = everything except the base85 data chunks.
const shellHtml = Buffer.from(shellPrefix + shellSuffix, 'utf8');

const b85 = (buf) => {                       // base85 of a whole byte body
  const out = [];
  for (let i = 0; i < buf.length; i += 64 * 1024) {
    out.push(encodeChunk(buf.subarray(i, i + 64 * 1024)));
  }
  return Buffer.from(out.join(''), 'latin1');
};

say('## 2. 候选装载编码（同一份工程）');
say('');
say('| 方案 | 说明 | 资源字节 | 相对 sb3 |');
say('|---|---|---|---|');

const htmlGz = gz(htmlBytes);
say(`| A 内层无压缩 + 外层 gzip（现状） | base85(container) → 整页 gzip | ${fmt(htmlGz.length)} | ${pct(htmlGz.length, input.length)} |`);

const cGz = gz(container);
const htmlGzInner = gz(Buffer.from(
  shellPrefix + dataChunksFor(cGz) + shellSuffix, 'utf8'));
say(`| B base85(gzip(container)) | gzip 放进 base85 内侧 | ${fmt(htmlGzInner.length)} | ${pct(htmlGzInner.length, input.length)} |`);

const gzShell = gz(shellHtml);
say(`| C 容器独立资源(raw) + gzip(壳) | 壳 ${fmt(gzShell.length)} + 容器 ${fmt(container.length)} | ${fmt(gzShell.length + container.length)} | ${pct(gzShell.length + container.length, input.length)} |`);
say(`| D 容器独立资源(gzip) + gzip(壳) | 壳 ${fmt(gzShell.length)} + 容器 ${fmt(cGz.length)} | ${fmt(gzShell.length + cGz.length)} | ${pct(gzShell.length + cGz.length, input.length)} |`);
say(`| E 容器独立资源(raw) + 壳不压缩 | 壳 ${fmt(shellHtml.length)} + 容器 | ${fmt(shellHtml.length + container.length)} | ${pct(shellHtml.length + container.length, input.length)} |`);
say(`| F 完全不做 base85/gzip | 整页原样 | ${fmt(htmlBytes.length)} | ${pct(htmlBytes.length, input.length)} |`);
say('');

// --- 3. interleaved comparison of the compressors --------------------------
say('## 3. 各编解码器在这份数据上的实际表现');
say('');
say('| 数据 | raw | gzip -9 | brotli q11 | zstd -19 |');
say('|---|---|---|---|---|');
const zs = (b) => {
  if (!zlib.zstdCompressSync) return Buffer.alloc(0);
  try {
    const level = zlib.constants.ZSTD_c_compressionLevel;
    return level === undefined
      ? zlib.zstdCompressSync(b)
      : zlib.zstdCompressSync(b, {params: {[level]: 19}});
  } catch {
    return Buffer.alloc(0);
  }
};
for (const [name, buf] of [
  ['container (BLPK)', container],
  ['base85(container)', b85(container)],
  ['scaffolding JS', scaffolding],
  ['整页 HTML', htmlBytes],
  ['壳 HTML(无数据块)', shellHtml]
]) {
  say(`| ${name} | ${fmt(buf.length)} | ${fmt(gz(buf).length)} | ${fmt(br(buf).length)} | ${zs(buf).length ? fmt(zs(buf).length) : 'n/a'} |`);
}
say('');

// --- 4. how much of the container is already-compressed asset bytes? -------
let pngBytes = 0, pngCount = 0;
const pngSamples = [];
for (const [name, bytes] of project.assets) {
  if (!name.toLowerCase().endsWith('.png')) continue;
  pngCount++;
  pngBytes += bytes.length;
  const info = pngInfo(bytes);
  if (!info || pngSamples.length >= 3) continue;
  const raw = zlib.inflateSync(info.idat);
  const level9 = zlib.deflateSync(raw, {level: 9});
  const rows = unfilter(raw, info);
  const refiltered = rows ? zlib.deflateSync(buildAdaptive(rows, info.bpp), {level: 9}) : null;
  pngSamples.push({
    name: path.basename(name), idat: info.idat.length, inflated: raw.length,
    re: level9.length, refiltered: refiltered ? refiltered.length : level9.length
  });
}
say('## 4. PNG 资产能不能再压');
say('');
say(`PNG 合计 ${pngCount} 个 / ${fmt(pngBytes)}（占容器素材的 ${pct(pngBytes, assetBytes)}）`);
say('');
say('| PNG | IDAT | 解码后 | 重新 deflate -9 | 重新选行滤波 + -9 | 可省 |');
say('|---|---|---|---|---|---|');
for (const s of pngSamples) {
  say(`| ${s.name.slice(0, 12)}… | ${fmt(s.idat)} | ${fmt(s.inflated)} | ${fmt(s.re)} | ${fmt(s.refiltered)} | ${pct(s.idat - s.refiltered, s.idat)} |`);
}
say('');
say('（合成工程的 PNG 是随机噪声，本身不可压，所以上表几乎是 0% —— 这不是结论，见下节）');
say('');

// --- 5. what a *canvas-produced* PNG looks like -----------------------------
const canvasLike = [...syntheticCanvasPng()];
say('## 5. 真实场景：Canvas 导出的 PNG 重压缩潜力');
say('');
say(`一张 480x360 的类 canvas 位图（渐变天空 + 两个纯色形状），同一份像素：`);
say('');
say('| 编码方式 | IDAT 字节 |');
say('|---|---|');
for (const [label, bytes] of canvasLike) {
  say(`| ${label} | ${fmt(bytes.length)} |`);
}
const baseBytes = canvasLike[0][1].length;
const bestBytes = canvasLike[canvasLike.length - 1][1].length;
say(`| **可省** | **${fmt(baseBytes - bestBytes)}（${pct(baseBytes - bestBytes, baseBytes)}）** |`);
say('');
say('也就是说：Scratch 编辑器把造型画到 canvas 上再 `toDataURL("image/png")`，');
say('Chromium 那条路径给的是「全行 filter=0 + 默认压缩级别」。对它做无损重压');
say('（自适应选滤波 + deflate -9）能省下上面这个比例。造型/背景越平滑，省得越多；');
say('照片类或噪点类 PNG 则几乎没有空间。');
say('');

// ------------------------------------------------------------------ helpers

// Minimal PNG header + IDAT reader. Enough for 8-bit truecolour-with-alpha,
// which is what every Scratch costume is.
function pngInfo(png) {
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitDepth = png[24];
  const colorType = png[25];
  const interlace = png[28];
  if (bitDepth !== 8 || interlace !== 0) return null;
  const channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colorType];
  if (!channels) return null;

  let off = 8;
  const idat = [];
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!idat.length) return null;
  return {
    width, height, bpp: channels, bytesPerRow: width * channels,
    idat: Buffer.concat(idat)
  };
}

// Undo PNG per-row filtering, dropping the type byte. Returns plain scanlines.
function unfilter(raw, info) {
  const {bytesPerRow, bpp, height} = info;
  if (raw.length !== (bytesPerRow + 1) * height) return null;
  const rows = [];
  const prev = Buffer.alloc(bytesPerRow);
  for (let y = 0; y < height; y++) {
    const at = y * (bytesPerRow + 1);
    const type = raw[at];
    const row = Buffer.alloc(bytesPerRow);
    for (let i = 0; i < bytesPerRow; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const x = raw[at + 1 + i];
      let v;
      if (type === 0) v = x;
      else if (type === 1) v = x + a;
      else if (type === 2) v = x + b;
      else if (type === 3) v = x + ((a + b) >> 1);
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
      } else return null;
      row[i] = v & 0xff;
    }
    rows.push(row);
    row.copy(prev);
  }
  return rows;
}

// Least-sum-of-absolute-differences filter selection, the standard heuristic
// every PNG encoder uses to pick a filter type per scanline.
function filterRow(row, prev, bpp, f) {
  const out = Buffer.alloc(row.length);
  let score = 0;
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let v;
    if (f === 0) v = row[i];
    else if (f === 1) v = row[i] - a;
    else if (f === 2) v = row[i] - b;
    else if (f === 3) v = row[i] - ((a + b) >> 1);
    else {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      v = row[i] - (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
    }
    v &= 0xff;
    out[i] = v;
    score += v < 128 ? v : 256 - v;
  }
  return {out, score};
}

function syntheticCanvasPng() {
  const W = 480, H = 360, BPP = 4;
  const result = new Map();

  // A *canvas-like* image: smooth gradient sky, a couple of flat shapes.
  const rows = [];
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(W * BPP);
    for (let x = 0; x < W; x++) {
      const i = x * BPP;
      const inCircle = (x - 340) ** 2 + (y - 90) ** 2 < 60 ** 2;
      const inRect = x > 40 && x < 220 && y > 200 && y < 320;
      let r, g, b;
      if (inCircle) { r = 255; g = 238; b = 120; }
      else if (inRect) { r = 90; g = 160; b = 235; }
      else {
        r = 60 + Math.round(y * 0.5);
        g = 120 + Math.round(y * 0.35);
        b = 200 - Math.round(y * 0.2);
      }
      row[i] = r; row[i + 1] = g; row[i + 2] = b; row[i + 3] = 255;
    }
    rows.push(row);
  }

  // (a) filter 0 on every row + level 6: what canvas.toDataURL tends to emit.
  const none = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), r])));
  result.set('filter=0(全行) + deflate 6 —— canvas.toDataURL 的典型产物',
    zlib.deflateSync(none, {level: 6}));

  // (b) same pixels, level 9 only.
  result.set('filter=0(全行) + deflate 9 —— 只调压缩级别',
    zlib.deflateSync(none, {level: 9}));

  // (c) adaptive per-row filter + level 9.
  result.set('自适应选滤波 + deflate 9 —— 无损重压',
    zlib.deflateSync(buildAdaptive(rows, BPP), {level: 9}));

  return result;
}

// Pick a filter type per scanline by minimum sum of absolute differences, which
// is the heuristic every PNG encoder (libpng, zlib's pngcrush, ...) uses, then
// emit the filtered stream including the per-row type byte.
function buildAdaptive(rows, bpp) {
  const parts = [];
  const prev = Buffer.alloc(rows[0].length);
  for (const row of rows) {
    let best = null;
    for (let f = 0; f < 5; f++) {
      const r = filterRow(row, prev, bpp, f);
      if (!best || r.score < best.score) best = {f, ...r};
    }
    parts.push(Buffer.from([best.f]), best.out);
    row.copy(prev);
  }
  return Buffer.concat(parts);
}

fs.writeFileSync(path.join(ROOT, 'out', 'exe-size.md'), rows.join('\n') + '\n', 'utf8');
console.log(rows.join('\n'));
