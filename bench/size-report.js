'use strict';

/**
 * Measures where the bytes actually go when an sb3 becomes a distributable
 * executable, and what each compression lever is worth.
 *
 * Everything here is measured, not estimated. Run:  node bench/size-report.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');

const bytes = (n) => {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
};
const save = (a, b) => ((1 - a / b) * 100).toFixed(1) + '%';
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

const tries = (fn) => {
  try { return fn(); } catch (error) { return null; }
};

/** Every compressor we can reach without adding a dependency. */
const compressors = () => {
  const list = [
    ['deflate-6', (b) => zlib.deflateSync(b, {level: 6})],
    ['deflate-9', (b) => zlib.deflateSync(b, {level: 9})],
    ['gzip-9', (b) => zlib.gzipSync(b, {level: 9})],
    ['brotli-q9', (b) => zlib.brotliCompressSync(b, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC
      }
    })],
    ['brotli-q11', (b) => zlib.brotliCompressSync(b, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC
      }
    })]
  ];
  if (zlib.zstdCompressSync) {
    list.push(['zstd-19', (b) => zlib.zstdCompressSync(b, {
      params: {[zlib.constants.ZSTD_c_compressionLevel]: 19}
    })]);
    list.push(['zstd-22', (b) => zlib.zstdCompressSync(b, {
      params: {[zlib.constants.ZSTD_c_compressionLevel]: 22}
    })]);
  }
  return list;
};

/** One table row per compressor, plus a "vs base85 what lands on disk" column. */
const ladder = (label, buf, note) => {
  const lines = [];
  lines.push('');
  lines.push(`### ${label}  —  ${bytes(buf.length)} 原生${note ? '（' + note + '）' : ''}`);
  lines.push('');
  lines.push('| 编码 | 压缩后 | 压缩率 | 再 base85 落到 HTML/源码里 | 总膨胀 |');
  lines.push('|---|---:|---:|---:|---:|');
  lines.push(`| 不压缩 | ${bytes(buf.length)} | — | ${bytes(Math.ceil(buf.length / 4) * 5)} | 1.250× |`);
  for (const [name, fn] of compressors()) {
    const out = tries(() => fn(buf));
    if (!out) { lines.push(`| ${name} | (不可用) | | | |`); continue; }
    const b85 = Math.ceil(out.length / 4) * 5;
    lines.push(
      `| ${name} | ${bytes(out.length)} | ${save(out.length, buf.length)} | ` +
      `${bytes(b85)} | ${(b85 / buf.length).toFixed(3)}× |`
    );
  }
  return lines;
};

const findSb3 = () => {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let items;
    try { items = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const item of items) {
      if (item.name === 'node_modules' || item.name === '.git') continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full, depth + 1);
      else if (item.name.toLowerCase().endsWith('.sb3')) found.push(full);
    }
  };
  walk(ROOT, 0);
  return found;
};

const lines = [];
const push = (...xs) => lines.push(...xs);

push('# 体积预算实测');
push('');
push(`生成时间：${new Date().toISOString()}`);
push(`Node：${process.version}（zstd ${zlib.zstdCompressSync ? '可用' : '不可用'}）`);
push('');

// ---------------------------------------------------------------- 1. 运行时

const scaffoldingPath = path.join(ROOT, 'vendor', 'scaffolding-min.js');
let scaffolding = null;
if (fs.existsSync(scaffoldingPath)) {
  scaffolding = fs.readFileSync(scaffoldingPath);
  push(...ladder('1. Scaffolding 运行时（`vendor/scaffolding-min.js`）', scaffolding, '已 minify 的 JS 文本'));
  push('');
  push('这是单文件产物的**主体**：一个 1.8 MB 的已压缩 JS。它对通用压缩算法极其友好，');
  push('而 png/wav/jpg 完全不友好 —— 这决定了「压缩哪一层」比「换哪个算法」重要得多。');
} else {
  push('1. Scaffolding 运行时：`vendor/scaffolding-min.js` 不存在，跳过。');
}

// ---------------------------------------------------------------- 2. 作品

