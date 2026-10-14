# 把 sb3 作品打包成 HTML 的原理与实现

> 参考源码：**TurboWarp/packager**（上游，`master`，commit `5bb4575`）
> 本文所有结论都来自 `src/packager/`、`src/scaffolding/` 的实际代码，不是推测。
> 涉及文件均以仓库根目录为基准给出路径。
>
> **本文分两部分。** 第 I 部分（§1–§12）讲上游 TurboWarp 是怎么做的。
> **第 II 部分（§13–§16）**讲照着它在 `D:\Demo\packager` 里做了一份什么、
> 为了「打开更快」多做了什么，以及**实测结果**——其中包含一项**没能测出收益**的否定结论。

---

## 0. 一句话结论

打包 sb3 成 HTML **不是"把 sb3 转成网页"，而是"把 sb3 的原文件字节 + 一整个 Scratch 运行时（Scaffolding）塞进同一个 HTML 文件"**。

HTML 里跑的还是 scratch-vm，工程数据只是换了个携带方式：

```
原始 sb3 (ZIP 字节)
   │  4 字节 → 5 字符 的 base85 编码
   ▼
N 个 <script data="…">decodeChunk(65536)</script>
   │  浏览器解析时同步解码，写回一个 ArrayBuffer
   ▼
Uint8Array（与原 sb3 字节完全一致）
   │  Scaffolding.JSZip.loadAsync()
   ▼
取 project.json → vm.loadProject()；取资源 → storage.addHelper 按需懒加载
```

所以产物是**自包含的**：不联网、不依赖 scratch.mit.edu，双击就能玩。代价是体积（Scaffolding 本身 2.5–4.6 MB）。

---

## 1. 角色分工

| 目录 | 职责 |
|---|---|
| `src/packager/` | **打包器本体**。读工程 → 预处理 → 拼 HTML → 输出 |
| `src/scaffolding/` | **精简版 Scratch 播放器**。产物 HTML 里跑的就是它 |
| `src/p4/` | packager.turbowarp.org 那个官网（Svelte） |
| `src/addons/` | 可选增强：手柄、指针锁定、暂停、云变量特殊行为 |
| `src/common/` | 两边共用的工具 |

关键点：**Scaffolding 才是"播放器"**，packager 只负责"把播放器和数据装进一个文件"。

---

## 2. 产物 HTML 的骨架

`Packager#package()`（`src/packager/packager.js:1235`）用 `encodeBigString` 模板标签按顺序拼出一整个 HTML。结构如下：

```html
<!DOCTYPE html>
<!-- Created with https://packager.turbowarp.org/ -->
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="…">
  <title>窗口标题</title>
  <style>  /* 加载页、错误页、绿旗页、控制按钮样式 */  </style>
</head>
<body>
  <div id="app"></div>                      <!-- 舞台挂载点 -->
  <div id="launch" class="screen" hidden>   <!-- 点击启动的绿旗大屏 -->
  <div id="loading" class="screen">         <!-- 进度条 -->
  <div id="error" class="screen" hidden>    <!-- 错误堆栈 -->

  <!-- ① 整个 Scaffolding 运行时（内联，2.5~4.6 MB） -->
  <script>{scaffolding-full.js | scaffolding-min.js}{addons.js?}</script>

  <!-- ② 启动脚本：new Scaffolding → setup() → appendTo() → 配置 VM/云变量/控制按钮 -->
  <script>…</script>

  <!-- ③ 用户自定义 JS（可选） -->
  <script>…</script>

  <!-- ④ 解码器脚本：base85decode / projectDecodeBuffer / decodeChunk -->
  <script>…</script>

  <!-- ⑤ 数据块：重复 N 次，每块 64 KiB -->
  <script data="……">decodeChunk(65536)</script>
  <script data="……">decodeChunk(65536)</script>
  <script data="……">decodeChunk(12345)</script>

  <!-- ⑥ getProjectData()：把上面拼好的 ArrayBuffer 交给 JSZip -->
  <script>…</script>

  <!-- ⑦ run()：getProjectData → loadProject → 隐藏加载页 → 自动/手动启动 -->
  <script>…</script>
</body>
</html>
```

两个细节值得注意：

1. **`encodeBigString` 不是普通模板字符串**（`src/packager/encode-big-string.js`）。它逐段 `TextEncoder.encode` 后拼成 `Uint8Array`，因为 Chrome 无法处理长度超过 `0x1fffffe8` 的字符串——1 GB 的工程拼字符串会直接炸。
2. 因此 `packager.package()` 返回的 `result.data` **对 html 和 zip 都是 `Uint8Array`**，写文件时不要再做类型判断。

---

## 3. 核心机密：sb3 如何塞进 HTML

### 3.1 为什么不用 base64

base64 每 3 字节 → 4 字符，膨胀率 **33.3%**。
这里用的是自定义 base85：每 4 字节 → 5 字符，膨胀率 **25%**。一个 100 MB 的 sb3，base64 要 133 MB，base85 只要 125 MB。

### 3.2 base85 规格（`src/packager/base85.js`）

