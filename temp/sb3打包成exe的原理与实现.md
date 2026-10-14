# 把 sb3 作品打包成 .exe 的原理与实现

> 参考源码：**TurboWarp/packager**（上游）与微软 WebView2 文档。
> 本文所有数字都来自本机实测（Windows，MSVC x64，Edge WebView2 Runtime 155.0.4283.45），
> 不是估算。凡涉及「未实施」的结论都标注了原因。

---

## 0. 一句话结论

`.sb3` → `.exe` 的主流做法不是「把 Node/Electron 塞进去」，而是
**「一个极小的原生宿主 + 系统自带的 WebView2」**：宿主约 170 KB，把打包好的
单文件 HTML 作为资源塞进 PE 资源段，运行时用一个自定义 origin 把它喂给 WebView 里的浏览器。

于是体积的账非常简单：

```
exe ≈ 宿主代码(~170 KB) + 压缩后的打包 HTML
    ≈ 170 KB + 素材本身（PNG/JPG/MP3/WAV 本来就已经压过）
```

**所以「压缩 exe」实际上是「压缩素材」，不是「压缩程序」。**
在本文的合成工程上，不做素材处理时 exe 是 sb3 的 107.4%；加上 PNG 无损重压后是 **95.7%**
——**比原始 sb3 还小**。剩下的空间几乎全在「资产本身能不能变小」上。

---

## 1. 三种路线的体积对比

| 路线 | 空壳体积 | 说明 |
|---|---|---|
| Electron | 120–200 MB | 自带整个 Chromium + Node。可预测性最好，体积最差 |
| Tauri / Wails | 3–10 MB | 原生壳 + 系统 WebView2（Windows）/ WebKitGTK（Linux）。Rust 或 Go 工具链 |
| **本项目（纯 Win32 + WebView2）** | **~170 KB** | 没有框架，就是一个 `main.cpp`；需要 MSVC 与 WebView2 SDK |

选第三条不是因为「越小越好」，而是因为这个项目的载荷动辄十几 MB，
**框架的体积（几 MB）和载荷（十几 MB）是同一量级**，省下几 MB 是有意义的；
而且这个项目已经零依赖了，不想再引一条 Rust/Go 工具链。

前提：**WebView2 Runtime 必须存在**。Windows 10 21H2+ 与 Windows 11 随系统自带；
更老的系统要单独装 Evergreen Runtime。这是这个方案唯一的运行时硬依赖。

---

## 2. 整体架构

```
                    ┌──────────────────────────── bl-player.exe ────────────────────────────┐
                    │                                                                        │
   PE 资源段        │   RCDATA 101 = gzip(打包好的 HTML)     ~15–17 MB                         │
                    │   RCDATA 102 = app.meta（标题/尺寸/probe 路径）  几十字节                │
                    │                                                                        │
   宿主 (main.cpp)  │   Win32 窗口 + ICoreWebView2                                            │
     ~170 KB        │   WebResourceRequested 拦截 https://bl.local/*                          │
                    │     ├─ /index.html      -> 回一个几百字节的引导页（内嵌在 C++ 里）        │
                    │     └─ /app.html.gz     -> 回 RCDATA 101 的原始字节（零拷贝 IStream）     │
                    │                                                                        │
   WebView2         │   引导页：fetch('/app.html.gz') -> DecompressionStream('gzip')           │
   (系统自带)        │            -> document.write(解出来的 HTML)                             │
                    │   真正的应用：Scaffolding 运行时 + BLPK 容器 + scratch-vm               │
                    └────────────────────────────────────────────────────────────────────────┘
```

关键点：**宿主里一行解压代码都没有**。解压交给页面自己的 `DecompressionStream`，
所以 15 MB 的资源不需要在 exe 里带一个解压器。

---

## 3. 完整流程（sb3 → exe）

### 3.1 编译期（Node 侧，`src/pack-exe.js`）

1. **复用 HTML 管线。** 调 `loadSb3()` + `buildContainer()` + `renderHtml()`，
   拿到和 HTML 打包器**完全一样**的产物。exe 与 HTML 两条路共用同一段代码，所以不可能走偏。
2. **素材优化**（默认开启）：PNG 无损重压（见第 5 节）。
3. **整页 gzip**（level 9）。HTML 里 99% 是 base85 数据和运行时脚本，gzip 后从 20 MB 降到 15.5 MB。
4. **写出资源文件**：`exe/build/app.html.gz`、`app.meta`，以及 `app.rc`：

   ```
   101 RCDATA "app.html.gz"
   102 RCDATA "app.meta"
   ```