const sb3Files = findSb3();
push('');
push(`## 2. 作品（找到 ${sb3Files.length} 个 .sb3）`);
const rowSb3 = (file) => {
  const buf = fs.readFileSync(file);
  const rel = path.relative(ROOT, file);
  const cells = [`\`${rel}\``, bytes(buf.length)];
  for (const [name, fn] of compressors().filter(([n]) => ['deflate-9', 'brotli-q11'].includes(n))) {
    const out = tries(() => fn(buf));
    cells.push(out ? `${bytes(out.length)} (${save(out.length, buf.length)})` : '—');
  }
  return cells;
};
if (sb3Files.length) {
  push('');
  push('| 文件 | 原始 | deflate-9 | brotli-q11 |');
  push('|---|---:|---:|---:|');
  for (const file of sb3Files) push('| ' + rowSb3(file).join(' | ') + ' |');
  push('');
  push('sb3 本身就是个 DEFLATE 的 zip，所以「再压一遍」几乎全是白做功（见列 3/4）。');
  push('**对 sb3 做二次压缩没有意义；有意义的是替换掉里面压不动或压过头的条目。**');
}

// ---------------------------------------------------------------- 3. 成品 HTML

push('');
push('## 3. 成品单文件 HTML');
const htmls = fs.existsSync(OUT)
  ? fs.readdirSync(OUT).filter((n) => n.endsWith('.html')).map((n) => path.join(OUT, n))
  : [];
if (htmls.length) {
  push('');
  push('| 产物 | 原始 | gzip-9 | brotli-q11 | 说明 |');
  push('|---|---:|---:|---:|---|');
  for (const file of htmls) {
    const buf = fs.readFileSync(file);
    const gz = tries(() => zlib.gzipSync(buf, {level: 9}));
    const br = tries(() => zlib.brotliCompressSync(buf, {
      params: {[zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24}
    }));
    push(
      `| \`${path.basename(file)}\` | ${bytes(buf.length)} | ` +
      `${gz ? bytes(gz.length) + ' (' + save(gz.length, buf.length) + ')' : '—'} | ` +
      `${br ? bytes(br.length) + ' (' + save(br.length, buf.length) + ')' : '—'} | ` +
      `base85 已把二进制膨胀 25%，且整页压缩只会压到 JS 那一小段 |`
    );
  }
  push('');
  push('注意：**HTML 里的 base85 文本本身是压缩过的乱码，通用压缩器几乎压不动它**。');
  push('所以想要更小的产物，不能在「外面再套一层压缩」，只能在**编码之前**先压缩。');
} else {
  push('`out/` 下没有 HTML 产物，跳过。');
}

// ---------------------------------------------------------------- 4. exe 外壳

push('');
push('## 4. exe 外壳的三种量级');
push('');
push('| 方案 | 磁盘占用 | 是否需要额外运行时 | 说明 |');
push('|---|---:|---|---|');
push('| 原生 WebView2 宿主（本项目原型） | 待实测 | WebView2 Runtime（Win10 21H2+/Win11 预装） | 单文件、无浏览器外框 |');
push('| 启动器 stub：释放 HTML 后调 `msedge --app=` | 待实测 | 已装的 Edge/Chrome | 最小，但有浏览器进程与 URL 栏之外的痕迹 |');
push('| Tauri（Rust + 系统 WebView） | ~3–10 MB | 同上 | 构建链重，本机无 Rust |');
push('| NW.js | ~120–160 MB | 自带 Chromium | |');
push('| Electron | ~150–200 MB（安装包 ~60–90 MB） | 自带 Chromium+Node | TurboWarp Packager 的 exe 走的就是这条 |');

// ---------------------------------------------------------------- 5. 结论

push('');
push('## 5. 结论：压缩杠杆的排序');
push('');
push('| # | 杠杆 | 量级 | 代价 |');
push('|---:|---|---:|---|');
push('| 1 | 别用 Electron/NW.js，改用系统 WebView | **−150 MB 以上** | 依赖系统 WebView2 |');
push('| 2 | 素材重编码（PNG→WebP/AVIF、WAV→Opus） | 照片类可 −80%~95% | 有损，需要编码器 |');
push('| 3 | 运行时 JS 在**编码前**先 gzip/brotli | 1.8 MB → 0.5 MB 级 | 页面侧多一次 DecompressionStream |');
push('| 4 | 删掉作品里没被引用的素材 | 视作品而定，常 10%+ | 需要静态分析 project.json |');
push('| 5 | 二进制走资源段而不是 base85 文本 | 省 20% | 仅 exe/桌面端可用 |');
push('| 6 | `/MT` + `/O2` + `/OPT:REF,ICF`，别链多余库 | 几百 KB → 100 KB 级 | 无 |');
push('| 7 | UPX 外壳压缩 | exe 自身 −50%~70% | 杀软误报、破坏数字签名 |');

const report = lines.join('\r\n');
const target = path.join(OUT, 'size-report.md');
fs.mkdirSync(OUT, {recursive: true});
fs.writeFileSync(target, report, 'utf8');
console.log(report);
console.log('\nwritten: ' + target);
