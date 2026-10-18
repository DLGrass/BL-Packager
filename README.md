# bl-packager

把 `.sb3` 打包成**单文件 HTML**、**静态站点（ZIP）**、**单文件 Windows .exe**，或
**macOS `.app` / Linux 可执行文件 / Android `.apk`**，机制仿照
[TurboWarp/packager](https://github.com/TurboWarp/packager)，
并对**打开时的素材加载**与**体积**做了针对性优化与实测
（结论见第 5、6 节，**包含一项没测出收益、和一项需要前置条件才成立的结果**）。

零依赖：只用 Node 内置模块（`node:zlib` / `node:crypto` / `node:fs`），打包器本身没有构建步骤。
`.exe` 那一步用系统已有的 MSVC 编译，只用 Windows SDK 与 WebView2 SDK；
macOS / Linux / Android 三个原生宿主各自用平台的 WebView SDK 编译，见第 8 节。

上游 TurboWarp 打包器能做的，这里**除了「必须联网」和「需要另一套 npm 工具链」的那几项，
其余都补齐了**，见 4.1 的对照表——包括自定义扩展烘焙、加载页图片、自定义指针、
指针锁定 / 手柄、特殊云变量行为、应用图标与窗口模式。补齐后**没有任何联网依赖**：
扩展源码在打包时烘进产物，打开产物时不再回网络。

同一条管线也能**整个搬进浏览器**跑（`node:zlib` / `node:crypto` / `fs` 都由仓库内自带的实现顶上），
所以除了 CLI 和本地网页版，还有第三个交付形态：一个**纯前端的静态站点**，作品不经过任何服务器，
打开 [dlgrass.github.io/BL-Packager](https://dlgrass.github.io/BL-Packager/) 拖进 sb3 就能得到 HTML。
站点由 `pnpm build:site` 生成、由 CI 发到 GitHub Pages，见 4.1 节。

```bash
node src/pack.js project.sb3 -o out/project.html
node src/pack.js project.sb3 --mode=both --out-dir=out --instrument
node src/pack.js project.sb3 --target zip -o out/site.zip
node src/pack.js project.sb3 --extension my-ext.js --pointerlock

node src/pack-exe.js project.sb3 --title "My Game"    # 生成资源，再由 exe/build.cmd 编译

node src/pack-app.js project.sb3 --target macos       # .app / .zip / .dmg（需 macOS）
node src/pack-app.js project.sb3 --target linux       # ELF + .tar.gz（需 Linux）
node src/pack-app.js project.sb3 --target android     # .apk（需 Android SDK）
node src/pack-app.js project.sb3 --target all         # 一次渲染，三个目录都写

node ui/server.js                                     # 网页版：http://127.0.0.1:8788
```

包管理器是 **pnpm**（`packageManager: pnpm@10.33.0`，配合 corepack）。因为零依赖，
它在这里只做两件事：**钉住工具链版本**和**提供统一的入口脚本**——上面那些命令换个写法就是：

```bash
pnpm install            # 没有依赖，只会生成 pnpm-lock.yaml
pnpm test               # = node test/run.js
pnpm pack:html project.sb3 -o out/project.html
pnpm pack:exe project.sb3
pnpm pack:mac project.sb3       # = node src/pack-app.js --target macos
pnpm pack:linux project.sb3
pnpm pack:android project.sb3
pnpm ui                 # 网页版
pnpm build:site         # 纯前端静态站点 → site/（可直接扔进任意静态托管）
pnpm bench / ui-check / make-project
```

⚠️ 脚本叫 `pack:html` 而不是 `pack`，是**故意的**：`pnpm pack` 是 pnpm 的内置命令
（打 npm tarball），同名脚本会被它遮蔽——敲 `pnpm pack` 不会报错，而是**静默产出一个
`bl-packager-0.1.0.tgz`**。这种错最难发现，所以宁可从名字上避开。

`vendor/scaffolding-min.js` **不走包管理器**（它是上游产物，不随仓库分发），
得手动放到 `vendor/` 下，见 4 节。

网页版的界面照 [packager.turbowarp.org](https://packager.turbowarp.org/) 重建（卡片式布局、
明暗双主题、同样的选项分组），选项按这个仓库实现了的能力给，见 4 节。

---

## 1. 它做了什么

产物 HTML 的结构与 TW 一致，保证两种模式「只有我们想测的那部分不同」：

```
script 0  基准钩子（生产构建里是 no-op）
script 1  整个 Scaffolding 运行时（内联，~1.7 MB）
script 2  boot：new Scaffolding → setup() → 配置 VM / 控件
script 3  base85 解码器 + decodeChunk + takePayload
script 4  数据：<script data="…">decodeChunk(65536)</script> × N
script 5  装载器运行时 + createProjectSource + run()
```

和 TW 相同的部分：

- 自定义 **base85**（4 字节 → 5 字符，字符集 `0x2a–0x7e`，`<`→`(`、`>`→`)`），因此编码结果不含 `< > " ' &`，可直接裸放进 HTML 属性
- **64 KiB 分块**，每块一个 `<script>`，靠 `document.currentScript` 就地解码，边解析边还原
- 偏移按 `decodeChunk(N)` 的**声明值**累加（不是 `floor(len/5)*4`）
- 换运行时只需替换 `vendor/scaffolding-*.js` 与 `src/runtime/` 下的装载器

## 2. 打包成 HTML ≠ 转换工程

HTML 里跑的还是 scratch-vm。被打包器改写过的只有：

- `project.json` 的块 ID 按引用频次重编号，删掉 `x/y/comment` 等冗余字段（`src/lib/sb3.js`）
- 名字以 `☁` 开头的变量自动标记为云变量
- PNG 素材被无损重压时，素材名跟着换成新内容的 md5（`md5ext` 仍然诚实）
- 指定了 `--extension` 时，`extensionURLs` 里的地址被换成源码的 `data:` URL（4.4）

所以产物的 `project.json` 和原始 sb3 的**字节必然不同**，这是语义等价的压缩/改写，不是篡改。

---

## 3. 优化点：素材加载

**结论先行**（细节与实测在第 3.2–3.4 节和第 5 节）：这一节做出来的东西是 BLPK 容器，
它**在合成工程的规模上没能被测出比 TurboWarp 的 zip 路径更快**（中位数 1870 vs 1954 ms，
分布重叠）。真正量级级别的收益来自一个**反直觉的修正**——素材必须复制给 VM 而不能给视图，
这一条差 5.4 倍。两件事都写在这里，因为第二件比第一件重要得多。

### 3.1 问题

TurboWarp 的 HTML 目标把**原始 sb3 字节**塞进页面，运行时交给 `Scaffolding.JSZip` 解包。
Scratch 自己序列化出的 sb3 里，**每个条目都是 DEFLATE（method 8）**——包括本来就已经是压缩格式的
PNG/JPG/MP3。我们在真实 sb3 上验证过这一点：

```
=== subdirectory.sb3 ===
  png           method=8 raw=6016 stored=3007
  project.json  method=8 raw=989  stored=596
```

于是一次打开要付两笔代价：

1. JSZip 解析 zip 中央目录、构造每个条目的对象；查找失败时退化成**对所有条目做正则扫描**
2. VM 每要一个素材，就用 **JSZip 的纯 JS inflater 在主线程上同步解压一次**——哪怕这个 PNG
   deflate 只省了 0.1%，也一样要把 8 MB 字节跑一遍 inflate

### 3.2 做法：BLPK 容器

`src/lib/container.js` 把 zip 换成一个扁平、已预先解析的布局：

```
offset 0   "BLPK"
offset 4   version (uint8) | flags (uint8) | reserved (uint16)
offset 8   indexLength (uint32 LE)
offset 12  index JSON:  { "v":1, "p":[off,len,flag], "a": { "<md5ext>":[off,len,flag] } }
offset …   payload：所有条目的字节首尾相接
```

`flag`：`0` = 原样存储，`1` = deflate-raw。

装载时（`src/runtime/loader.js` + `container-reader.js`）：

| | TurboWarp 基线 | 本项目 fast |
|---|---|---|
| 元数据 | 解析 zip 中央目录 + 建条目对象 | 读 12 字节头 + 一次 `JSON.parse` |
| 素材查找 | `zip.file(name)`，miss 时正则全表扫描 | `Map` 命中，O(1) |
| **不可压缩素材**（png/jpg/mp3） | 纯 JS inflate，白做功 | **原样存储，不做任何解压** |
| 可压缩素材（svg/wav/ttf） | 纯 JS inflate，主线程同步 | 平台原生 `DecompressionStream('deflate-raw')`，异步 + 可并行 |
| 并发 | inflate 同步执行，无法并行 | 原生解压走流式管线，真正重叠 |
| 兜底 | — | 内联纯 JS inflater（已验证与 zlib 逐字节一致），老浏览器可用 |

> ⚠️ 这里有一个**反直觉的坑**，见 3.3 节：原样存储的条目**不能**直接以
> `subarray` 视图交给 VM，必须复制。否则整个优化会变成 5 倍的**负**优化。

另外两个小改进：

- **base85 解码用 128 项查表**替代「两次比较 + 减法」的函数调用（`src/lib/base85.js`），
  每 4 字节少约 10 个分支
- **`--preload`**：`project.json` 一到手就并行预热所有被 deflate 的载荷，把这段开销
  藏在 VM 解析 project.json 的时间里，而不是后面按 VM 的节奏一个个串行付

关于「是否提前解压」的取舍：`buildContainer` 会**实测**每条目 deflate 后的收益，
只有节省超过 5% 才压缩。所以 PNG/JPG 这类素材在容器里就是原始字节。

### 3.3 关键修正：素材必须**复制**给 VM，不能给视图

这是整个项目里唯一一个「看起来最聪明的写法反而是灾难」的地方，值得单独记一笔。

最初的实现是零拷贝：原样存储的条目直接 `new Uint8Array(buffer, off, len)` 返回，
即一个指向那 13.5 MB 解码缓冲的视图。理论上省掉了十几 MB 的拷贝。

实测结果是 **fast 比 tw 慢 5 倍**（11.9 s vs 2.2 s）。逐项消融定位到根因：

```js
// scratch-audio/src/AudioEngine.js，_decodeSound()
const bufferCopy1 = sound.data.buffer.slice(0);
```

`.buffer` 取的是**整个底层 ArrayBuffer**，不是 `byteOffset/byteLength` 划出的那一段。
于是每解码一个声音，都会把 13.5 MB 的整个容器缓冲整份拷一遍。
合成工程有 30 个声音，在真实作品里这个数字只多不少 —— 一次打开白拷几百 MB。

渲染器、`scratch-render` 的纹理上传、以及其它消费 `asset.data` 的地方也默认自己独占
这份 `ArrayBuffer`。**下游普遍假设「我拿到的字节是我的」**，所以零拷贝视图在这里不成立。

修正后（`src/runtime/container-reader.js` 的 `copyStored` 选项，默认 `true`）：

- 原样条目返回 `buffer.slice(start, start + length)`：一个**恰好等于条目大小**的新 ArrayBuffer，
  满足 `byteOffset === 0` 且 `buffer.byteLength === byteLength`
- deflate 条目本来由原生 `DecompressionStream` 返回新分配，天然独占，无需再拷
- 复制的总代价是「一次 13.5 MB 的 memcpy，摊在整个加载过程里」
- `--view-assets` 保留旧的视图行为，**只用于复现这个回归**，不要在生产里用

代价是峰值内存里多出一份素材副本；收益是把打开时间从 11.9 s 拉回 2.1 s。

### 3.4 代价与取舍

| 选项 | 说明 |
|---|---|
| 体积 | fast 与 tw 产物**体积基本一致**（实测 18.71 MB vs 18.60 MB，差 0.6%） |
| 兼容性 | 需要 `DecompressionStream`；缺失时自动回退到内联的纯 JS inflater |
| 内存 | 默认**复制**素材（见 3.3），因此峰值比 tw 多约一份素材大小 |

---

## 4. 命令行

```
node src/pack.js <project.sb3> [options]

  -o, --out <file>        输出路径（单模式）
      --out-dir <dir>     输出目录（--mode=both）
      --target <t>        html | zip             默认 html
                          zip = index.html + project.json + assets/，给静态托管用，
                          必须通过 http(s) 访问（file:// 下 fetch 读不到目录）
      --mode <m>          fast | tw | both          默认 fast
      --extension <spec>  把自定义扩展烘进产物：本地 .js 路径，或打包期抓一次的 URL。
                          可重复。不给它，引用远程扩展的作品离线就打不开
      --loading-image <f> 加载页图片（png/jpeg/gif/webp/bmp/svg）
      --loading-image-mode <m>  normal | stretch    默认 normal
      --cursor-image <f>  自定义指针图案（自动切到 cursor=custom）
      --cursor-center <x,y>     指针热点             默认 0,0
      --pointerlock       指针锁定 addon
      --gamepad           手柄 addon
      --special-cloud-behaviors  ☁ url / redirect / username … 特殊行为
      --unsafe-cloud-behaviors   ☁ eval 等「不安全」行为
      --scaffolding <f>   覆盖运行时脚本
      --full-runtime      即使没有 music 扩展也用 scaffolding-full
      --title <text>      窗口标题
      --autoplay          载入后直接运行
      --turbo             开启 Turbo Mode
      --framerate <n>     默认 30
      --username <name>   默认 player####
      --preload           并行预热被压缩的素材载荷
      --view-assets       把素材以解码缓冲的**视图**交给 VM。这是个**回归开关**，
                          仅用于复现 3.3 节的性能灾难，生产不要用
      --no-deflate        所有条目原样存储（产物不做任何解压）
      --no-optimize-png   保留 sb3 里的 PNG 原样（默认无损重压）
      --deflate-index     顺带尝试压缩容器索引
      --instrument        注入跑分钩子，把计时 POST 到 /__result
      --json              以 JSON 输出统计

      --options <spec>    整套选项：JSON 字面量，或 @文件.json
```

`--options` 收的就是网页版「导出」写出的那份文件（`{app, version, options}` 外壳会自动剥掉），
所以「在界面上调好 → 导出 → 命令行复现」是同一条路。手写的 `--title` / `--autoplay` /
`--turbo` / `--framerate` / `--username` / `--preload` / `--extension` / `--pointerlock` 等
仍然可用，并且**覆盖**选项文件里的同名项。`pack-exe.js` 收同一套（多了 `--icon` /
`--version` / `--window-mode`）。

图片类选项两种写法都认：`--options` 里的 `"loadingImage": "logo.png"` 是路径，界面上传的则是
`data:` URL——`pipeline.resolveImage()` 一个函数负责两种形态，渲染器只会看到后者。

`--mode=tw` 产出的就是 TurboWarp 的原始策略（内嵌 sb3 + JSZip），保留它是为了做 A/B 对照。

### 4.1 网页版（`ui/`）

```bash
node ui/server.js            # 默认 http://127.0.0.1:8788
node ui/server.js --port 9000 --open
```

界面照着 **TurboWarp 网页打包器**（`packager.turbowarp.org`，其 UI 在
[`src/p4/`](https://github.com/TurboWarp/packager/tree/master/src/p4)，Svelte）重建：
一样的 625px 居中卡片列、卡片顶部 6px 强调色条、同样的按钮三色（主色 / 绿 `#0FBD8C` / 橙 `#FF8C1A`），
以及跟随系统的浅色/深色主题。选项**载入作品之前不显示**，这也是上游的行为。

分组也照上游的 `PackagerOptions.svelte` 排：

| 卡片 | 对应上游 | 里面的项 |
|---|---|---|
| 运行选项 | `options.runtimeOptions` | 加速模式、帧率、补帧、高清画笔、无限克隆、角色可穿过边缘、移除其他限制、用户名、停止时关闭窗口；舞台（自定义舞台大小、三种缩放模式） |
| 展示选项 | `options.playerOptions` | 页面标题；加载页（进度条、提示文本、**加载页图片**）；控制栏（自动运行、绿旗/停止/暂停/全屏按钮）；颜色（背景/前景/主题色）；监视器（允许编辑列表、变量颜色、列表颜色） |
| 输入 | `options.interaction` | 正常指针 / 无指针 / **自定义指针图案 + 热点**；**指针锁定**、**手柄** |
| 云变量 | `options.cloudVariables` | 忽略 / 存储在本地浏览器，以及「作品 ID」；**特殊 / 不安全云变量行为** |
| 高级选项 | `options.advancedOptions` | 使用编译、循环计时器、自定义 CSS、自定义 JS、加载后移除原始素材数据、增大最大矢量图像分辨率 |
| **自定义扩展** | `options.extensions` + `bakeExtensions` | 选本地 `.js`，源码烘进产物（4.4） |
| 本打包器专用 | —— | 素材容器 `fast`/`tw`、PNG 无损重压、不压缩容器条目、预热素材 |
| 运行环境 | `options.environment` | 单文件 HTML / **静态网站（ZIP）** / Windows 应用程序（EXE）；选 EXE 时展开应用设置（窗口尺寸、启动模式、图标、版本号、F12） |

页面上只有**一张**输出卡：状态行。载入作品时它是作品摘要，打包完成后它就是**下载链接**
（`#downloads` 挂在 `#statusCard` 里），细节报表收在折叠的 `<details>` 里。
上游那张常驻的统计卡和「作品」卡都被去掉了——同一个位置重复三遍信息，读起来反而更慢。

`fencing` / `miscLimits` / `maxClones` / `maxTextureDimension` 在协议里是取值，在界面上是开关
（「角色可穿过边缘」是 `fencing: false`，「无限克隆」是 `maxClones: Infinity`，
「增大…分辨率」是 `maxTextureDimension: 2048 → 4096`）。换算只在 `readOptions()` 里做一次，
所以「导出」写出的 JSON 直接就是 CLI 认的格式，`导入` 只做反向那一次换算。

配色只用**一个**品牌 token（`--accent: #75c1c4`，Bilup 的品牌青）：卡片顶条、拖放高亮、
原生勾选/单选框、主按钮都取它，链接用它加深/提亮后的同色相（浅色 `#1f7a7e`，深色 `#7fd0d3`）。
它是个**浅色**相，白字压在上面只有 2.1:1，所以主按钮的文字改用同色相的暗墨
（`--accent-ink: #0d2e2f`，6.8:1）；绿/橙那两个语义按钮继续用白字，因为它们本来够深。
上游给每个分区一个不同的强调色，这里没有跟：那会把好不容易换成品牌色的界面又花回去，
分区靠标题就能区分。

和 TW 刻意不同的地方（界面层面的取舍）：

| | TurboWarp | 这里 |
|---|---|---|
| 导入方式 | Scratch 作品 ID / 文件 / 其他 URL | 只有文件 |
| 云变量 | 连 `clouddata.turbowarp.org` 实时同步 / 本地存储 / 逐变量自定义 / 忽略 | 只有本地存储 / 忽略 |
| 界面风格 | 每个分区一个强调色，主色 `#ff4c4c` | 单一品牌色 `#75c1c4`（几何与分组一致） |
| 输出 | 结果卡 + 下载区 + 统计 | 只有状态行，下载链接就在上面 |

只有文件导入，是因为 ID / URL 两种方式都要联网；云变量只留本地存储，是因为 WebSocket 那条路
同样要联网。这个打包器的定位是**纯本地**：本地网页版的打包在 Node 进程里做，
浏览器只负责拖拽、显示统计和下载；静态站点（4.2）连那一步也在浏览器里，
任何形态下作品都不离开这台机器。

#### 功能对照（逐项）

这一节是「上游有的，这里有没有」的完整清单，也是补功能时的验收表。

| 上游的能力（`PackagerOptions.svelte` 里的项） | 这里 | 实现在哪 |
|---|---|---|
| 目标：`html` | ✅ 单文件 HTML | `src/lib/html.js` |
| 目标：`zip`（给静态托管用） | ✅ `--target zip`，见 **4.5** | `packToZip()` + loader 的 `http` 模式 |
| 目标：`electron-*` / `nwjs-*` / `webview-mac` | ❌ 需要另一套 npm 工具链 | —— |
| 运行时：加速模式 / 帧率 / 补帧 / 高清画笔 / 克隆上限 / 围栏 / 其他限制 / 用户名 / 停止时关窗 / 舞台尺寸 / 缩放模式 / 最大纹理 | ✅ | `html.js` 的 boot 脚本 |
| 播放器：标题 / 进度条 / 加载文本 / 四个控制按钮 / 三种颜色 / 监视器颜色 / 允许编辑列表 / 自定义 CSS / 自定义 JS | ✅ | 同上 |
| 播放器：**加载页图片**（`normal` / `stretch`） | ✅ 见 **4.6** | `loadingImage` / `loadingImageMode` |
| 交互：正常指针 / 无指针 | ✅ | `cursor` |
| 交互：**自定义指针图案 + 热点** | ✅ 见 **4.6** | `cursorCustom` / `cursorCenterX,Y` |
| 交互：**指针锁定（`chunks.pointerlock`）** | ✅ 见 **4.7** | `pointerlock` |
| 交互：**手柄（`chunks.gamepad`）** | ✅ 见 **4.7** | `gamepad` |
| 云变量：忽略 / 存本地浏览器 | ✅ | `cloudMode` |
| 云变量：**特殊名字行为**（`☁ url` / `☁ redirect` / `☁ username` …） | ✅ 见 **4.7** | `specialCloudBehaviors` |
| 云变量：**不安全行为**（`☁ eval` …） | ✅ 见 **4.7** | `unsafeCloudBehaviors` |
| 云变量：WebSocket 实时同步 / 自定义服务器 / 逐变量单独设置 | ❌ 都要联网 | —— |
| 高级：使用编译 / 循环计时器 / 增大矢量分辨率 / 加载后移除原始素材 | ✅ | `compilerEnabled` / `warpTimer` / `maxTextureDimension` / `packagedRuntime` |
| 高级：**自定义扩展（URL 列表）+ `bakeExtensions`** | ✅ 见 **4.4**，且不需要联网 | `src/lib/extensions.js` |
| 应用：`app.icon` | ✅ EXE 图标，见 **6.4** | `--icon` / `app.rc` 的 `ICON` |
| 应用：`app.version` | ✅ EXE 的版本资源，见 **6.4** | `--version` |
| 应用：`app.windowMode`（窗口 / 最大化 / 全屏） | ✅ 见 **6.4** | `--window-mode` + `main.cpp` |
| 应用：`escapeBehavior`（Esc 在全屏时的行为） | ⚠️ 固定为「只退出全屏」 | `main.cpp` 的 `WM_KEYDOWN` |
| 应用：`packageName` / `windowControls`（无边框） / `backgroundThrottling` | ❌ Electron 专属 | —— |
| Steamworks 扩展配置 | ❌ 宿主不是 Electron | —— |
| 作品 ID / 其他 URL 导入 | ❌ 需要联网 | —— |

「不联网」这条线的处理方式值得单独说一句：**联网的位置从「打开产物时」挪到了「打包时」**。
扩展源码、加载页图片、指针图案都是打包时读进去、烘成 `data:` URL 写进产物的，
所以产物本身仍然可以在断网的机器上双击打开——这正是 README §7 曾经列为
「最常见的打包后打不开的原因」的那件事（见 4.4）。唯一可能联网的入口是
`--extension https://…`：那是**你明确指名的一个 URL**，抓一次，产物里不含它。

摆一个点不动、或者点了不生效的选项比不摆更糟，所以上表里 ❌ 的项在界面上根本不出现。

仍然是零依赖——只用了 `node:http`。三个前端（`src/pack.js`、`src/pack-exe.js`、
`ui/server.js`）都调 `src/lib/pipeline.js`，所以「同一个选项」在三处的含义必然一致；
测试里直接断言**网页版返回的 HTML 与 CLI 逐字节相同**。选项名单也只写一次
（`src/lib/pipeline.js` 的 `RENDER_OPTION_KEYS`）——不在名单里的键根本到不了渲染器，
所以界面上不可能出现一个「发得出去、没人接」的开关。

界面上独有的东西（也就是这个打包器自己的功能）：素材容器 `fast`/`tw` 对照、
PNG 无损重压、预热素材、不压缩容器条目、静态站点（ZIP）目标，以及 Windows EXE 目标
（应用设置：窗口尺寸、启动模式、图标、版本号、F12 开发者工具、顺带编译）。
「自定义扩展」「加载页图片」「自定义指针」是补齐上游的功能（4.4 / 4.6），命令行同样有。
另外「载入作品」那一步会先解析归档并报出里面有什么
（角色/素材/扩展/云变量数量/运行时/是否需要 full 版），`/api/inspect` 只解析、不做重压——
那是打包时才该付的代价。

安全姿态（这个进程收上传、写 `exe/build/`，所以）：

| 措施 | 原因 |
|---|---|
| 只绑 `127.0.0.1` | 不暴露到局域网 |
| 校验 `Host` 头 | 防 DNS rebinding：网页里的 JS 本来能访问 127.0.0.1 |
| 上传上限 512 MiB | 防止把内存写爆 |
| 图片与扩展源码按内容校验后重新编码 | 一张 percent-encoded 的「图片」可以把 `"` 或 `<` 带进 `url("…")`；`app.rc` 里放一个假 `.ico` 会让编译失败 |
| 单个扩展 2 MiB / 合计 6 MiB / 单张图片 2 MiB | 选项走 query string（4.6），所以每个上传项都必须有自己上限，超了回 413 |
| `/api/artifact` 走白名单 + 路径前缀校验 | 防目录穿越 |
| exe 请求串行化 | 并发会互相覆盖同一份 `app.html.gz` |
| 产物列表按 mtime 过滤 | `exe/build/` 是共享且不清理的，只列本轮写出的文件 |

`--view-assets`（那个性能回归开关）**故意没有暴露到界面上**：它是用来复现实验的，
不是功能。

### 4.2 纯前端站点（GitHub Pages）

```bash
pnpm build:site          # → site/{index.html, app.js, worker.js, local-api.js}
node bench/ui-check.js --site
```

`site/` 里**没有任何服务端**：把四个文件拷到任意静态托管上，拖进一个 sb3，HTML 就在浏览器里生成。
[dlgrass.github.io/BL-Packager](https://dlgrass.github.io/BL-Packager/) 就是这份产物，
由 CI 在 `main` 上 `build` 完就发布（见 §5）。

**难点不在页面，在于管线原本只认 Node。** `src/lib/` 用了四样浏览器没有的东西，所以每一样都在
仓库内重写了一份，而不是给站点留一个「需要服务器」的洞：

| 依赖 | 用在哪 | 站点里的替代 |
|---|---|---|
| `zlib.deflateRawSync` / `deflateSync` | 容器条目、整个产物 HTML 的压缩 | `src/lib/deflate.js`：同步的 DEFLATE 编码器（定长 Huffman + 贪心 LZ77 + lazy matching），带 RFC 1950 zlib 包装与 Adler-32 |
| `crypto.createHash('md5')` | 素材名、`md5ext` | `src/lib/md5.js`（RFC 1321） |
| `Buffer` | 整个 `src/lib/` 的读写习惯 | `src/lib/bytes.js`：`Uint8Array` 子类，补上 `read/write UInt*LE/BE`、`toString('latin1'\|'hex'\|'base64'\|'utf8')`、`from/concat/equals/copy/slice` |
| `fs` / `path` | 读 `vendor/`、拼路径 | 构建期把运行时文件塞进一张 VFS（按 basename 索引），`readFileSync` 直接查表；写文件在站点里直接抛错 |

`src/build-site.js` 是个**零依赖的迷你 bundler**：从 `src/lib/pipeline.js` 出发遍历 `require()` 图，
把每个模块包成一个 factory，再注入上面那几个 `node:*` 的垫片，最后把 `vendor/scaffolding-min.js`、
`src/runtime/*.js` 一并以字符串塞进 VFS。产物就是 `site/` 那四个文件（合计约 **2.0 MB**，
其中 `app.js` 1.94 MB —— 大头是 1.7 MB 的 scaffolding 运行时）。

页面**和本地网页版是同一份** `ui/index.html`。唯一的接线是三行：

- `ui/index.html` 里一处 `apiFetch = window.__BL_LOCAL__ ? __BL_LOCAL__.request : fetch`，
  于是健康检查、`/api/inspect`、`/api/pack` 三个调用在两种形态下走同一个函数；
- `site/local-api.js` 提供 `window.__BL_LOCAL__`，用 `Worker('worker.js')` 回答那三个路由，
  返回的对象形状与 `fetch` 一致（`ok/status/headers/json/blob`）；
- 打包在 **Worker** 里跑（`worker.js` 用 `importScripts('app.js')` 加载同一个 bundle）——
  真实作品要 CPU 烧好几秒，把主线程冻住、让「打包中…」两秒不动，比慢一点更糟。

它和本地网页版的差异，都写在明面上：

| | `ui/server.js` | 静态站点 |
|---|---|---|
| EXE 目标 | 可以（写 `exe/build/` 再交给 MSVC） | **隐藏**，`/api/pack-exe` 回 501 |
| 打包位置 | Node 主进程 | 浏览器 Worker |
| PNG 重压默认 | 开 | **关**（见下） |
| 产物字节 | 基准 | 约 **+0.5%**（见下） |

**PNG 重压在浏览器里默认关掉**，理由是实测：它要在浏览器里花 7.6 s，而且**产出与浏览器自己编码的
PNG 字节相同**——这套无损重压的价值在于「比 Chromium 的 canvas 编码器更好」，
而站点里的 deflate 是我们自己那份，赢不了系统 zlib。界面上的开关还在，只是默认不勾。

**产物比 CLI 大 0.5%**：`node bench/ui-check.js --site` 在合成工程上量到
**19,714,794 vs 19,617,817 字节（+0.49%）**，两次都是同一次运行里的页面 vs `src/pack.js`。原因只有一个：编码器用**定长
Huffman**，省掉了动态 Huffman 表那部分开销。试过加 lazy matching，压缩率没动、速度更慢，
所以没继续；真实的 sb3 里大头是已经压过的 PNG/MP3，这一项影响不到它们。要抹平这 0.5% 得写
动态 Huffman 编码器，收益不抵复杂度，**明确不做**。

正确性不靠「看起来能跑」保证：`test/run.js` 里有一节 `[browser codecs]`，
把 `deflate` 的输出交给真实的 `zlib.inflateSync` 解、把 `md5` 与 `node:crypto` 对拍、
把 Buffer 垫片与真 Buffer 的每一次读写对拍，共 5 项。

**部署**：CI 只有 `build` 和 `deploy` 两步——`build` 用 `actions/configure-pages` +
`upload-pages-artifact`（`path: site`）把站点传成 artifact，`deploy` 再用 `deploy-pages` 发布
（只对 push 到 `main`）。仓库设置里**必须把 Pages 的源改成 "GitHub Actions"**（Settings → Pages → Source），
这是唯一需要人工做一次的步骤；没改之前 `configure-pages` 会失败，报它自己那句提示。
Pages 站点是**公开**的，所以别把私有作品传上去打包——它真的会在人家的服务器上跑一遍。

### 4.3 运行时脚本

`vendor/scaffolding-min.js` 需要自己放到 `vendor/` 下（不随仓库分发）：

```
https://packager.turbowarp.org/scaffolding/scaffolding-min.js    # 2.5 MB 未压缩 / 1.7 MB 实际
https://packager.turbowarp.org/scaffolding/scaffolding-full.js   # 用到 music 扩展时才需要
https://packager.turbowarp.org/scaffolding/addons.js             # 可选：指针锁定/手柄/云变量行为，21 KB
```

没用到 music 扩展的项目会自动选 `-min`，省下约 2 MB。`addons.js` 只在用到 4.7 那几项时才需要，
缺了它打包会**明确报错并给出这个地址**，而不是静默掉功能。

---

### 4.4 自定义扩展：把源码烘进产物

这是本项目里唯一一项「上游有、而且不补就会天天踩」的功能。§7 曾经把它列成
「打包后打不开」最常见的原因，现在它被修掉了：

```
project.json: { "extensions": ["pen", "myExt"],
                "extensionURLs": { "myExt": "https://extensions.turbowarp.org/myExt.js" } }
```

打开产物时 scratch-vm 会调 `extensionManager.loadExtensionURL(那个 https 地址)`——
一个离线的产物在这里必然失败。`src/lib/extensions.js` 做两件事：

1. **包装 + 编码**：把源码包成 `(function(Scratch) { … })(Scratch);`（与上游一字不差，
   这样为沙箱写的扩展不会往页面里漏全局），再编码成 `data:` URL。选 `data:` 而不是
   `blob:` 是查过代码的：Scaffolding 的 `_isValidExtensionURL()` 只认
   `http/https/data/file`，`blob:` 会抛 `Invalid extension URL`。
   base64 与 percent-encoding 都生成一遍，**取短的那个**（平均 base64 赢，源码
   里空格多时差距明显）。
2. **两处落地**：
   - `project.json` 的 `extensionURLs[id]` **替换**成这个 data URL；
   - 同时在 boot 脚本里**提前 load 一遍**。

第二点是实测出来的，不是保险起见。Scaffolding 的 `_loadExtensions()` 遍历的是
**积木里用到的 id**（`installTargets` 那一侧收集的），不是 `project.json` 的
`extensions` 数组。所以「作品声明了一个扩展、但没有任何积木引用它」时，
VM 根本不会去加载它——极端情况是**一个没有积木的作品**。第一版只做了 (1)，
在无头浏览器里打开产物：`targets: 1`、没有报错、扩展的全局标记却是 `false`；
加上提前加载之后才变成 `true`。现在的说法是：提前加载是**必须品**，改写 URL 是**兜底**。

**id 怎么认出来的**（顺序即优先级）：

| 手段 | 依据 | 例 |
|---|---|---|
| `declares` | 源码里的短字符串字面量 ∩ `project.json` 还在指向 URL 的 id，**恰好命中一个** | 源码里 `id: 'myExt'` |
| `filename` | 文件名（去扩展名）与某个需要的 id 相同 | `myExt.js` |
| `only-one-left` | 只剩一个没匹配的文件、一个没填的 id，一对一配上 | —— |
| `eager` | 都不成立：仍提前加载，但不敢乱配对，并 warn | 加一个项目没引用的扩展 |

两个候选就不猜（会静默接错线），这一步有测试盯着。匹配不上的、以及仍然指向远程的 id，
会分别报出来：CLI 打 `extension! still remote: …`，界面上是「仍需联网」的红色行。

**命令行**：

```bash
node src/pack.js x.sb3 --extension my-ext.js                 # 本地文件
node src/pack.js x.sb3 --extension https://…/my-ext.js       # 打包时抓一次
node src/pack.js x.sb3 --extension a.js --extension b.js      # 可重复
```

URL 只抓一次、只抓你指名的那个，产物里不含它（产物的 `connect-src` 仍然允许联网，
但扩展不会再请求它）。界面里只提供「选本地文件」，因为让本地服务器去抓任意 URL
是没有必要多开的一个面。

**代价**：源码变成 base64 后约 1.33 倍，进容器时还会再被 base85 撑 25%——所以
`--json` / 界面报表里会写明每个扩展 `bytes → uriBytes`。一个 100 KB 的扩展通常
让产物大 150–180 KB，换来的是**离线可用**。

---

### 4.5 ZIP 目标：给静态托管用的形态

```bash
node src/pack.js x.sb3 --target zip -o out/site.zip
# 解压后：index.html + project.json + assets/<md5ext>
```

界面里对应「运行环境 → 静态网站（ZIP）」。**必须通过 http(s) 访问**：`file://` 下
`fetch()` 读不到同级目录，loader 会直接报「project.json is not next to index.html —
the zip has to be served over http(s), not opened from disk」，而不是白屏。

它和单文件版的区别不是"少一点东西"，而是**换了一种加载模型**：

| | 单文件 HTML | ZIP（`http` 模式） |
|---|---|---|
| 载荷 | base85 + BLPK，整包内联 | 无载荷：`fetch('project.json')` + 按需 `fetch('assets/<md5ext>')` |
| 解压 | 容器里只解真正压小的条目 | **一次都不解**，压不压交给 web 服务器 |
| 并行 | 解码串行（分块边解析边解） | 浏览器自己并发，VM 要一个来一个 |
| 缓存 | 20 MB 的 HTML 每次重下 | 每个素材一个 URL，第二次访问基本走缓存 |
| 体积 | 18.71 MB | **14.24 MB**（同一工程，−24%） |
| 内联了什么 | 运行时 + 解码器 + BLPK 读取器 | 只有运行时（`inflate-raw` / `container-reader` 都不进产物） |

体积差不是优化，是**算术**：base85 把任意字节撑 25%，外层 gzip 只能找回其中一部分；
素材单独成文件就没有这笔税。所以「单文件版更小」是错觉，只是它更方便。

两个实现细节值得记一笔：

- 目录结构是 `assets/<md5ext>` 扁平化。原始 sb3 里素材可能在子目录下，但 VM 永远只问
  `<md5ext>`，保留层级是没有意义的。
- 产物是**逐字节确定**的（`writeZip` 用固定的 DOS 时间戳），所以「同一次输入 → 同一份 zip」
  可以直接断言，测试里就是这么写的。

---

### 4.6 加载页图片与自定义指针

两者都是 `data:` URL 内联，所以离线可用，也不需要额外的上传通道。

```bash
node src/pack.js x.sb3 --loading-image logo.png --loading-image-mode stretch
node src/pack.js x.sb3 --cursor-image cursor.png --cursor-center 4,8
```

| 选项 | 值 | 说明 |
|---|---|---|
| `loadingImage` | data URL / 路径 | 加载页图片 |
| `loadingImageMode` | `normal` / `stretch` | `normal` 是一个 `<img>`（上限 60vw × 40vh，等比）；`stretch` 是背景图 `contain` 铺满整屏 |
| `cursorCustom` | data URL / 路径 | 指针图案。**给了图就自动切到 `cursor: custom`**，除非你把 `cursor` 显式设成 `none`（隐藏指针是更具体的意图） |
| `cursorCenterX/Y` | 整数 | 热点，落在 CSS 的 `url(…) x y, auto` 里 |

**所有图片都过 `src/lib/datauri.js`**，它做三件事，缺一不可：

1. **按内容识别**，不信扩展名。一个改名的 `.txt` 变成一张破图是最难查的那种 bug；
   `.ico` 更是硬要求——`rc.exe` 的 `ICON` 语句不吃 PNG，而报错信息不会告诉你这一点。
2. **重新编码成 base64**。前端送来的是 `data:` URL，可能是 percent-encoded 的；
   一个 `"` 或 `<` 如果原样进了 `url("…")` / `src="…"`，就是注入。
   重新编码是从字节重建，不可能带出这些字符。
3. **卡大小**：单张 2 MiB（解 base64 后）。

服务器这边，图片和扩展源码都跟其他选项一样走 query string——请求体留给 sb3 本身，
不用写 multipart 解析器。代价是超长请求行，所以 `ui/server.js` 把
`maxHeaderSize` 提到 12 MiB，真正的护栏是每一项自己的上限（图片 2 MiB、
单个扩展 2 MiB、扩展合计 6 MiB）。本机回环、且 Host 头有校验，这个折中是划算的。

---

### 4.7 addons：指针锁定 / 手柄 / 云变量行为 / 真·暂停

上游把这几项拆在 `chunks.*` 和 `cloudVariables.*` 里，实现都在一个独立产物
`scaffolding/addons.js`（21,885 字节）里，不在运行时主包里。这里做的是同一件事：
需要时把那个文件**内联进产物**，然后调一次

```js
ScaffoldingAddons.run(scaffolding, {pointerlock, gamepad, specialCloudBehaviors, unsafeCloudBehaviors, pause});
```

参数名是照着 addons 包自己的分派写的（`t.gamepad && …`、`t.pointerlock && …`），
没有自己发明。

| 选项 | 需要 addons 包？ | 没有它时 |
|---|---|---|
| `pointerlock` / `gamepad` | **是** | 打包直接失败，并给出下载地址 |
| `specialCloudBehaviors`（`☁ url` / `☁ redirect` / `☁ open link` / `☁ username` / `☁ set clipboard` / `☁ pasted` / `☁ room id`） | **是** | 同上 |
| `unsafeCloudBehaviors`（`☁ eval` 等） | **是** | 同上 |
| `controlPause`（暂停按钮） | 否，但**有就用** | 退回原生的 `vm.setPaused`，功能不变 |

`pause` 这一项值得单独说：addons 里的暂停会把 `vm.setPaused` 换掉，除了停 sequencer，
还会 **suspend AudioContext**、冻结线程计时器、并让暂停期间 `greenFlag` / `startHats`
不生效。原生的暂停只停循环，声音还会继续响。所以只要 `vendor/` 里有这个文件，
暂停按钮就用加强版；**没有文件也不报错**——把一个本来能用暂停按钮的工程变成打包失败，
比暂停弱一点更糟。

---

## 5. 测试与验证

```bash
pnpm test                 # = node test/run.js，88 项全部在 Node 里跑（含网页版的 HTTP 端到端）
```

覆盖内容包括：

- `crc32` 对拍标准向量与 `zlib.crc32`
- zip 读写往返、非 zip 输入必须报错
- base85 往返（含非 4 倍数长度），并断言输出**不含** `<>"'&`
- **纯 JS inflater 与 zlib 逐字节对拍**：9 种载荷 × 4 个压缩级别，含 stored block、全零、20 万随机字节、高度可压缩文本
- 容器解析：`project.json` 与每个素材**逐字节比对**
- **扩展烘焙**（4.4）：包装后的 data URL 解回来能跑、真的注册了扩展；四种 id 匹配手段各一条
  （含「两个候选就不猜」）；匹配不上时保留远程 URL 并 warn；`project.json` 改写后字节数如实更新；
  没有扩展的工程**一个字节都不动**
- **图片**（4.6）：按内容识别 png/ico/svg/jpeg/gif、拒绝非图片与超限、percent-encoded 的恶意
  payload 重编码后不含 `<>"'`
- **ZIP 目标**（4.5）：档内结构、`index.html` 里确实没有载荷/解码器/容器读取器、素材逐字节相等、
  两次打包字节相同；`http` 模式的 loader 用 stub `fetch` 跑通 project.json 与每个素材，
  缺素材返回 `null`、缺 project.json 给出可读的报错
- **归属语义**（3.3 节的回归护栏）：用一个「随机字节 + 高度可重复标记」的混合容器，
  断言默认路径交付的 buffer **不别名**容器、`byteOffset === 0`、
  且 `buffer.byteLength === byteLength`；再断言 `--view-assets` 确实会别名
- 装载器（用 stub 的 storage/vm 在 Node 里驱动真实的 `createProjectSource`）：
  原生解压路径、纯 JS 兜底路径、预热复用、未知素材返回 `null` 而非抛错
- 对上游 checkout 里 `test/packager/projects/*.sb3` 的**每个真实 fixture** 做往返验证
  （这一步抓出了 `subdirectory.sb3`：project.json 与素材整体位于一层子目录下）
- **浏览器侧编解码器**（`[browser codecs]`，5 项）：自己写的 deflate 编码器产出的流交给
  真实的 `zlib.inflateSync` 解、zlib 包装层连 Adler-32 一起校验、`md5` 对 `node:crypto`、
  Buffer 垫片对真 Buffer 的每次读写、以及编码器索引的那几张 RFC 1951 常量表长度

> ⚠️ 最后一项需要一份 [TurboWarp/packager](https://github.com/TurboWarp/packager) 的
> 检出放在**仓库外面**的 `<本仓库>/../_ref/turbowarp-packager`（那些 `.sb3` 夹具是上游的，
> 没有复制进本仓库）。路径不存在时这条测试会直接失败，而不是静默跳过 —— 夹具是用来
> 抓 bug 的，静默跳过等于没测。
- **网页版**：起一个真实 HTTP 服务（临时端口、临时根目录）后断言
  `POST /api/pack` 返回的字节与进程内管线**完全相同**、`mode=tw` 生效、
  `target=zip` 返回的档与 `packToZip()` 逐字节相同、query 里带的扩展源码真的被烘进
  `project.json`（同一工程不带源码时仍然指向原 URL）、
  `extensions` 缺 source / 超限 / 不是 JSON 时被拒、非 `.ico` 的图标 400、
  读不懂的加载页图片 400、
  播放器选项（`turbo`/`autoplay`/`framerate`/`username`/舞台缩放/监视器颜色/云变量…）确实
  传到了渲染层、空 body 返回 400、`/api/inspect` 只解析（不重压、不渲染）、`pack-exe` 只往
  注入的根目录写、窗口尺寸会被夹到合法区间、`exe/build/` 里**上一轮遗留的二进制不会出现在
  产物列表里**、`/api/artifact` 拒绝白名单外的名字与目录穿越、伪造 `Host` 头被 403 拦掉

其中「播放器选项确实传到了渲染层」这条带一个**反向断言**：夹具必须能被 PNG 重压压小，
否则翻转 `optimizePng` 观测不到任何差异，那条断言就会变成永远成立的噪音。

### 网页版的浏览器端到端

`test/run.js` 只到 socket 为止，看不出页面自己的接线对不对（拖放、
选项拼装、blob 下载）。所以：

```bash
node bench/ui-check.js --target exe --shot out/ui.png
node bench/ui-check.js --target zip                     # 静态站点包
node bench/ui-check.js --image logo.png --extension my-ext.js
node bench/ui-check.js --site --shot out/site.png     # 纯前端站点，没有服务端
```

它在进程内起服务、用**无头 Edge + CDP**打开页面，通过 `DOM.setFileInputFiles`
塞一个**真实的 sb3 文件**进去，点「载入作品」，等选项出现后点「打包」，
等页面报完成，然后把**下载链接指向的 blob 大小**读回来，和 `src/pack.js`
对同一工程写出的字节数比对。`--target exe` 走 exe 那条（切环境单选 → 生成资源 →
校验 `app.html.gz`），`--target zip` 走静态站点包那条（并断言应用设置与「预览」都被藏起来），
`--shot` 会先撑高视口再截一张**全页**截图。
`--theme light|dark` 先写 localStorage 再重载，并断言页面 `theme` 属性真的落在请求的
那一个上 —— 主题是在首帧之前解析的，只靠事后改属性验证不了这条启动路径。

`--image` / `--extension` 走的是**真实的 file input**（`DOM.setFileInputFiles`，一个真文件），
然后把 `readOptions()` 里的结果和 Node 侧读出来的期望值**逐字节**比对：
FileReader / `file.text()` 这一段是唯一没有单元测试覆盖的接缝，而它一旦出偏差（编码、丢了
BOM、读了一半），产物会照样"打包成功"，只是图片显示不出来、扩展加载不上。
比对之后产物字节仍然要求与 CLI 相同，因为参考产物就是用同一个 data URL / 同一份源码生成的。

`--site` 换成一个**只会发静态文件**的服务（没有 `/api/*`，和 Pages 的行为一致），要求先跑过
`pnpm build:site`，然后断言三件事：页面确实走了 `window.__BL_LOCAL__` 那条路、
版本行写着「浏览器内打包」、产物落在 CLI 的 **0.9–1.25 倍**带宽内（不再要求逐字节相等，
因为 bundle 自带 deflate，见 4.2）。`--site --target exe` 直接报错——站点上那个目标是被藏起来的。

### 浏览器端到端（打包产物本身）

```bash
node bench/make-project.js               # 生成合成工程（可压缩 + 不可压缩素材混合）
node src/pack.js out/bench/bench.sb3 --mode=both --out-dir=out/bench/default --instrument
node src/pack.js out/bench/bench.sb3 --mode=fast --out-dir=out/bench/views   --instrument --view-assets
node src/pack.js out/bench/bench.sb3 --mode=fast --out-dir=out/bench/preload --instrument --preload
node bench/run.js --runs=3
```

`bench/run.js` 起一个本地 HTTP 服务，用无头 Edge 逐个打开产物，页面把
`performance.now()` 的计时 POST 回 `/__result`。计时点是**产物自己报的**，
所以测的是真实产物的真实开销。

| 计时点 | 含义 |
|---|---|
| `decoded` | base85 载荷解码完成（各变体相同，用作对照） |
| `projectData` | `project.json` 交给 VM |
| `projectLoaded` | `loadProject` resolve —— 此时 scratch-vm 已经在建 target 的过程中把全部造型和声音都加载完了，**这就是「打开到这个作品能玩」的时间** |

合成工程刻意还原真实占比：171 个素材、16.1 MB 原始字节，其中
PNG 8.60 MB（deflate 只省 0.0%）、WAV 5.05 MB（省 7.5%）、SVG 2.46 MB（省 92.6%），
并且**按 Scratch 的做法强制对每个条目使用 DEFLATE**。

### 实测结果

无头 Edge，4 个变体**轮转交错**跑 5 轮（每轮跑遍所有变体，避免机器漂移被算到某个变体头上），
单位 ms。`ALL LOADED` = `projectLoaded`，即「打开到这个作品能玩」：

| 变体 | decoded（对照） | project.json | **ALL LOADED** | min..max |
|---|---|---|---|---|
| `default/bench.fast.html`（本方案默认） | 540 | 564 | **1870** | 1832..4180 |
| `default/bench.tw.html`（TurboWarp 基线） | 423 | 457 | **1954** | 1777..2053 |
| `preload/bench.fast.html` | 446 | 451 | **1847** | 1701..2105 |
| `views/bench.fast.html`（3.3 的回归开关） | 408 | 416 | **10187** | 9942..11429 |

第 1 轮对第一个跑到的变体是冷启动（`default/fast` 的 4180 ms，其 `project.json` 计时
也从约 500 ms 涨到 2784 ms —— 这是个纯 CPU 阶段，不碰素材，所以它一涨就说明这一轮不可比）。

要说清楚的部分，包括不好听的：

- **必须复制这一点是决定性的，不是锦上添花。** `views/fast` 的 5 次全部落在
  9942–11429 ms，与其它任何变体的 1777–2200 ms 完全不重叠：**慢 5.4 倍**。
  这是本次唯一一个量级级别的收益，也是唯一一个「做对了不赚、做错了巨亏」的地方。
- **BLPK 容器本身，在这个工作负载上测得是「持平」，不是「更快」。**
  中位数 1870 vs 1954（-4.3%），但分布互相重叠，而且**最小值反而是 tw 更低**
  （tw 1777 vs fast 1832）。诚实的说法是：**这项优化在 13.5 MB / 171 素材的规模上
  没能被测量出来。**
- **最快的单次测量是 `fast --preload`（1701 ms），比 tw 的最好成绩 1777 ms 快 4.3%**，
  但这同样在噪声范围内，不足以称为结论。
- **`--preload` 没有可测收益**（1847 vs 1870，落在噪声内）。原生
  `DecompressionStream` 本来就是异步、可并行的，preload 想隐藏的那段开销已经不在关键路径上了。
  保留这个开关是因为它在「大量 deflate 条目 + 慢速设备」时理论上仍有价值，但**不要宣称它有效**。

为什么容器没赢：fast 确实**做的事更少**——tw 要把 sb3 里全部 171 个条目用纯 JS pako 解一遍
（含 8.6 MB 压不动的 PNG），fast 只解 104 个真正压缩有收益的、且走原生异步。
但这份工作负载里 inflate 已经不是瓶颈：40 张 PNG 解码、30 个声音解码、101 个 SVG 解析、
以及 VM 建对象图，才是那 1.8 s 的主要成分，各变体在这部分完全相同。
**要让容器跑出差距，作品得是「大量大体积可压缩素材」**（字体、SVG、WAV 占大头），
那时「只解该解的 + 原生并行解」才会显现。这是下一步该测的方向。

`bench/run.js` 的原始输出在 `out/bench/results.json`（含每次的数值）。

### CI 与 Release（GitHub Actions）

CI 只有两步：**`build` 构建静态站点，`deploy` 把它发到 Pages**。

| 作业 | 平台 | 做什么 |
|---|---|---|
| `build` | ubuntu | 取 `vendor/scaffolding-min.js` → `pnpm install` → `pnpm build:site` → `configure-pages` → 把 `site/` 传成 Pages artifact |
| `deploy` | ubuntu | 只在 push 到 `main` 时发布上一个作业传上来的 artifact（`needs: build`），不再重复构建 |

`build` 在 push、PR 和手动触发时都跑，`deploy` 只看 `main` 的 push——所以 PR 上能验证的只有
「站点还构建得出来」。**测试套件、真实浏览器里的网页版比对、提交信息校验都不在 CI 里了**，
它们仍然存在，只是回到本机跑：

```bash
pnpm test            # 88 项：管线、站点构建、三平台资源、浏览器侧编解码器、网页版的 HTTP 端到端
pnpm run ui-check    # 真实浏览器里把页面打出来的包与 CLI 的字节比对
```

`deploy` 用 `concurrency: group: pages, cancel-in-progress: false`：已经在发布的那次应该跑完，
中途取消正是「站点只更新一半」的由来。它只多要两个权限（`pages: write`、`id-token: write`），
`build` 仍是只读。**第一次启用需要在仓库设置里把 Pages 的源选成 "GitHub Actions"**，
这一步 CI 做不到（要仓库管理权限），不做的话 `configure-pages` 会带着提示失败。

`build` 得先把**仓库故意没包含**的运行时补上——不补不是「跳过」，是直接失败：

- `vendor/scaffolding-min.js`：产物 HTML 要内嵌的运行时，从 `packager.turbowarp.org` 下载。
  实测该地址返回 **1,813,190 字节**，与本机 `vendor/` 里那份**同尺寸**，
  所以 CI 跑的和本机跑的是同一份运行时。

上游那套 `.sb3` 夹具（`../_ref/turbowarp-packager`）现在只有本机的 `pnpm test` 需要，
CI 不再克隆它。

CI **故意不做**两件事，因为在这里做只会得到假结论：

- **不编译 exe**：要 MSVC + 下载 WebView2 SDK，费钱且慢，而 `exe/build.cmd` 的价值在于
  本机那份 MSVC（它甚至写死了本机的 vcvars 与 Windows Kits 路径）。
- **不跑 `bench/run.js`**：它测的打开耗时，结论本身就是「几个变体落在噪声内」。
  放进 CI 会得到精确到毫秒的假差异——那正是这一节反复在提醒的事。

`.github/` 下另外两个文件不属于上面这条流水线：

- **`.github/workflows/release.yml`** — 推 `v*` 标签触发：先跑 `pnpm test`（**测试唯一还会在
  服务端跑的地方**），并校验「标签名 == `package.json` 的 version」（`v0.2.0` 配 `0.1.0` 的包会被拦住）；
  再用 `git archive` 打源码包——它只取标签那棵树的文件，所以自动排除 `node_modules`、`out/`、
  `vendor/`，并服从 `.gitattributes` 的 `export-ignore`；最后连同 `SHA256SUMS.txt` 挂到 Release 上，
  正文由提交信息自动生成。带 `-` 的标签（`v0.2.0-rc.1`）自动标成 pre-release 且不抢 `latest`。
  **源码包不含 `vendor/scaffolding-min.js`**（上游产物、不分发，见 §7），解压后按 §4 补一次即可。
- **`.github/dependabot.yml`** — 上游是对 npm 每日扫；这里没有依赖，所以主要盯 **actions 的版本**（每周），
  npm 那一档留作兜底（每月）。两档的提交前缀都是 Conventional type，和手写提交同一种格式。

### 提交规范（Conventional Commits）

所有提交形如 `type(scope): subject`：

```
type     build | chore | ci | docs | feat | fix | perf | refactor | revert | style | test
scope    可选，小写；subject 祈使句、不加句号；整行 ≤ 72 字符
例       feat(ui): publish the download link on the status line
         fix: stop dropping the last line of the probe output
         ci(release): attach the source archive to the tag
```

`Merge ...`、`Revert "..."` 与 rebase 用的 `fixup!` / `squash!` / `amend!` 豁免。

规则只有**一份**：`.githooks/conventional.js`（纯函数，`test/run.js` 里有 5 项断言盯着它）。
两个入口，用的是同一段代码，所以「本机判合规」和「事后批量查」不会分叉：

- **提交时**：`pnpm install` 的 `prepare` 会跑 `.githooks/install.js`，把 `core.hooksPath` 指到
  `.githooks/`（只改本仓库的 `.git/config`），`commit-msg` 钩子不合规就直接拒绝提交。
  手动装一次也行：`node .githooks/install.js`。临时绕过：`git commit --no-verify`。
- **批量查**：`node .githooks/check.js --range <base> <tip>`。CI 里原先有个 `commits` 作业跑它，
  现在那个作业已经删掉了——脚本留着，想查一段历史时手动跑。

> 已有的 5 条提交（`5a8c9e0`…`4f01895`）早于这条规则，按约定**不重写**：改写已推送的历史要 force push，
> 代价大于收益。所以 `check.js --range` 只看你给的那一段；范围算不出来时（新分支、手动触发）
> 退化成只看 tip，而不是把整段历史重新判红。

---

## 6. 打包成 .exe

产出一个**单文件、零外部依赖**（除系统自带的 WebView2 Runtime）的 Windows 播放器：

```bash
node bench/make-project.js --art            # 造一个带 canvas 风格位图的测试工程
node src/pack-exe.js project.sb3 --title "My Game" --probe out/probe.json
cd exe && ./build.cmd                       # MSVC，产出 exe/build/bl-player.exe
```

`--probe <file>` 让它自己证明自己：启动后轮询运行中的 VM，等 `runtime.targets` 建出来，
把 `{targets, assets, canvas, ms}` 写进该文件再退出。**「编译过了」和「跑起来了」不是一回事**，
这个开关就是用来区分二者的。

### 6.1 它由什么组成

```
exe = 宿主代码(~170 KB) + 资源 RCDATA = gzip(打包好的 HTML) + app.meta [ + app.ico + 版本资源 ]
```

图标与版本资源是可选的（6.4），不传时资源表与之前一模一样。

构建前需要一次性准备 **WebView2 SDK**（`build.cmd` 期望它在 `exe/sdk/pkg/build/native`）：

```powershell
$v = '1.0.4258.31'
$sdk = 'exe\sdk'; New-Item -ItemType Directory -Force $sdk | Out-Null
Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$v/microsoft.web.webview2.$v.nupkg" -OutFile "$sdk\wv.nupkg"
Copy-Item "$sdk\wv.nupkg" "$sdk\wv.zip"; Expand-Archive "$sdk\wv.zip" "$sdk\pkg" -Force
```

- 宿主是一个 ~170 KB 的 C++ 文件（`exe/src/main.cpp`），只做四件事：开窗口、
  起 WebView2、`WebResourceRequested` 里从内存资源应答 `https://bl.local/*`、收尾。
- `WebView2Loader` **静态链接**（`WebView2LoaderStatic.lib`），所以没有旁挂 DLL；
  CRT 也是 `/MT` 静态链接，所以不需要 VC++ 运行库。唯一的外部依赖是 WebView2 Runtime
  （Win10 21H2+ / Win11 自带）。
- 宿主里**没有任何解压器**。见下一节。

### 6.2 踩到的坑：WebView2 不会替你解 `Content-Encoding`

第一个版本把 gzip 后的 HTML 直接当资源发出去，并声明 `Content-Encoding: gzip`，
指望 Chromium 的网络栈解压——结果窗口里是一屏乱码字体。

原因：**`WebResourceRequested` 注入的响应不会跑 HTTP 内容解码**。被拦截的请求不带
`Accept-Encoding`，所以 Chromium 从不启用解码器，声明了也没用
（[WebView2Feedback#3629](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3629)；
Construct 的作者在下面报了同样的问题，他用的是 `deflate`）。

修法不花宿主一个字节：宿主只回一个几百字节的引导页，由**页面自己的
`DecompressionStream('gzip')`** 解开资源，再 `document.write` 把真正的应用写进去。
屏幕上的乱码因此变成一条可读的进度提示。

### 6.3 exe 能压到多小

结论先说：**exe ≈ 素材本身**，因为 Scratch 的素材（PNG/JPG/MP3/WAV）本来就是压过的。
在合成工程（101 target / 171 素材 / 16.1 MB）上实测：

| 方案 | 资源字节 | 相对 sb3 |
|---|---|---|
| 什么都不做：整页 base85，不压缩 | 18.71 MiB | 138.8% |
| 壳不压缩 + 容器独立资源(raw) | 15.31 MiB | 113.6% |
| **现状**：base85(container) → 整页 gzip | 14.49 MiB | 107.5% |
| base85(gzip(container)) → 整页 gzip | 14.40 MiB | 106.8% |
| 容器独立资源(gzip) + gzip(壳) | 14.20 MiB | 105.4% |
| 上面任一 + **PNG 无损重压** | 省 1.9 MiB | **95.7%** |

三条可用的杠杆，按收益排序：

1. **PNG 无损重压（最大的一条，已默认开启）。** Scratch 的造型/背景是画到 canvas 上
   再 `toDataURL('image/png')` 出来的，Chromium 那条路径给的是**全行 `filter=0` + 默认压缩级别**。
   无损重压（解除行滤波 → 按最小绝对差重选滤波 → 重新 deflate）实测：
   - 随机构造的类 canvas 位图：**IDAT 省 16.4%**（11.52 MB → 9.63 MB）
   - 一张 96×72 的平滑渐变图：省 24%
   像素逐字节不变；素材名会**跟着改成新内容的 md5**，所以 `project.json` 里的 `md5ext` 仍然诚实。
   实测把 exe 从 **17.61 MiB 压到 15.69 MiB（-10.9%）**，并已在 VM 里验证
   `targets:101 / assets:171 / error:null` 全部就位。
2. **别让 base85 的重编码税落在已经压过的数据上。** base85 把任意字节膨胀 25%，
   外层 gzip 只能把「字母表缩小」那部分找回来（约 20%），剩下的 4–5% 是白交的。
   把容器做成独立二进制资源（不经 base85）能省 0.28 MiB，顺带**去掉启动时的
   base85 解码**（这一项在浏览器跑分里约 500 ms）。**未实施**：收益相对改动量偏小。
3. **brotli q11 而不是 gzip。** 实测在这份数据上 brotli 比 gzip 好**一大截**
   （容器 13.435 → **12.608 MiB**，壳 0.769 → 0.679 MiB，合计再多省 1.2 MiB）。
   但 Chromium 的 `DecompressionStream` **只支持 gzip/deflate/deflate-raw，不支持 brotli**，
   要吃得先内联一个 JS brotli 解码器（>100 KB）。**未实施**，但这是下一个真正有量级的空间。

已经排除的：

- **UPX**：可压的只有 170 KB 宿主代码，载荷本身不可压，还招杀软。不值。
- **Windows Compression API（XPRESS/LZMS/MSZIP）**：宿主侧解压确实不花代码字节
  （`Cabinet.dll` 是系统库），但压缩率不如 gzip，而且 Node 侧没有对应的压缩器，
  得先写一个构建期小工具。不如上面第 3 条。
- **开一个本地 HTTP 服务器**：那样响应会走真正的网络栈，就能白拿 `Content-Encoding: br`。
  但要引入 winsock + 端口管理 + 监听套接字（防火墙/杀软观感差），为 1.2 MiB 不值得。

### 6.4 图标、版本与窗口模式

```bash
node src/pack-exe.js x.sb3 --icon app.ico --version 1.2.3 --window-mode maximize
```

界面里在「运行环境 → EXE → 应用设置」下。三样东西都只落在 `exe/build/` 的资源里，
宿主代码不需要改（图标是 `main.cpp` 早就在读的 `MAKEINTRESOURCE(1)`）：

| 选项 | 落地方式 |
|---|---|
| `--icon app.ico` | 写 `build/app.ico`，`app.rc` 加 `1 ICON "app.ico"`；`main.cpp` 用 `LoadImageW` 分别取大/小两个尺寸（任务栏与标题栏） |
| `--version 1.2.3` | `app.rc` 生成一个 `VERSIONINFO` 块（`FILEVERSION` / `ProductVersion` / `FileDescription`），Explorer 的属性页里就能看到 |
| `--window-mode` | `window` / `maximize` / `fullscreen`，写进 `app.meta` 的 `window=`；`main.cpp` 决定首帧是 `SW_SHOW` 还是 `SW_SHOWMAXIMIZED`，`fullscreen` 走和 F11 同一条无边框路径 |

三个约束值得写下来：

- **图标必须是 `.ico`**。`rc.exe` 的 `ICON` 语句不接受 PNG，失败信息也不会提示这一点，
  所以 `datauri.js` 按 magic 校验，CLI 和服务器都在写盘前拒绝。
- **`app.rc` 必须保持纯 ASCII**。`rc.exe` 按 OEM 代码页解析它，而标题常常是中文——
  标题留在 `app.meta`（UTF-8）里，`VERSIONINFO` 里的中文字符会被替换成 `?`。
  这是有意的：宁可文件属性里难看，也不要 `RC FAILED`。
  测试里有一条断言盯着「`app.rc` 的每个字节都 < 0x80」。
- **Esc 的语义固定为「只退出全屏」**（对应上游 `escapeBehavior: 'unfullscreen-only'`）。
  而且只在窗口**确实处于全屏**时才拦截：其余情况下 Esc 原样交给页面，
  否则指针锁定和页面自己的弹窗都会失灵。

### 6.5 实测

| 变体 | exe 字节 | 相对 sb3 |
|---|---|---|
| PNG 原样（`--no-optimize-png`） | 18,468,864（17.61 MiB） | 107.4% |
| **PNG 无损重压（默认）** | **16,451,584（15.69 MiB）** | **95.7%** |

也就是说，**优化后的 exe 比原始 sb3 还小**（95.7%），而 sb3 自己已经是「每条目强制 DEFLATE」的
归档了。省下 2,017,280 字节 = 1.92 MiB = **原来的 10.9%**。

启动实测（同一台机器，第二次运行，用户数据目录已热）：页面内自报
`performance.now()` 到全部素材载入完成 **4.5 s**（13.5 MB 素材、171 个）。

---

## 7. 已知限制

- 只支持 **sb3**。sb1/sb2 会在 `loadSb3` 里被明确拒绝，不做静默降级。
- 不支持 zip64（>4 GB 归档）。
- **扩展的源码需要你自己提供。** 打包期不做「自动去 extensions.turbowarp.org 找同名文件」这种事：
  要么 `--extension` 指定（本地文件，或打包时抓一次的 URL），要么产物照旧联网抓。
  后者离线打开会失败——这是当前最常见的「打包后打不开」来源，界面会把它标成「仍需联网」的红字，
  CLI 会打印 `extension! still remote: …`，但仍然不会替你做决定。
  另外烘进去的是**你给的那份源码**：id 对不上的话，VM 会在加载时报 `Unknown extension`，
  不会静默用错。
- 指针锁定 / 手柄 / 特殊云变量行为需要 `vendor/scaffolding-addons.js`（4.3），
  没有这个文件时那几项会**明确报错**而不是降级。
- `vendor/` 下的运行时脚本受各自许可证约束，本仓库不分发。
- 静态站点（4.2）**只能产出 HTML 和 ZIP**：exe 要 MSVC 与写盘，浏览器里做不到，所以那个目标在
  站点上被藏起来、接口回 501。站点的产物比 CLI 大约 **0.5%**（自带 deflate 用的是定长 Huffman），
  并且**不默认重压 PNG**。Pages 是公开托管，别把不想公开的作品传上去打包。
- ZIP 目标（4.5）**必须通过 http(s) 打开**，双击本地文件不行；它也**没有**单文件版那种
  「一个文件发给别人」的便利。
- EXE 的 `escapeBehavior` 固定为「只退出全屏」；Electron 的 `packageName` / 无边框窗口 /
  `backgroundThrottling` 没有对应物（宿主不是 Electron）。
- macOS / Linux / Android 三个目标**写资源**在任何平台都能做，**编译**只能在对应平台做
  （`.app` 要 clang + Cocoa/WebKit，ELF 要 GTK3/WebKit2GTK，APK 要 Android SDK）。
  这三个目标只在 CLI 里有，网页版不提供——理由和 exe 在静态站点上被藏起来是同一条。
- macOS 的 `.app` 是 **ad-hoc 签名**，只保证在本机（尤其 arm64）能起来；分发要 Developer ID +
  notarize，不在本仓库范围里（8.3）。
- Android 的 APK 默认用**当场生成的 debug key** 签名，能装、不能发布；Play 会拒绝 debug 证书（8.3）。
- Android 的 `--window-mode` 不生效（总是沉浸式全屏），`--orientation` 只对它有意义。
- 三平台宿主都没有 exe 的 `escapeBehavior` 之外的窗口定制：无边框、后台节流、
  `packageName` 一律没有。macOS 上也没有 F12（WKWebView 没有公开的打开检查器接口）。

## 8. 打包成 macOS / Linux / Android 的软件

`.exe` 那条路之外，还有三个**原生宿主**，跑的是同一份单文件 HTML：

```bash
node src/pack-app.js project.sb3 --target macos            # .app / .zip / .dmg
node src/pack-app.js project.sb3 --target linux   --build  # ELF + .tar.gz
node src/pack-app.js project.sb3 --target android --build  # .apk
node src/pack-app.js project.sb3 --target all              # 一次渲染，三个目录
```

`--target` 是**必填**的：给个默认值等于在用户没说的地方替他选平台。
`--build` 是可选的、也是唯一需要工具链的一步——和 `pack-exe.js` 一样，资源先落盘，
编译交给 `hosts/<target>/build.sh`：

|  | macOS | Linux | Android |
|---|---|---|---|
| 宿主代码 | ObjC + WKWebView（`hosts/macos/main.m`） | C + GTK3/WebKit2GTK（`hosts/linux/main.c`） | Java + WebView（`hosts/android/java/.../MainActivity.java`） |
| 载荷位置 | `Contents/Resources/app.html.gz` | `.rodata`（`.incbin`） | `assets/app.html.gz` |
| 解压 | zlib（SDK 自带） | zlib | `GZIPInputStream` |
| 工具链 | clang（Xcode / CLT） | gcc + pkg-config + `libwebkit2gtk-4.1-dev` | aapt2 / javac / d8 / zipalign / apksigner |
| 产物 | `.app` + `.zip` + `.dmg` | `bl-player`（单文件）+ `.tar.gz` | `.apk` |
| 体积构成 | 宿主 + gzip(html) | 宿主 + gzip(html) | 宿主 + gzip(html) |

### 8.1 三个宿主做的是同一件事

1. **复用 HTML 管线。** 载荷就是 `packToHtml()` 的输出。`test/run.js` 有一条断言盯着
   「三个目标的 payload 解压后与 CLI 产物**逐字节相同**」——宿主不是另一次转换。
2. **用平台自己的 gzip 解压。** Windows 那套 JS bootstrap（6.2）在这里不需要：
   WebView2 不给注入的响应做内容解码，而 zlib / `GZIPInputStream` 是白拿的。
3. **从 `http://127.0.0.1:<随机端口>/<128 位随机 token>/` 提供页面。** 三个平台共用这条，
   理由不是省事：打包出来的页面是个**真的 web app**（编译器要 `blob:` worker、声音要
   AudioWorklet，还有 WebGL 与 localStorage），而自定义 scheme 不是「潜在可信」origin，
   这些能力在上面会以各种方式失灵。回环 origin 和浏览器给的完全一样，代价是一个**只绑
   127.0.0.1** 的 socket（不触发防火墙提示，也不对外暴露），token 让同机其它进程读不到页面。

### 8.2 app.meta：三个宿主读的同一份元数据

格式与 exe 的 `app.meta` 一致（`key=value`，UTF-8，一行一个），多了三个键：

```
target=macos,linux,android   name=我的游戏 Test   id=dev.bilup.my_game
version=1.2.3                title=我的游戏 Test   width=640  height=480
gzip=1                       devtools=1           window=fullscreen（可选）
probe=/abs/path（可选）       orientation=portrait（可选，仅 Android）
```

两处和 Windows 不一样，都是有意的：

- **标题可以是中文。** `app.rc` 必须纯 ASCII（`rc.exe` 按 OEM 代码页解析），所以 exe 的中文标题
  只能留在 meta 里；plist / AndroidManifest / `.desktop` 都是 UTF-8，标题照原样写进去。
- **文件名保留 UTF-8。** `--name` 只去掉任何文件系统都不接受的字符
  （`/ \ : * ? " < > |` 与控制符），所以中文标题打出来就是 `我的游戏 Test.app`，
  而不是被转写成一串 ASCII（`slug()` 只用来**造 id**，id 必须 ASCII）。

`--id` 一个值同时当 CFBundleIdentifier 和 Android applicationId 用，两者语法不完全一样
（Android 不许连字符、不许数字开头），所以它是**归一化**而不是校验后报错：
`My Game!` → `dev.bilup.my_game`。要精确控制就显式给 `--id com.example.game`。

### 8.3 每个平台各自的取舍

**macOS**

- 产物是 **ad-hoc 签名**的（`codesign -s -`）。arm64 上不签名根本起不来，但**这不等于可分发**：
  给别人用还要 Developer ID 证书 + notarize，那一步不在本仓库里。
- **没有 F12。** WKWebView 没有公开的「打开检查器」接口，只有 `inspectable`；
  `--devtools 1`（默认）会把它打开，然后从 **Safari → 开发 → 你的 app** 附加。
  Linux 上的 WebKitGTK 有公开接口，所以那边 F12 是真的。
- `LSMinimumSystemVersion` 是 11.0；`NSAllowsLocalNetworking` 是给回环地址显式开的 ATS 口子。
- F11 切全屏，Esc 只退出全屏（和 exe 同一条语义），Cmd+Q 退出。

**Linux**

- 需要 **WebKit2GTK 4.1 且 ≥ 2.40**：4.0 没有 `webkit_web_view_evaluate_javascript`，
  构建脚本在用 `pkg-config --atleast-version` 检查后直接报出版本，而不是链接时报一堆 undefined。
- 载荷用 `.incbin` 塞进 `.rodata`，所以 `bl-player` 是**真正的单文件**，拷到哪都能跑。
- `.desktop` 的 `Exec` 固定为 `bl-player`（与 `build.sh` 产出的文件名一致），`Icon` 是应用 id；
  tar.gz 里是 `bl-player` + `bl-player.desktop` + `share/icons/hicolor/...` 的标准安装布局。
- 仓库只带一个 256×256 的 PNG，不做多尺寸图标与主题适配。

**Android**

- **不用 Gradle，也不用 androidx。** 宿主只碰 framework 类，所以构建就是
  `aapt2 → javac → d8 →（把 classes.dex 塞进 apk）→ zipalign → apksigner`，全在 SDK/JDK 里。
  这样避开 AGP/Gradle/JDK 的版本矩阵，代价是清单与资源由 `src/lib/apps.js` 生成。
- Activity 类名固定 `dev.bilup.player.MainActivity`，APK 的包名来自 `--id`——
  一个类在哪个 Java package 与 applicationId 无关，所以一份源码服务所有工程。
- `android:usesCleartextTraffic="true"` 只为 `127.0.0.1` 那台「服务器」；没有它，
  API 28+ 的 WebView 会直接 `ERR_CLEARTEXT_NOT_PERMITTED`。
- 默认签名是**当场生成的 debug key**（能装、不能发）。发布时给四个环境变量：
  `BL_KEYSTORE` / `BL_KEYSTORE_PASS` / `BL_KEY_PASS` / `BL_KEY_ALIAS`。
- 屏幕方向由 `--orientation` 决定（默认 `landscape`，Scratch 舞台本来就是 4:3 横的）。
- `--window-mode` 对 Android 没有意义：手机上不存在「窗口」，它总是沉浸式全屏。
- `--devtools 1` 打开的是 `chrome://inspect` 那条远程调试通道（要 USB 调试）。

### 8.4 CI 里才真正验证得了

`.github/workflows/hosts.yml` 三个 job，各在一个原生 runner 上跑：

| job | runner | 做什么 |
|---|---|---|
| `macos` | `macos-latest` | 构建 `.app`、`codesign -dv`、启动并把活着的 VM 的 `targets/assets/ms` 读回来 |
| `linux` | `ubuntu-latest` + GTK3/WebKit2GTK + Xvfb | 构建 ELF、在 Xvfb 里启动并同样读回 VM |
| `android` | `ubuntu-latest` + JDK 17 | 构建、签名、`aapt2 dump badging` / `apksigner verify`，不上模拟器 |

「编译过了」和「跑起来了」不是一回事，所以前两个 job 用 `--probe <file>` 让产物自己证：
宿主轮询活着的 VM，把 `{targets, assets, canvas, ms}` 写进那个文件再退出。
Android 没有这一条——一次模拟器启动比这个 workflow 里其它所有步骤加起来还贵，
APK 装到真机上看才是验证。

三个 job 都把产物作为 artifact 上传（`bl-player.zip`/`.dmg`、ELF+tar.gz、APK），
下载下来就是可直接安装的东西。

## 9. 目录

```
src/lib/        打包器侧（Node）：zip 读写、crc32、base85、PNG 无损重压、
                  sb3 装载与压缩、容器构建、HTML 生成
                  extensions.js   自定义扩展烘焙（4.4）：包装、id 匹配、改写 projectJSON
                  datauri.js      图片按内容识别 + 重编码（4.6），加载页/指针/图标共用
                  extension-source.js  CLI 的 --extension：读本地文件或抓一次 URL
                  deflate.js  bytes.js  md5.js
                  ↑ 浏览器侧的替代实现：同步 DEFLATE 编码器、Buffer 垫片、纯 JS MD5。
                    只在站点构建里替换掉 node:zlib / Buffer / node:crypto，Node 侧不用它们
src/lib/pipeline.js
                三个前端共用的管线：prepareProject（含扩展烘焙）/ inspectProject /
                  renderProjectHtml / packToHtml / packToZip / writeExeResources / buildExe
src/site/       静态站点专用的两片胶水：
                  client.js     browser 版 pack/inspect（与 ui/server.js 的映射一致）
                  local-api.js  用 Worker 回答 /api/*，使同一份页面也能在静态托管上跑
src/build-site.js
                零依赖迷你 bundler：遍历 require 图 + 注入 node:* 垫片 + VFS → site/
src/runtime/    会内联进产物、同时能在 Node 里被测的运行时：
                  inflate-raw.js      纯 JS DEFLATE 解码（浏览器兜底）
                  container-reader.js BLPK 读取
                  loader.js           装载器（fast / tw / http 三种模式）
src/pack.js     CLI（-> 单文件 HTML，或 --target zip 的静态站点包）
src/pack-exe.js CLI（-> 单文件 .exe；复用同一条 HTML 管线，两者不会走偏）
src/pack-app.js CLI（-> macOS .app / Linux ELF / Android .apk 的资源，第 8 节）
src/lib/apps.js  三平台目标的资源落盘：gzip 载荷 + app.meta + Info.plist /
                  AndroidManifest / .desktop；包名与文件名归一化、图标容器校验
ui/             本地网页版（node:http + 一个静态页面，零依赖）
                  index.html  仿 TurboWarp 打包器的界面（卡片式、明暗双主题）
                              —— 站点也用这一份，靠 window.__BL_LOCAL__ 分流
                  server.js   /api/{health,inspect,pack,pack-exe,artifact}
                              pack 收 target=html|zip，选项走 query string（4.6 说明了为什么）
site/           构建产物（不进版本库）：index.html / app.js / worker.js / local-api.js
exe/            WebView2 宿主（C++，MSVC 构建）+ build.cmd
hosts/          三个原生宿主 + 各自的 build.sh（第 8 节）
                  macos/main.m   ObjC + WKWebView，回环服务 + zlib
                  linux/main.c   GTK3/WebKit2GTK，回环服务 + .incbin 载荷
                  android/java   WebView，回环服务 + GZIPInputStream
bench/          合成工程生成器（--art 造 canvas 风格位图）+ 无头跑分 + 体积拆解
                  ui-check.js 无头浏览器里跑通整个网页版流程（--site 跑静态站点，
                              --target html|zip|exe 选产物形态）
test/           验证套件（88 项，含 ui 的 HTTP 端到端、三平台资源、浏览器编解码器与提交规范）
.githooks/      commit-msg 钩子 + 提交规范校验器（install.js 由 prepare 自动跑）
.github/        CI / Release / dependabot
vendor/         运行时脚本（需自行下载：scaffolding-min/full + addons）
out/            产物（不进版本库）
```