```js
// 字符集 = ASCII 0x2a..0x7e，共 85 个可打印字符；小端
const getBase85EncodeCharacter = (n) => {
  n += 0x2a;
  if (n === 0x3c) return 0x28;   // '<' 转成 '('
  if (n === 0x3e) return 0x29;   // '>' 转成 ')'
  return n;
};
```

三条规则：

- **分组**：把字节流按 4 字节一组当作小端 `uint32`，反复 `% 85` 取 5 位十进制（85 进制）数字。
  `85^5 = 4 437 053 125 > 2^32 = 4 294 967 296`，5 个字符刚好能表示任意 `uint32`。
- **映射**：数值 `0..84` → 码点 `0x2a..0x7e`。
- **转义规避**：`<`(0x3c) 和 `>`(0x3e) 分别被替换成 `(` 和 `)`。这样编码结果**永远不会包含 `<`、`>`、`"`、`'`、`&`**，可以裸放进 HTML 属性里，不需要任何 HTML 转义。

编码前长度必须是 4 的倍数，不足则补零（补的零不输出）。

### 3.3 分块：为什么要切

一次性生成一个 100 MB 的字符串会撞上浏览器字符串长度上限，也会让解析卡死。所以切成 **64 KiB** 一块：

```js
// To avoid unnecessary padding, this should be a multiple of 4.
const CHUNK_SIZE = 1024 * 64;      // 65536

for (let i = 0; i < projectData.length; i += CHUNK_SIZE) {
  const projectChunk = projectData.subarray(i, i + CHUNK_SIZE);
  const base85 = encode(projectChunk);
  result.push(`<script data="${base85}">decodeChunk(${projectChunk.length})</script>\n`);
}
```

每块独立成一个 `<script>`，靠 `document.currentScript` 拿到自己的 `data` 属性并就地解码：

```js
let projectDecodeBuffer = new ArrayBuffer(Math.ceil(projectData.length / 4) * 4);
let projectDecodeIndex = 0;
const decodeChunk = (size) => {
  try {
    if (document.currentScript.tagName.toUpperCase() !== 'SCRIPT')
      throw new Error('document.currentScript is not a script');
    base85decode(document.currentScript.getAttribute("data"), projectDecodeBuffer, projectDecodeIndex);
    document.currentScript.remove();          // 解完立刻把 <script> 从 DOM 摘掉，释放内存
    projectDecodeIndex += size;
    setProgress(interpolate(0.1, 0.75, projectDecodeIndex / projectData.length));
  } catch (e) { handleError(e); }
};
```

这套设计的好处：**边解析边解码**，浏览器下载 HTML 的同时就在还原数据，不需要等整个文件下完。

### 3.4 写解码器时必踩的三个坑

如果你要自己解析产物的 HTML（做逆向、做校验、做二次打包），记住这三点：