5. **调用 `exe/build.cmd`**（MSVC），把 `main.cpp` + `app.rc` 编成 `bl-player.exe`。

### 3.2 构建期（`exe/build.cmd`）

- `rc.exe` 编译 `app.rc`：这一步把 15 MB 的资源压进 PE 的 `.rsrc` 段。
- `cl.exe` 编译 C++。
- `link.exe` 链接。两个「体积相关」的开关：

| 开关 | 作用 | 不用的后果 |
|---|---|---|
| `/MT` | CRT 静态链接 | 需要 VC++ 运行库（`VCRUNTIME140.dll` 等） |
| `WebView2LoaderStatic.lib` | WebView2 加载器静态链接 | 需要旁挂 `WebView2Loader.dll` |

`dumpbin /dependents` 实测结果，只有系统 DLL：

```
ole32.dll  SHLWAPI.dll  USER32.dll  GDI32.dll  KERNEL32.dll  ADVAPI32.dll
```

段体积：`.text`（代码）**102,400 字节**，`.rsrc`（资源）≈ 16.27 MB，其余加起来不到 80 KB。

### 3.3 运行期

1. `wWinMain`：读 `app.meta`（标题、窗口尺寸、是否 gzip、probe 路径）→ 加载 RCDATA 101。
2. 建窗口，`CreateCoreWebView2EnvironmentWithOptions` 用**每实例用户数据目录**
   （`%LOCALAPPDATA%\bl-player\<标题>`）。这个目录放 HTTP 缓存与 GPU shader 缓存，
   **第二次打开同一个大作品会明显更快**，所以要保留。
3. `AddWebResourceRequestedFilter("https://bl.local/*")` + `add_WebResourceRequested`。
4. `Navigate("https://bl.local/index.html")`。
5. 引导页解压并注入真正的应用；VM 开始 `loadProject()`；素材通过 `addHelper` 按需供应。

---

## 4. 踩到的坑：WebView2 不会替你解 `Content-Encoding`

第一个版本把 gzip 后的 HTML 直接当资源发出去，并声明：

```
Content-Type: text/html; charset=utf-8
Content-Encoding: gzip
```

**结果：窗口里是一屏乱码。** 排查过程值得记下来，因为它很容易被误判成「gzip 写坏了」。

### 4.1 怎么确认是「没解压」而不是「数据坏了」

把 `app.html.gz` 的前 48 字节按 latin1 打出来：

```
1f 8b 08 00 00 00 00 00 02 0a ec bd 69 7b db 38 b2 28 fc 7d 7e 05 cd 39 a3 e6 02 c9 5a bc 4a 41 fc 2a b6 92 f6 b4 63 fb 58 4a 77 67 34 ba 7e 29
   \____ gzip 魔数，文件本身完全正常 ____/   \______ 从偏移 11 起是一串「像文本」的字节 ______/
```

屏幕上那串字符里能认出 `Z.JA`（对应字节 `5a bc 4a 41`）和 `XJwg4~)`（对应 `58 4a 77 67 34 ba 7e 29`），
**位置和取值都对得上**——也就是说，渲染器拿到的就是压缩流本身，只是把不可打印字节画成了方框。
gzip 在压「准随机」的 base85 文本时会输出很多可打印字节，所以它看起来**像**乱码文本，
这正好掩盖了真相。

### 4.2 原因

**`WebResourceRequested` 注入的响应不会跑 HTTP 内容解码。** 被拦截的请求不携带
`Accept-Encoding`，因此 Chromium 从不启用解码器，`Content-Encoding` 声明了也不会被处理。
这是已知行为，不是用法错误：

