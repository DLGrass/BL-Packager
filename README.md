# bl-packager

把 `.sb3` 打包成**单文件 HTML** 或**单文件 Windows .exe**，机制仿照
[TurboWarp/packager](https://github.com/TurboWarp/packager)，
并对**打开时的素材加载**与**体积**做了针对性优化与实测
（结论见第 5、6 节，**包含一项没测出收益、和一项需要前置条件才成立的结果**）。

零依赖：只用 Node 内置模块（`node:zlib` / `node:crypto` / `node:fs`），没有构建步骤。
`.exe` 那一步用系统已有的 MSVC 编译，只用 Windows SDK 与 WebView2 SDK。

```bash
node src/pack.js project.sb3 -o out/project.html
node src/pack.js project.sb3 --mode=both --out-dir=out --instrument

node src/pack-exe.js project.sb3 --title "My Game"    # 生成资源，再由 exe/build.cmd 编译

node ui/server.js                                     # 网页版：http://127.0.0.1:8788
```

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

所以产物的 `project.json` 和原始 sb3 的**字节必然不同**，这是语义等价的压缩，不是篡改。

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

  -o, --out <file>        输出 html（单模式）
      --out-dir <dir>     输出目录（--mode=both）
      --mode <m>          fast | tw | both          默认 fast
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
      --deflate-index     顺带尝试压缩容器索引
      --instrument        注入跑分钩子，把计时 POST 到 /__result
      --json              以 JSON 输出统计

      --options <spec>    整套选项：JSON 字面量，或 @文件.json
```

`--options` 收的就是网页版「导出」写出的那份文件（`{app, version, options}` 外壳会自动剥掉），
所以「在界面上调好 → 导出 → 命令行复现」是同一条路。手写的 `--title` / `--autoplay` /
`--turbo` / `--framerate` / `--username` / `--preload` 仍然可用，并且**覆盖**选项文件里的同名项。
`pack-exe.js` 收同一套。

`--mode=tw` 产出的就是 TurboWarp 的原始策略（内嵌 sb3 + JSZip），保留它是为了做 A/B 对照。

### 网页版（`ui/`）

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
| 展示选项 | `options.playerOptions` | 页面标题；加载页（进度条、提示文本）；控制栏（自动运行、绿旗/停止/暂停/全屏按钮）；颜色（背景/前景/主题色）；监视器（允许编辑列表、变量颜色、列表颜色） |
| 输入 | `options.interaction` | 正常指针 / 无指针 |
| 云变量 | `options.cloudVariables` | 忽略 / 存储在本地浏览器，以及「作品 ID」 |
| 高级选项 | `options.advancedOptions` | 使用编译、循环计时器、自定义 CSS、自定义 JS、加载后移除原始素材数据、增大最大矢量图像分辨率 |
| 本打包器专用 | —— | 素材容器 `fast`/`tw`、PNG 无损重压、不压缩容器条目、预热素材 |
| 运行环境 | `options.environment` | 单文件 HTML / Windows 应用程序（EXE）；选 EXE 时展开应用设置 |

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

和 TW 刻意不同的地方：

| | TurboWarp | 这里 |
|---|---|---|
| 导入方式 | Scratch 作品 ID / 文件 / 其他 URL | 只有文件 |
| 云变量 | 连 `clouddata.turbowarp.org` 实时同步 / 本地存储 / 逐变量自定义 / 忽略 | 只有本地存储 / 忽略 |
| 目标 | html / zip / electron / nwjs / wkwebview | 单文件 HTML / Windows EXE |
| 界面风格 | 每个分区一个强调色，主色 `#ff4c4c` | 单一品牌色 `#75c1c4`（几何与分组一致） |
| 输出 | 结果卡 + 下载区 + 统计 | 只有状态行，下载链接就在上面 |

只有文件导入，是因为 ID / URL 两种方式都要联网；云变量只留本地存储，是因为 WebSocket 那条路
同样要联网。这个打包器的定位是**纯本地**：打包在 Node 进程里做（`loadSb3` 需要 `node:zlib`），
浏览器只负责拖拽、显示统计和下载，作品不会离开这台机器。

上游还有四类选项这里**一个都没摆**，因为它们在这台机器上不可能真的生效：

| 缺的能力 | 为什么 |
|---|---|
| 指针锁定 / 手柄 | 靠 addons 里的额外区块，`scaffolding-min.js` 里没有 |
| 自定义扩展（含「烘焙进产物」） | 要么联网下载，要么把扩展源码整段嵌进去，与「不联网」冲突 |
| 自定义指针图案 / 加载页图片 | 需要一条图片上传通道，这套 API 没有 |
| zip / electron / nwjs / WKWebView 目标 | 只实现了 HTML 与 Windows EXE 两条产线 |

摆一个点不动、或者点了不生效的选项比不摆更糟，所以宁缺勿滥。

仍然是零依赖——只用了 `node:http`。三个前端（`src/pack.js`、`src/pack-exe.js`、
`ui/server.js`）都调 `src/lib/pipeline.js`，所以「同一个选项」在三处的含义必然一致；
测试里直接断言**网页版返回的 HTML 与 CLI 逐字节相同**。选项名单也只写一次
（`src/lib/pipeline.js` 的 `RENDER_OPTION_KEYS`）——不在名单里的键根本到不了渲染器，
所以界面上不可能出现一个「发得出去、没人接」的开关。

界面上独有的东西（也就是这个打包器自己的功能）：素材容器 `fast`/`tw` 对照、
PNG 无损重压、预热素材、不压缩容器条目，以及 Windows EXE 目标（应用设置：窗口尺寸、
F12 开发者工具、顺带编译）。另外「载入作品」那一步会先解析归档并报出里面有什么
（角色/素材/扩展/云变量数量/运行时/是否需要 full 版），`/api/inspect` 只解析、不做重压——
那是打包时才该付的代价。

安全姿态（这个进程收上传、写 `exe/build/`，所以）：

| 措施 | 原因 |
|---|---|
| 只绑 `127.0.0.1` | 不暴露到局域网 |
| 校验 `Host` 头 | 防 DNS rebinding：网页里的 JS 本来能访问 127.0.0.1 |
| 上传上限 512 MiB | 防止把内存写爆 |
| `/api/artifact` 走白名单 + 路径前缀校验 | 防目录穿越 |
| exe 请求串行化 | 并发会互相覆盖同一份 `app.html.gz` |
| 产物列表按 mtime 过滤 | `exe/build/` 是共享且不清理的，只列本轮写出的文件 |

`--view-assets`（那个性能回归开关）**故意没有暴露到界面上**：它是用来复现实验的，
不是功能。

---

### 运行时脚本

`vendor/scaffolding-min.js` 需要自己放到 `vendor/` 下（不随仓库分发）：

```
https://packager.turbowarp.org/scaffolding/scaffolding-min.js    # 2.5 MB 未压缩 / 1.7 MB 实际
https://packager.turbowarp.org/scaffolding/scaffolding-full.js   # 用到 music 扩展时才需要
```

没用到 music 扩展的项目会自动选 `-min`，省下约 2 MB。

---

## 5. 测试与验证

```bash
node test/run.js          # 45 项，全部在 Node 里跑（含网页版的 HTTP 端到端）
```

覆盖内容包括：

- `crc32` 对拍标准向量与 `zlib.crc32`
- zip 读写往返、非 zip 输入必须报错
- base85 往返（含非 4 倍数长度），并断言输出**不含** `<>"'&`
- **纯 JS inflater 与 zlib 逐字节对拍**：9 种载荷 × 4 个压缩级别，含 stored block、全零、20 万随机字节、高度可压缩文本
- 容器解析：`project.json` 与每个素材**逐字节比对**
- **归属语义**（3.3 节的回归护栏）：用一个「随机字节 + 高度可重复标记」的混合容器，
  断言默认路径交付的 buffer **不别名**容器、`byteOffset === 0`、
  且 `buffer.byteLength === byteLength`；再断言 `--view-assets` 确实会别名
- 装载器（用 stub 的 storage/vm 在 Node 里驱动真实的 `createProjectSource`）：
  原生解压路径、纯 JS 兜底路径、预热复用、未知素材返回 `null` 而非抛错
- 对上游 checkout 里 `test/packager/projects/*.sb3` 的**每个真实 fixture** 做往返验证
  （这一步抓出了 `subdirectory.sb3`：project.json 与素材整体位于一层子目录下）

> ⚠️ 最后一项需要一份 [TurboWarp/packager](https://github.com/TurboWarp/packager) 的
> 检出放在**仓库外面**的 `<本仓库>/../_ref/turbowarp-packager`（那些 `.sb3` 夹具是上游的，
> 没有复制进本仓库）。路径不存在时这条测试会直接失败，而不是静默跳过 —— 夹具是用来
> 抓 bug 的，静默跳过等于没测。
- **网页版**：起一个真实 HTTP 服务（临时端口、临时根目录）后断言
  `POST /api/pack` 返回的字节与进程内管线**完全相同**、`mode=tw` 生效、
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
```

它在进程内起服务、用**无头 Edge + CDP**打开页面，通过 `DOM.setFileInputFiles`
塞一个**真实的 sb3 文件**进去，点「载入作品」，等选项出现后点「打包」，
等页面报完成，然后把**下载链接指向的 blob 大小**读回来，和 `src/pack.js`
对同一工程写出的字节数比对。`--target exe` 走 exe 那条（切环境单选 → 生成资源 →
校验 `app.html.gz`），`--shot` 会先撑高视口再截一张**全页**截图。
`--theme light|dark` 先写 localStorage 再重载，并断言页面 `theme` 属性真的落在请求的
那一个上 —— 主题是在首帧之前解析的，只靠事后改属性验证不了这条启动路径。

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
exe = 宿主代码(~170 KB) + 资源 RCDATA = gzip(打包好的 HTML) + app.meta
```

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

### 6.4 实测

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
- 扩展不在打包期内联：产物运行时会通过 `vm.extensionManager.loadExtensionURL` 去拉
  `extensionURLs` 里的地址（通常是 `extensions.turbowarp.org`）。**离线打开会失败**，
  这是当前最常见的「打包后打不开」来源。
- `vendor/` 下的运行时脚本受各自许可证约束，本仓库不分发。

## 8. 目录

```
src/lib/        打包器侧（Node）：zip 读写、crc32、base85、PNG 无损重压、
                  sb3 装载与压缩、容器构建、HTML 生成
src/lib/pipeline.js
                三个前端共用的管线：prepareProject / inspectProject /
                  renderProjectHtml / packToHtml / writeExeResources / buildExe
src/runtime/    会内联进产物、同时能在 Node 里被测的运行时：
                  inflate-raw.js      纯 JS DEFLATE 解码（浏览器兜底）
                  container-reader.js BLPK 读取
                  loader.js           装载器（fast / tw 两种模式）
src/pack.js     CLI（-> 单文件 HTML）
src/pack-exe.js CLI（-> 单文件 .exe；复用同一条 HTML 管线，两者不会走偏）
ui/             本地网页版（node:http + 一个静态页面，零依赖）
                  index.html  仿 TurboWarp 打包器的界面（卡片式、明暗双主题）
                  server.js   /api/{health,inspect,pack,pack-exe,artifact}
exe/            WebView2 宿主（C++，MSVC 构建）+ build.cmd
bench/          合成工程生成器（--art 造 canvas 风格位图）+ 无头跑分 + 体积拆解
                  ui-check.js 无头浏览器里跑通整个网页版流程
test/           验证套件（45 项，含 ui 的 HTTP 端到端）
vendor/         运行时脚本（需自行下载）
out/            产物（不进版本库）
```