| 坑 | 症状 | 正确做法 |
|---|---|---|
| **偏移量用声明值累加** | `ERR_OUT_OF_RANGE ... Received <总长+2>` | `projectDecodeIndex += size`，其中 `size` 来自 `decodeChunk(N)` 的实参，**不是** `floor(len/5)*4`。两者不等（编码末尾有填充） |
| **`\` 是合法字符** | 当 JS 字符串解析就丢字符 | `\`(0x5c) 映射到值 50，是正常符号。在属性里是裸反斜杠、不转义；用 `getAttribute` / `[^"]*` 抓取 |
| **`<` `>` 被换成了 `(` `)`** | 用「找 `</script>`」切分正文会切歪 | 用 `<script\b([^>]*)>([\s\S]*?)<\/script>` 逐块匹配，再从属性里读 `data` |

另外：缓冲区要按 `ceil(len/4)*4` 分配（可能比真实长度多 1~3 字节），最后靠 `new Uint8Array(buffer, 0, 真实长度)` 裁回来：

```js
getProjectDataFunction = `() => {
  const buffer = projectDecodeBuffer;
  projectDecodeBuffer = null;                                   // Allow GC
  return Promise.resolve(new Uint8Array(buffer, 0, ${projectData.length}));
}`;
```

> 分块大小是打包器的实现细节。读别人的产物时**一律以 `decodeChunk(N)` 的实参为准**，不要硬编码 65536（见过用 81964 的变体）。

---

## 4. 运行时怎么把数据还原成工程

### 4.1 `getProjectData()` 做了三件事

```js
const getProjectData = (function () {
  const storage = scaffolding.storage;
  storage.onprogress = (total, loaded) => {
    setProgress(interpolate(0.75, 0.98, loaded / total));   // 资源加载进度
  };

  let zip;
  vm.runtime.on('PROJECT_LOADED', () => (zip = null));      // 载完就放掉 zip，回收内存

  // 允许资源前带一层目录，兼容 assets/<file> 这种打包结构
  const findFileInZip = (path) =>
    zip.file(path) || zip.file(new RegExp("^([^/]*/)?" + path + "$"))[0];

  storage.addHelper({
    load: (assetType, assetId, dataFormat) => {
      const path = assetId + '.' + dataFormat;              // 例：9c9a...f3.svg
      const file = findFileInZip(path);
      if (!file) { console.error('Asset is not in zip: ' + path); return Promise.resolve(null); }
      return file.async('uint8array')
        .then((data) => storage.createAsset(assetType, dataFormat, data, assetId));
    }
  });

  return () => (base85 解出的 Uint8Array).then(async (data) => {
    zip = await Scaffolding.JSZip.loadAsync(data);
    const file = findFileInZip('project.json');
    if (!file) throw new Error('project.json is not in zip');
    return file.async('arraybuffer');                       // 只把 project.json 交给 VM
  });
})();
```

要点：

- **sb3 本身就是一个 ZIP**，所以 `JSZip.loadAsync(sb3 字节)` 直接成立，不需要任何转换。
- **资源是懒加载的**。`getProjectData()` 只返回 `project.json`；造型 / 声音 / 字体由 scratch-storage 在 VM 需要时通过 `addHelper` 回调逐个从同一个 zip 里取。所以 100 MB 的工程不会一次性全部解出来。
- **资源路径规则**：`<assetId>.<dataFormat>`，例如 `b3f1….svg`、`a2c9….wav`、`customFont.ttf`。
- `findFileInZip` 的正则 `^([^/]*/)?path$` 只容忍**一层**目录前缀。资源放两层目录里就找不到了。

### 4.2 为什么资源必须在 ZIP 根目录

`assetId` 就是**资源内容的 MD5**。scratch-storage 只按根目录的 `<md5>.<ext>` 查找。这份 HTML 嵌的是**原始 sb3 字节**，而 sb3 规范本身要求 project.json 与全部资源都躺在 zip 根目录——所以天然满足。

但如果你是**自己重新打包**这个 zip（比如做二次分发），把资源挪进 `assets/` 子目录：TurboWarp 靠上面那个正则能兜住，**官方 Scratch 打开时会静默丢资源**（不报错，只是道具/声音变空白）。这是最容易踩的坑。

### 4.3 载入时序

```js
const run = async () => {
  const projectData = await getProjectData();
  await scaffolding.loadProject(projectData);   // → vm.loadProject()
  setProgress(1);
  loadingScreen.hidden = true;
  if (autoplay) scaffolding.start();            // = vm.start() + vm.greenFlag()
  else { launchScreen.hidden = false; /* 点击后 start() */ }
};
run().catch(handleError);
```

---

## 5. HTML 里的运行时：Scaffolding

### 5.1 full 与 min

`loadResources()`（`src/packager/packager.js:276`）按工程是否需要 music 扩展来二选一：

```js
if (this.project.analysis.usesMusic) {
  texts.push(await this.fetchLargeAsset('scaffolding', 'text'));      // scaffolding-full.js  ~4.6 MB
} else {
  texts.push(await this.fetchLargeAsset('scaffolding-min', 'text'));  // scaffolding-min.js   ~2.5 MB
}
```

| 版本 | 内容 | 体积 |
|---|---|---|
| `scaffolding-full` | 完整 Scratch，含 music 扩展的音色文件 | ~4.6 MB |
| `scaffolding-min` | 除 music 音色外的一切 | ~2.5 MB |

`usesMusic` 的判定就是看 `project.json` 的 `extensions` 数组里有没有 `"music"`（`src/packager/download-project.js:43`）。**没用到 music 的项目能省 2 MB**。

这两个文件不在仓库里，是构建产物，通过 `large-assets.js` 从 `packagerdata.turbowarp.org` / `blobs.turbowarp.xyz` 下载并按 SHA-256 校验。

### 5.2 `setup()` 装配了什么

`src/scaffolding/scaffolding.js:320`：

```js
setup () {
  this.vm = new VM();
  this.vm.setCompatibilityMode(true);
  if (this.vm.setStageSize) this.vm.setStageSize(this.width, this.height);

  this.renderer = new Renderer(this._canvas, -w/2, w/2, -h/2, h/2);
  this.vm.attachRenderer(this.renderer);

  this.storage = new Storage();          this.vm.attachStorage(this.storage);
  this.audioEngine = new AudioEngine();  this.vm.attachAudioEngine(this.audioEngine);
  this.bitmapAdapter = new BitmapAdapter(); this.vm.attachV2BitmapAdapter(this.bitmapAdapter);
  this.videoProvider = new VideoProvider(); this.vm.setVideoProvider(this.videoProvider);
}
```

即 `scratch-vm` + `scratch-render` + `scratch-storage` + `scratch-audio` + `scratch-svg-renderer`，全部用 `src/scaffolding/scratch-libraries.js` 里 import 的包——**想换成自己的 scratch-vm fork，只改这一个文件即可**（README 的 "Tips for forks" 专门讲了这点）。

Scaffolding 额外负责了这些 GUI 的活：

- 向 VM 转发鼠标/触摸/键盘事件，实现拖拽精灵
- 实现「询问并等待」
- 实现变量/列表监视器（含右键菜单、拖放文件）——比 scratch-gui 快得多
- 实现云变量（WebSocket / localStorage）
- 实现视频侦测

它**不**负责：绿旗启动屏、控制按钮、进度条——这些由 packager 生成的外层 HTML 提供。

### 5.3 `</script>` 的转义技巧

Scaffolding 源码里如果有 `</script>` 字面量，内联进 HTML 会提前闭合标签、整页崩掉。处理方式很土但很有效（`loadResources`）：

```js
this.script = texts.join('\n').replace(/<\/script>/g, "</scri'+'pt>");
```

把字符串拆成 `"</scri'+'pt>"`，JS 求值后仍是 `</script>`，但 HTML 解析器看到的不再是结束标签。

---

## 6. 打包前的"改工程"——最容易被忽略的一段

**产物里的 `project.json` 和原始 sb3 里的不是同一串字节。** 打包器在装载阶段就动了它。

### 6.1 归一化（`src/packager/download-project.js`）

```js
const mutateScratch3InPlace = (projectData) => {
  const makeImpliedCloudVariables = (projectData) => {
    const stage = projectData.targets.find((i) => i.isStage);
    for (const variable of Object.values(stage.variables)) {
      if (typeof variable[0] === 'string' && variable[0].startsWith('☁')) {
        variable[2] = true;              // 名字以 ☁ 开头 → 自动标成云变量
      }
    }
  };
  makeImpliedCloudVariables(projectData);
  optimizeSb3Json(projectData);          // 见 6.2
};
```

顺带做了分析（供打包选项使用）：`usesMusic`、`usesSteamworks`、`stageVariables`、`extensions`。

### 6.2 压缩优化（`src/packager/minify/sb3.js`）

对积木做**语义等价的重写**，能省下可观的体积：

| 操作 | 说明 |
|---|---|
| **块 ID 重编号** | 统计所有引用次数，**用得最多的块拿最短的 ID**（字符集 `a-z A-Z 0-9 !#%…`），显著缩小 JSON |
| 删除字段 | `x` / `y` / `comment` 全删；`shadow` / `topLevel` 为假时删 |
| 精简注释 | 只保留带 `// _twconfig_` 或 `// _gamepad_` 的特殊注释 |
| 清空监视器值 | `monitor.value` 一律重置为 `0` 或 `[]` |
| 删元数据 | `meta.agent`、`meta.vm` |

后果：**拿产物的 project.json 和原 sb3 做字节比对（甚至 md5 比对）必然不同，这不代表内容被篡改。** 正确判据是逐 opcode 统计是否一致（`opcode` 种类数与每种的数量）。

---

## 7. 不同输出格式的差异

`package()` 里 `this.options.target !== 'html'` 时走另一条分支：

| target | 工程数据位置 | 运行时 | 资源加载 |
|---|---|---|---|
| `html` **（单文件）** | base85 分块内联在 HTML 里 | 内联在 HTML 里 | 从内联 zip 懒加载（`addHelper`） |
| `zip` | `assets/project.json` | 外部 `script.js` | `addWebStore` → `./assets/<md5>.<ext>` |
| `zip-one-asset` | `project.zip`（原始 sb3） | 外部 `script.js` | 从 `project.zip` 内懒加载 |
| `nwjs-*` / `electron-*` / `webview-mac` | 如上 | 如上 | 再套一层壳（NW.js / Electron / WKWebView） |

注意 **`zip` 目标会把 sb3 里所有根文件挪到 `assets/` 目录**：

```js
if (this.project.type === 'sb3' && this.options.target !== 'zip-one-asset') {
  zip = await (await getJSZip()).loadAsync(this.getProjectBuffer());
  for (const file of Object.keys(zip.files)) {
    zip.files[`assets/${file}`] = zip.files[file];
    delete zip.files[file];
  }
}
```

**这就是为什么 zip 版本必须架在网站上跑**：用的是相对 URL + XHR，`file://` 打开会被 CORS 拦死，报错文案就直接写在代码里：

> `Zip environment must be used on a website, not on a local file. To fix this error, use the "Plain HTML" environment instead.`

单文件 HTML 没有这个限制，但代价是大项目首次打开要解 100+ MB 的 base85。

---

## 8. 扩展（extension）怎么办

打包时有两个关键选项：

- **`extensions`**：要额外加载的扩展 URL 列表
- **`bakeExtensions`**（默认 `true`）：打包期把扩展 JS **下载下来内联进产物**

运行时（`src/packager/packager.js:1619`）：

```js
scaffolding.setExtensionSecurityManager({
  getSandboxMode: () => 'unsandboxed',
  canLoadExtensionFromProject: () => true
});
// await this.generateExtensionURLs() 的结果在打包期就被 JSON.stringify 内联进来了
for (const extension of ["https://extensions.turbowarp.org/fetch.js", /* ... */]) {
  vm.extensionManager.loadExtensionURL(extension);
}
```

**这里是最常见的"打包后打不开"来源**：

- 工程 `project.json` 里的 `extensionURLs` 指向 `extensions.turbowarp.org`。若 `bakeExtensions` 关掉、或打包期网络不通，产物运行时会去实时拉取；**离线直接 `loadProject` 失败**，整页卡在加载屏。
- 非官方扩展（`stretch` / `ClonesPlus` / `tween` / `cursor` / `fetch` …）**在 scratch.mit.edu 上跑不了**，必须用 TurboWarp 或同类 fork 打开。

排查技巧：给 `vm.extensionManager.loadExtensionURL` 打桩（stub）成空实现再重试，就能把「网络问题」和「sb3 结构问题」分开。

---

## 9. 自己动手的三条路

### 路线 A：官网点点点（零代码）

打开 <https://packager.turbowarp.org/> → 拖入 sb3 → 选 "Plain HTML" → 打包。
格式受限或网络不通时，可用 standalone 版：[GitHub Releases](https://github.com/TurboWarp/packager/releases)。

### 路线 B：Node API（可脚本化、可批量）

```bash
npm install --save-exact @turbowarp/packager
```

```js
const fs = require('fs');
const Packager = require('@turbowarp/packager');

const run = async () => {
  const projectData = fs.readFileSync('project.sb3');

  // 装载：解析 sb/sb2/sb3、分析、必要时按需下载资源
  const loadedProject = await Packager.loadProject(projectData, (type, a, b) => {
    // type: 'assets' | 'compress' | ...；a/b 视 type 而定
  });

  const packager = new Packager.Packager();   // 单次使用对象，每次打包都要 new
  packager.project = loadedProject;

  // 只覆盖想改的字段，绝不要整个替换 options
  packager.options.target = 'html';
  packager.options.app.windowTitle = '我的作品';
  packager.options.autoplay = true;
  packager.options.turbo = true;
  packager.options.app.icon = new Packager.Image('image/png', fs.readFileSync('icon.png'));

  const result = await packager.package();
  fs.writeFileSync(result.filename, result.data);   // data 永远是 Uint8Array
};

run().catch((e) => { console.error(e); process.exit(1); });
```

几个 API 注意事项：

- `packager` **是一次性的**，`package()` 只能调一次。
- 别写 `packager.options = {...}`，`options.custom` 之类会被误设成 `undefined`，行为未定义。
- 大文件（Electron 二进制）缓存在 `node_modules/@turbowarp/packager/.packager-cache`，可定期清。
- 进度事件：`zip-progress`、`large-asset-fetch`。
- 常用选项见 `Packager.DEFAULT_OPTIONS()`（`packager.js:1765` 起），例如
  `turbo` / `framerate` / `maxClones` / `fencing` / `stageWidth` / `stageHeight` /
  `autoplay` / `username` / `controls.*` / `cloudVariables.mode` / `compiler.enabled` / `packagedRuntime`。

### 路线 C：自己写外壳，只把 Scaffolding 当播放器库

产物 HTML 的结构其实很简单，你也可以不要打包器、手写自己的页面：

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>#project { width: 480px; height: 360px; }</style>
</head>
<body>
  <div id="project"></div>

  <!-- 锁死版本号！Scaffolding 的 API 不保证向后兼容 -->
  <script src="https://cdn.jsdelivr.net/npm/@turbowarp/packager@1.0.0/dist/scaffolding/scaffolding-min.js"></script>

  <script>
    const scaffolding = new Scaffolding.Scaffolding();
    scaffolding.width = 480;
    scaffolding.height = 360;
    scaffolding.resizeMode = 'preserve-ratio';  // 或 'dynamic-resize' / 'stretch'
    scaffolding.setup();
    scaffolding.appendTo(document.getElementById('project'));

    // 告诉 storage 去哪儿找资源
    const storage = scaffolding.storage;
    storage.addWebStore(
      [storage.AssetType.ImageVector, storage.AssetType.ImageBitmap,
       storage.AssetType.Sound, storage.AssetType.Font],
      (asset) => new URL('./assets/' + asset.assetId + '.' + asset.dataFormat, location).href
    );

    // 云变量（不加就只是普通变量）
    scaffolding.addCloudProvider(
      new Scaffolding.Cloud.WebSocketProvider('wss://clouddata.turbowarp.org', 'PROJECT_ID')
    );

    scaffolding.setUsername('player####');
    scaffolding.setAccentColor('#4d97ff');

    fetch('project.sb3')
      .then((r) => r.arrayBuffer())
      .then((data) => scaffolding.loadProject(data))
      .then(() => {
        scaffolding.addControlButton({ element: makeGreenFlag(), where: 'top-left' });
        scaffolding.start();     // = vm.start() + vm.greenFlag()
      });
  </script>
</body>
</html>
```

Scaffolding 的构造函数、实例与对应包：

| 包 | 构造器 | 实例 |
|---|---|---|
| scratch-vm | `Scaffolding.VM` | `scaffolding.vm` |
| scratch-render | `Scaffolding.Renderer` | `scaffolding.renderer` |
| scratch-storage | `Scaffolding.Storage` | `scaffolding.storage` |
| scratch-audio | `Scaffolding.AudioEngine` | `scaffolding.audioEngine` |
| JSZip | `Scaffolding.JSZip` | — |

常用 VM 设置：

```js
scaffolding.vm.setTurboMode(true);
scaffolding.vm.setFramerate(60);
scaffolding.vm.setInterpolation(true);
scaffolding.renderer.setUseHighQualityRender(true);
scaffolding.vm.setRuntimeOptions({fencing: false, miscLimits: false, maxClones: Infinity});
```

**一个坑**：`git tag` 里的版本必须钉死。文档原话——"DO NOT use versions like `@1` or `@latest` -- your website will break if (when) Scaffolding's API changes!"

---

## 10. 产物校验清单

打包完别急着分发，按性价比从高到低验：

1. `zipfile.ZipFile(p).testzip()` → 必须 `None`（这是原 sb3 的 CRC，不是产物的）
2. HTML 里 `<script data=…>` 的块数 × 65536 ≈ 工程字节数（最后一块除外）
3. 自己写解码器解一遍，比对**解码结果 md5 == 原始 sb3 md5**。这是最灵敏的指标，一字不差才算解对
4. 产物用浏览器打开，看加载进度条是否走满、控制台有无 `Failed to load project data` / 扩展加载失败
5. 离线再打开一次（断网），验证扩展是否已内联（`bakeExtensions`）

---

## 11. 常见坑速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 打开是白屏 / 卡在 loading | HTML 里扩展开启了但离线拉不到 | 开启 `bakeExtensions`，或打包机联网 |
| 提示 `Zip environment must be used on a website` | 用了 `zip` 目标但以 `file://` 打开 | 换 `html` 目标，或架 HTTP 服务 |
| 道具/声音丢失，但 Scratch 官方能打开、TurboWarp 也能 | 自己重打包时资源放进了 `assets/` 子目录 | 资源必须在 zip **根目录** |
| 解出来不是 `50 4b 03 04` | 还有一层 XOR / 偏移算错 | 回 HTML 里找密钥与 `decodeChunk` 实参，不要猜 |
| 产物在 scratch.mit.edu 上跑不了 | 用了非官方扩展 | 只能 TurboWarp / 同类 fork 打开 |
| 上传到 Scratch 站点失败 | 解压后体积超限（>50 MB） | 压缩资源，或改用自托管 HTML |
| 大工程（>500 MB）打包报错 | 老版本用字符串拼接被 Chrome 长度上限挡住 | 用新版（`encodeBigString`） |

---

## 12. 反向操作：从打包 HTML 还原出 sb3

理解了正向流程，反向就是"把第 3 步倒过来"：

1. 正则切出所有 `<script data="…">`，读属性里的 base85 串
2. 按 `decodeChunk(N)` 的声明值累加偏移，逐块 `base85decode`
3. 拼出完整字节 → 应为合法 ZIP（`50 4b 03 04`）
4. 直接就是**原始 sb3**，无需重打包；若要重新打 zip，务必
   - project.json 与资源放**根目录**
   - CRC-32 正确
   - **文件名 md5 == 内容 md5**（生成后逐个核对，这是"能否正常打开"最灵敏的指标）
5. 若第 3 步开头不对，说明还有一层 XOR，密钥藏在 HTML 的 JS 里（形如 `PROJECT_DECRYPT_KEY = [ … ]` 或 `decryptProjectData()`），用 `out[i] = buffer[i] ^ key[i % key.length]` 解

> "密码"和"混淆"是两件事，要分开判：
> **数据层**看 `variables` / `lists` / `broadcasts` 的 id 与 name 是否被批量改写成随机串；
> **JS 层**看有没有 `_0x4a2f` 这类标识符、`while(!![])` 控制流平坦化、字符串数组轮转解密。
> `eval` / `new Function` / `debugger` 命中**不等于**混淆——js-md5 的 `eval("require('crypto')")`、webpack 的 `new Function("return this")()`、TurboWarp 自己的 `scopedEval` 都是合法来源。
>
> 特别注意：**广播改名会让广播静默失效**。`Runtime.startHats` 按 `BROADCAST_OPTION.value`（**名字**）比对，表里的名字被改而 hat 积木的 field 没跟着改，广播就永远匹配不上，且只在 console 里报 `did not find ... did not match expected name`。

---

## 附：关键文件索引

| 路径 | 作用 |
|---|---|
| `src/packager/packager.js` | 打包器主体；`package()` 在 1235 行，`generateGetProjectData()` 在 1016 行 |
| `src/packager/base85.js` | 自定义 base85 编解码 |
| `src/packager/download-project.js` | sb/sb2/sb3 装载、云变量推断、分析 |
| `src/packager/minify/sb3.js` | project.json 压缩优化（块 ID 重编号等） |
| `src/packager/encode-big-string.js` | 超长 HTML 的 Uint8Array 拼接 |
| `src/packager/large-assets.js` | 外部大文件（Scaffolding、Electron、NW.js）地址与校验和 |
| `src/scaffolding/scaffolding.js` | 播放器本体；`setup()` 320 行，`loadProject()` 454 行 |
| `src/scaffolding/scratch-libraries.js` | **换 fork 的唯一入口** |
| `src/scaffolding/export.js` | 导出到 `window.Scaffolding` |
| `node-api-docs/README.md` | Node API 官方文档 + `demo-simple.js` |
| `scaffolding-api-docs/README.md` | 把 Scaffolding 当库用的完整 API |
| `static/example.html` | 手写外壳的官方示例 |
| `test/packager/base85.test.js` | base85 往返测试（可作实现参照） |

---

*文档基于 TurboWarp/packager 上游源码整理，不含任何第三方 fork 的改动。*

---
---

# 第 II 部分：本仓库（`D:\Demo\packager`）的实现与实测

第 I 部分讲的是上游**怎么做**。这一部分讲**我们照着做了一份**，以及为了
「提高打包后 HTML 的打开速度」多做了什么、代价是什么、实测多少。

---

## 13. 实现范围

零依赖（只用 `node:zlib` / `node:crypto` / `node:fs`），没有构建步骤。

| 文件 | 职责 |
|---|---|
| `src/lib/crc32.js` | CRC-32 查表实现 |
| `src/lib/zip.js` | 最小同步 zip 读写（EOCD 扫描，不含 zip64） |
| `src/lib/base85.js` | 与 TW 兼容的 base85；`decoderSource()` 产出**内联进产物的**解码器 |
| `src/lib/sb3.js` | sb3 装载、project.json 优化（块 ID 重编号等） |
| `src/lib/container.js` | **BLPK 容器**构建 + Node 侧解析 |
| `src/lib/html.js` | 拼装单文件 HTML |
| `src/runtime/inflate-raw.js` | 纯 JS RFC1951 解码器（浏览器兜底，与 zlib 逐字节对拍通过） |
| `src/runtime/container-reader.js` | 产物内的 BLPK 读取 |
| `src/runtime/loader.js` | 产物内的装载器，`fast` / `tw` 双模式 |
| `src/pack.js` | CLI |
| `bench/` | 合成工程生成器 + 无头 Edge 跑分 |
| `test/run.js` | 19 项验证，全部在 Node 内可跑 |

与 TW 完全一致、刻意保留的部分：

- base85 规格（4 字节 → 5 字符，字符集 `0x2a–0x7e`，`<`→`(`、`>`→`)`）
- 64 KiB 分块 + `<script data="…">decodeChunk(N)</script>` + `document.currentScript` 就地解码
- 偏移按**声明值**累加，不是 `floor(len/5)*4`
- 内联 Scaffolding，`createProjectSource` 之后交给 `scaffolding.loadProject()`

保留 `--mode=tw` 的意义：它产出的就是**上游策略**（内嵌原始 sb3 + `Scaffolding.JSZip`），
作为 A/B 对照的基线，而不是一个「功能」。

---

## 14. 优化设计：BLPK 容器

上游把**原始 sb3 字节**塞进页面。Scratch 自己序列化出的 sb3 里，
**每个条目都是 DEFLATE（method 8）**——包括本来已经是压缩格式的 PNG/JPG/MP3。
于是每次打开都付两笔冤枉钱：

1. JSZip 解析中央目录、构造条目对象；`zip.file(name)` 未命中时退化成**正则扫全表**
2. 每要一个素材，就用**纯 JS inflater 在主线程上同步解压一次**，
   哪怕这个 PNG deflate 只省了 0.0%

BLPK 把 zip 换成扁平、已预解析的布局：

```
offset 0   "BLPK" | version | flags | reserved
offset 8   indexLength (uint32 LE)
offset 12  index JSON:  { "v":1, "p":[off,len,flag], "a": { "<md5ext>":[off,len,flag] } }
offset …   payload：所有条目字节首尾相接
```

`flag`：`0` 原样存储，`1` deflate-raw。

`buildContainer` 会**实测**每条目 deflate 后的收益，只有**省超过 5%** 才压缩。
所以 PNG/JPG 这类素材在容器里就是原始字节，打开时零解压。
deflate 真正有收益的（svg / wav / ttf）走平台原生
`DecompressionStream('deflate-raw')`，异步、可并行，并内联纯 JS inflater 作老浏览器兜底。

在合成工程（13.48 MB sb3）上，容器是 **104 条 deflate / 68 条原样，省 2.62 MB**——
正好对应「PNG 压不动、SVG 压得动」的真实分布。

---

## 15. 关键修正：素材必须**复制**给 VM，不能给视图

**这是整个项目里唯一一个「看起来最聪明的写法反而是灾难」的地方。**

零拷贝是最自然的想法：原样条目直接
`new Uint8Array(buffer, off, len)` 返回，省掉十几 MB 拷贝。实测结果：

> `fast` 比 `tw` **慢 5 倍**（11.9 s vs 2.2 s）。

消融定位到根因，在 `scratch-audio` 里：

```js
// scratch-audio/src/AudioEngine.js，_decodeSound()
const bufferCopy1 = sound.data.buffer.slice(0);
```

`.buffer` 取的是**整个底层 ArrayBuffer**，不是 `byteOffset / byteLength` 划出的那一段。
于是一旦 `sound.data` 是指向 13.5 MB 容器的视图，**每解码一个声音就把整个容器整份拷一遍**。
合成工程 30 个声音；真实作品只会更多。一次打开白拷几百 MB。

这不是 `scratch-audio` 的 bug——渲染器纹理上传、其它消费 `asset.data` 的地方，
**下游普遍假设「我拿到的字节是我的」**。零拷贝视图在这个假设下不成立。

修正（`container-reader.js` 的 `copyStored`，默认 `true`）：

- 原样条目返回 `buffer.slice(start, start + length)`——**恰好等于条目大小**的新 ArrayBuffer，
  满足 `byteOffset === 0` 且 `buffer.byteLength === byteLength`
- deflate 条目本来就由 `DecompressionStream` 新分配，天然独占，无需再拷
- 总代价 = 一次约 13.5 MB 的 memcpy，摊在整个加载过程里
- `--view-assets` 保留旧的视图行为，**只用于复现这个回归**，生产不要用

**教训可以推广**：只要一段字节会流进「别人写的」库，就不要以
`subarray` 视图的形式交出去——库里的 `.buffer.slice(0)`、`new Uint8Array(x.buffer)`、
甚至 `postMessage` 的 transfer 都会把整个底层 buffer 拽进去。
要么复制，要么就在文档里明确「这份字节归你独占」。

---

## 16. 实测结果

**方法**：无头 Edge（`--headless=new --disable-gpu --enable-unsafe-swiftshader`），
本地 HTTP 服务托管产物，页面用 `performance.now()` 自己打点、POST 回 `/__result`。
**4 个变体轮转交错跑 5 轮**——每轮跑遍所有变体，而不是把一个变体连着跑 N 次。
后一种排法会把机器的分钟级漂移（温度、后台负载）算到「排在后面」的那个变体头上。

单位 ms，`ALL LOADED` = `projectLoaded` = 「打开到这个作品能玩」：

| 变体 | decoded（对照） | project.json | **ALL LOADED** | min..max |
|---|---|---|---|---|
| `fast` 默认（复制素材，无 preload） | 540 | 564 | **1870** | 1832..4180 |
| `tw` 基线（内嵌 sb3 + JSZip） | 423 | 457 | **1954** | 1777..2053 |
| `fast --preload` | 446 | 451 | **1847** | 1701..2105 |
| `fast --view-assets`（第 15 节的回归开关） | 408 | 416 | **10187** | 9942..11429 |

第 1 轮对第一个跑到的变体是冷启动：`fast` 默认那次 4180 ms，其 `project.json` 计时
从约 500 ms 涨到 2784 ms。**注意这是一个纯 CPU 阶段、完全不碰素材**，所以它一涨就说明
这一轮不可比 —— 这个「对照点翻倍」就是识别受干扰轮次的手段。

### 结论（三句）

1. **必须复制素材这一条是决定性的**：`--view-assets` 的 5 次全部落在 9942–11429 ms，
   与其它变体的 1777–2200 ms **完全不重叠**，慢 **5.4 倍**。这是本次唯一一个量级级别的收益，
   也是第 15 节那个修正的全部价值所在。
2. **BLPK 容器本身在这个工作负载上测得是「持平」，不是「更快」。**
   中位数 1870 vs 1954（-4.3%）看起来像赢，但分布互相重叠，**而且最小值反而是基线更低**
   （1777 vs 1832）。诚实的说法是：**这项优化在 13.5 MB / 171 素材的规模上没能被测量出来。**
3. **`--preload` 没有可测收益**（1847 vs 1870）。原生 `DecompressionStream` 本来就异步可并行，
   它想隐藏的开销已经不在关键路径上。保留开关是因为理论上对「大量 deflate 条目 + 慢速设备」
   还有价值，但**不要宣称它有效**。

### 为什么容器没赢

fast 确实**做的事更少**：tw 要把 sb3 里**全部 171 个条目**用纯 JS pako 解一遍
（含 8.6 MB 压不动的 PNG —— 白做功），fast 只解 104 个「压缩真的有收益」的条目，
而且走原生 `DecompressionStream` 异步。

但这份负载里 **inflate 已经不是瓶颈**：40 张 PNG 解码、30 个声音解码、101 个 SVG 解析、
以及 VM 建对象图，才是那 1.8 s 的主要成分，而这部分各变体完全相同。
（另外 fast 有 101 个约 24 KB 的小 SVG 各自起一次 `DecompressionStream`，串行开销被小条目摊薄。）

**要让容器跑出差距，作品得是「大量大体积可压缩素材」**（字体、SVG、WAV 占大头）——
那时「只解该解的 + 原生并行解」才会显现。这是下一步该测的方向，而不是现在就下结论。

> 这一节的价值有一半在**否证**：第 14 节那套设计在纸面上很漂亮，实测却是持平。
> 如果不做这个 A/B，很容易把「容器比 zip 优雅」误当成「容器比 zip 快」写进结论里。