- [WebView2Feedback #3629](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3629)
  （报告者用 `gzip`，Construct 的作者在下面跟帖说 `deflate` 也一样，「把压缩数据当文本加载」）
- 顺带一个相邻的坑（同一讨论区 [#4024](https://github.com/MicrosoftEdge/WebView2Feedback/discussions/4024)）：
  `CreateWebResourceResponse` 的 `reasonPhrase` 必须是 `OK`，否则响应会被**静默忽略**。

### 4.3 修法（不花宿主一个字节）

宿主只回一个几百字节的引导页，解压由页面自己做：

```html
<script>(async () => {
  const res = await fetch('app.html.gz', {cache: 'no-store'});
  const html = await new Response(
      res.body.pipeThrough(new DecompressionStream('gzip'))).text();
  document.open(); document.write(html); document.close();
})();</script>
```

`document.write` 在这里是**故意的**：`document.open()` 会把文档重置成解析中状态，
随后的 `document.write()` 会作为新文档被解析，**内联 script 会正常执行**，
而且 `window` 不变，所以 `window.vm` 之类仍然落在同一个上下文里，探针脚本不用改。

---

## 5. 体积构成与所有候选方案（实测）

合成工程：101 个 target、171 个素材、16.1 MB 原始字节。
素材构成：PNG 8.60 MB / WAV 5.05 MB / SVG 2.46 MB。
sb3 本身 13.48 MiB（scratch 的序列化器对每个条目强制 DEFLATE）。

### 5.1 原始数据

| 项 | 字节 |
|---|---|
| sb3 输入 | 13.478 MiB |
| BLPK 容器（104 条 deflate / 68 条 raw） | 13.552 MiB |
| Scaffolding 运行时 JS | 1.729 MiB |

### 5.2 六种装载编码，同一份工程

| 方案 | 说明 | 资源字节 | 相对 sb3 |
|---|---|---|---|
| F 什么都不做 | 整页 base85，不压缩 | 18.708 MiB | 138.8% |
| E 壳不压缩 | 容器独立资源(raw) + 壳不压缩 | 15.311 MiB | 113.6% |
| **A 现状** | base85(container) → 整页 gzip | 14.487 MiB | 107.5% |
| B | base85(gzip(container)) → 整页 gzip | 14.401 MiB | 106.8% |
| C | 容器独立资源(raw) + gzip(壳) | 14.322 MiB | 106.3% |
| D | 容器独立资源(gzip) + gzip(壳) | 14.204 MiB | 105.4% |

注意 A→D 只差 0.28 MiB（2%）。**这说明结构层面已经贴着地板了**——
容器那 13.5 MB 是素材，怎么搬都是 13.5 MB。

### 5.3 四种压缩器，同一份数据

| 数据 | raw | gzip -9 | brotli q11 | zstd -19 |
|---|---|---|---|---|
| container (BLPK) | 13.552 MiB | 13.435 | **12.608** | 13.099 |
| base85(container) | 16.941 MiB | 13.707 | 13.467 | 13.489 |
| scaffolding JS | 1.729 MiB | 0.760 | **0.671** | 0.694 |
| 整页 HTML | 18.708 MiB | 14.487 | **14.150** | 14.197 |

两个反直觉的点：

1. **base85 之后的 gzip 好于 base85 之前**：`base85(container)` 的 gzip 是 13.707 MiB，
   比容器原始大小 13.552 MiB **还大**。base85 把字节膨胀了 25%，外层 gzip 只能把
   「字母表从 256 缩到 85」那部分（约 20%）找回来，剩下 4–5% 是白交的税。
   想省就把熵编码放在 base85 **内**侧（方案 B / D）。
2. **brotli 在这类数据上明显优于 gzip**（容器上多省 0.83 MiB）。但见 5.5。

### 5.4 PNG 无损重压：唯一有量级的杠杆

Scratch 的造型/背景是画到 canvas 上再 `canvas.toDataURL('image/png')` 出来的，
Chromium 那条路径的习惯是**每一行都用 `filter=0`（None）**、zlib 用默认级别。
这是合法编码，但对平滑图形来说很浪费：按行做差分滤波能把大部分冗余在 deflate 之前就消掉。

做法（`src/lib/png.js`）：解析 chunk → 拼接 IDAT → inflate → 逐行**解除**滤波 →
按「最小绝对差之和」**重选**每行的滤波类型 → 重新 deflate（尝试
`Z_DEFAULT_STRATEGY` / `Z_FILTERED` / `Z_RLE` 三种策略取最小）→ 重打包。
**像素逐位不变**；PLTE / tRNS / gAMA / iCCP 等 chunk 原样复制；Adam7 交错图直接放弃。

实测：

| 输入 | 结果 |
|---|---|
| 96×72 平滑渐变图（合成） | IDAT 省 **24.0%** |
| 40 张 480×360 类 canvas 位图（合成，含抗锯齿描边与轻微噪声） | 11.52 MB → 9.63 MB，省 **16.4%** |
| 真实场景预期 | 造型/背景越平滑省得越多；照片类、噪点类几乎为 0 |

**素材名会跟着改。** Scratch 的资产名就是它自己内容的 md5，重压之后必须把
`project.json` 里所有 `md5ext` / `assetId` 一起改掉，否则名字就在说谎
（`loadSb3` 里做了这件事，测试里有断言守着）。

端到端效果：

| 变体 | exe 字节 | 相对 sb3 |
|---|---|---|
| PNG 原样（`--no-optimize-png`） | 18,468,864（17.61 MiB） | 107.4% |
| **PNG 无损重压（默认开启）** | **16,451,584（15.69 MiB）** | **95.7%** |

**省 2,017,280 字节（1.92 MiB，原体积的 10.9%），优化后的 exe 比原始 sb3 本身还小。**
这是整个探索里唯一一个两位数百分比的收益。（sb3 自身已经是「每个条目强制 DEFLATE」的归档，
所以「exe 比 sb3 小」并不是矮子里拔将军。）

### 5.5 未实施的三项，以及为什么

| 方案 | 理论收益 | 未实施的原因 |
|---|---|---|
| 容器改为独立二进制资源（不经 base85） | 0.28 MiB + 去掉启动时 base85 解码（约 500 ms） | 收益相对改动量偏小（要动 html.js / loader.js / pack-exe.js / main.cpp 四处） |
| **brotli q11 代替 gzip** | **1.2 MiB** | Chromium 的 `DecompressionStream` **只支持 gzip / deflate / deflate-raw，不支持 brotli**。要吃下来必须先内联一个 JS brotli 解码器（>100 KB），净收益仍在但引入了一整个 vendored 依赖 |
| 本地 HTTP 服务器 + `Content-Encoding: br` | 同上 1.2 MiB | 响应若走真正的网络栈，内容解码就会正常工作，可以白拿 brotli。但要引入 winsock、端口管理、监听套接字——防火墙与杀软观感很差，为 1.2 MiB 不值得 |

### 5.6 明确排除的

- **UPX**：可压的只有 102 KB 宿主代码，载荷本身不可压；而且 UPX 特征容易被杀软误报。
- **Windows Compression API（XPRESS / LZMS / MSZIP）**：宿主侧解压确实不占代码字节
  （`Cabinet.dll` 是系统库），但压缩率不如 gzip，且 Node 侧没有对应压缩器，得先写一个构建期小工具。
- **压缩 scaffolding**：1.729 MiB，gzip 后 0.760 MiB，占最终 exe 的 5%。不删功能就没法再小。

---

## 6. 怎么验证「exe 真的跑起来了」

**「编译过了」和「跑起来了」是两件事**，而这个方案里最容易出问题的恰好是后者
（路径没对上、资源没解压、素材名改了但 `project.json` 没改……）。
所以宿主内置了一个自证开关：

```bash
node src/pack-exe.js project.sb3 --probe out/probe.json   # meta 里写入 probe=<绝对路径>
```

带 `probe` 时，宿主每 500 ms 通过 `ExecuteScript` 向**运行中的 VM** 问一次：

```js
JSON.stringify({
  title: document.title, vm: !!window.vm,
  targets: window.vm.runtime.targets.length,
  assets:  /* 所有 target 的 costumes + sounds 总数 */,
  canvas:  document.querySelectorAll('canvas').length,
  ms:      Math.round(performance.now()),
  error:   /* 错误面板是否可见 */
})
```

等到 `targets > 0`（**不是 `vm == true`**——VM 对象在 `loadProject()` 建 stage 之前就存在了，
早期轮询会得到 `vm:true, targets:0` 的假阳性），把结果写文件并退出。

实测输出：

```json
{"title":"Art","vm":true,"targets":101,"assets":171,"canvas":1,"ms":4492,"error":null}
```

另外做了两件事证明「零外部依赖」：

1. `dumpbin /dependents` → 只有系统 DLL。
2. **把 exe 单独复制到一个空目录里运行** → 正常退出 0，probe 结果一致。

---

## 7. 结论

1. **sb3 → exe 的正确形态是「极小的原生宿主 + 系统 WebView2」**，而不是把运行时塞进 exe。
   宿主 102 KB 代码 / 约 170 KB 总量，除了 WebView2 Runtime 不需要任何外部文件。
2. **`Content-Encoding` 在 WebView2 的 `WebResourceRequested` 响应上无效**，
   必须由页面自己 inflate。这一步不花宿主字节，但不知道就会得到一屏乱码。
3. **exe 的体积就是素材的体积。** 结构层面（容器格式、base85、压缩器）折腾一圈只有
   不到 3% 的差别；真正有量级的是把素材本身变小。
4. **PNG 无损重压在本文的工程上省了 10.9%（1.92 MiB），且像素不变**，
   是这次探索里唯一两位数百分比的收益，已默认开启。
5. **还剩 1.2 MiB 的 brotli 空间**，但需要接受一个 vendored 的 JS 解码器，
   或者引入一个本地 HTTP 服务器。两条路都记在上面了，没有偷偷藏起来。

---

*本文数字均为本机实测。未实施的方案都注明了原因与理论收益，以便后续取舍。*
