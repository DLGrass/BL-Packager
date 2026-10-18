'use strict';

// Desktop/mobile app targets: macOS .app, Linux ELF, Android .apk.
//
// Same shape as writeExeResources(): the single-file HTML is produced by the
// shared pipeline, gzipped, and laid down next to a small metadata file that the
// platform build script (hosts/<target>/build.sh) embeds. One payload format for
// three hosts, so the page a Mac, a Linux box and an Android phone run is
// byte-identical to what `src/pack.js` writes.
//
// What differs per target is only *how the payload travels*:
//
//   macOS    Contents/Resources/app.html.gz — the bundle is a directory, so the
//            payload is just a file next to the executable.
//   Linux    build/app.html.gz is turned into a .rodata blob by the build script
//            (.incbin), so the binary really is one file.
//   Android  assets/app.html.gz inside the APK — the framework reads it through
//            AssetManager.
//
// In every case the host inflates with the platform's own gzip (zlib on macOS and
// Linux, GZIPInputStream on Android), because unlike WebView2 all three can do it
// for free. That is the whole reason the Windows host needs a JavaScript
// bootstrap and these three do not (README 6.2).

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {spawnSync} = require('node:child_process');

const {
  packToHtml, defaultTitle, human, WINDOW_MODES, MAX_IMAGE_BYTES
} = require('./pipeline');
const {sniffImage, parseDataUri} = require('./datauri');

const ROOT = path.join(__dirname, '..', '..');
const HOSTS_DIR = path.join(ROOT, 'hosts');
const TARGETS = ['macos', 'linux', 'android'];

/**
 * Android's screenOrientation values. `auto` is fullSensor rather than
 * "unspecified" on purpose: unspecified lets the system pick, which on a tablet
 * means the project starts rotated for no reason the author asked for.
 */
const ORIENTATIONS = {
  auto: 'fullSensor',
  landscape: 'sensorLandscape',
  portrait: 'sensorPortrait'
};

/** Files writeAppResources() owns inside a target's build directory. */
const GENERATED = [
  'app.html.gz', 'app.meta', 'app.png', 'Info.plist', 'AndroidManifest.xml',
  'bl-player.desktop', 'res', 'assets'
];

const hostDir = (target, root = ROOT) =>
  (path.resolve(root) === path.resolve(ROOT)
    ? path.join(HOSTS_DIR, target)
    : path.join(root, 'hosts', target));

const buildDirFor = (target, root = ROOT) => path.join(hostDir(target, root), 'build');

/** `My Game (2)` -> `my-game-2`; only for ids, which must be ASCII. */
const slug = (text, fallback = 'packaged-project') => {
  const out = String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || fallback;
};

/**
 * A file name for the bundle/artifact.
 *
 * Unlike the Windows target there is no reason to throw non-ASCII away here:
 * `测试游戏.app` is a perfectly good bundle name on macOS and Linux, and Finder
 * shows the file name rather than CFBundleDisplayName. Only characters that are
 * illegal in *any* of the three file systems are replaced.
 */
const safeName = (text) => {
  const out = String(text == null ? '' : text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60);
  return out || 'bl-app';
};

/**
 * A reverse-DNS id that is legal both as a CFBundleIdentifier and as an Android
 * application id. The two grammars disagree about hyphens (Android forbids them)
 * and about digits starting a segment (both forbid it), so the segments are
 * normalized rather than validated-and-rejected: `My Game!` should not require
 * the user to know the rule.
 */
const bundleId = (id, title) => {
  const raw = String(id == null ? '' : id).trim() || `dev.bilup.${slug(title, 'project')}`;
  const parts = raw.split('.').map((part) => {
    const cleaned = part.replace(/[^A-Za-z0-9_]/g, '_');
    return /^[A-Za-z]/.test(cleaned) ? cleaned : `a${cleaned}`;
  });
  // A single segment is not a bundle id anywhere; the CFBundleIdentifier needs a
  // dot and so does Android's applicationId.
  if (parts.length < 2) parts.unshift('dev');
  const joined = parts.join('.');
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(joined)) {
    throw new Error(`cannot turn "${raw}" into a bundle id / package name; ` +
      'pass --id with something like com.example.my-game');
  }
  return joined;
};

/** `1.2.3` -> 10203; Android refuses a non-numeric versionCode. */
const versionCode = (version) => {
  const parts = String(version || '1.0.0').split('.').map((part) => parseInt(part, 10));
  const [major = 0, minor = 0, patch = 0, build = 0] = parts.map((n) =>
    (Number.isFinite(n) && n > 0 ? Math.min(n, 999) : 0));
  return Math.max(1, major * 1000000 + minor * 1000 + patch + build);
};

const escapeXml = (text) => String(text == null ? '' : text)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

/**
 * aapt2 rejects an apostrophe in a <string> unless it is escaped, and a leading
 * `@`/`?` is read as a resource reference. Both are silent failure modes at
 * *runtime* if you are unlucky enough for them to pass the build, so they are
 * handled here rather than discovered on a phone.
 */
const androidString = (text) => {
  let out = String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"');
  if (/^[@?]/.test(out)) out = `\\${out}`;
  return out;
};

/** A .desktop file is a line-based INI without escaping; newlines must not pass. */
const desktopValue = (text) => String(text == null ? '' : text).replace(/[\r\n]+/g, ' ');

/** Same contract as the exe's app.meta: one `key=value` per line, UTF-8. */
const metaValue = (value) => String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();

/**
 * The icon for these three targets is a PNG. Windows wants an .ico container
 * because rc.exe's ICON statement is literal; macOS wants an .icns (which the
 * build script derives from the PNG with sips/iconutil), Linux and Android take
 * a PNG as-is. Refusing the wrong container here is the difference between a
 * clear message and a `RC FAILED` / `aapt2 error` later.
 */
const resolveAppIcon = (value) => {
  if (!value) return null;
  const text = String(value);
  let bytes;
  let source;
  if (/^data:/i.test(text)) {
    const parsed = parseDataUri(text);
    if (!parsed) throw new Error('icon is not a valid data: URL');
    bytes = parsed.bytes;
    source = 'app.png';
  } else {
    const absolute = path.resolve(text);
    source = path.basename(absolute);
    bytes = fs.readFileSync(absolute);
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`icon ${source} is ${human(bytes.length)}; the limit is ${human(MAX_IMAGE_BYTES)}`);
  }
  const kind = sniffImage(bytes);
  if (kind !== 'png') {
    throw new Error(`icon ${source} is ${kind || 'not recognisable as an image'}; ` +
      'macOS / Linux / Android targets need a .png ' +
      '(the Windows .exe target is the one that wants .ico)');
  }
  return {name: 'app.png', source, bytes};
};

const normalizeTargets = (value) => {
  const list = Array.isArray(value) ? value : String(value == null ? 'macos' : value).split(',');
  const out = [];
  for (const entry of list) {
    const target = String(entry).trim().toLowerCase();
    if (!target) continue;
    if (target === 'all') {
      // `all` renders once and writes three directories, which is what makes
      // "one sb3 -> every desktop" cost one PNG recompression instead of three.
      for (const name of TARGETS) if (!out.includes(name)) out.push(name);
      continue;
    }
    if (!TARGETS.includes(target)) {
      throw new Error(`unknown target ${target} (macos | linux | android | all)`);
    }
    if (!out.includes(target)) out.push(target);
  }
  if (out.length === 0) throw new Error('no target given (macos | linux | android | all)');
  return out;
};

// ------------------------------------------------------------------ writers

const writeMacPlist = (dir, info) => {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>CFBundleDevelopmentRegion</key>',
    '  <string>en</string>',
    '  <key>CFBundleDisplayName</key>',
    `  <string>${escapeXml(info.title)}</string>`,
    '  <key>CFBundleExecutable</key>',
    `  <string>${escapeXml(info.name)}</string>`,
    // CFBundleName is the short one (menu bar, <= 15 chars is the convention);
    // CFBundleDisplayName is what Finder shows and may be anything, including
    // Chinese — a plist is UTF-8 XML, unlike the exe's app.rc.
    '  <key>CFBundleName</key>',
    `  <string>${escapeXml(info.name)}</string>`,
    '  <key>CFBundleIdentifier</key>',
    `  <string>${escapeXml(info.id)}</string>`,
    '  <key>CFBundleInfoDictionaryVersion</key>',
    '  <string>6.0</string>',
    '  <key>CFBundlePackageType</key>',
    '  <string>APPL</string>',
    '  <key>CFBundleShortVersionString</key>',
    `  <string>${escapeXml(info.version)}</string>`,
    '  <key>CFBundleVersion</key>',
    `  <string>${escapeXml(info.version)}</string>`
  ];
  if (info.icon) {
    lines.push('  <key>CFBundleIconFile</key>', '  <string>AppIcon</string>');
  }
  lines.push(
    '  <key>LSMinimumSystemVersion</key>',
    '  <string>11.0</string>',
    '  <key>LSApplicationCategoryType</key>',
    '  <string>public.app-category.games</string>',
    '  <key>NSHighResolutionCapable</key>',
    '  <true/>',
    '  <key>NSSupportsAutomaticGraphicsSwitching</key>',
    '  <true/>',
    // The host serves the payload from http://127.0.0.1. ATS exempts loopback in
    // practice, but "in practice" is not something to ship on: this key is the
    // documented way to say so, and it does not weaken anything else.
    '  <key>NSAppTransportSecurity</key>',
    '  <dict>',
    '    <key>NSAllowsLocalNetworking</key>',
    '    <true/>',
    '  </dict>',
    '  <key>NSHumanReadableCopyright</key>',
    '  <string>Packaged with BL-Packager</string>',
    '</dict>',
    '</plist>',
    ''
  );
  const file = path.join(dir, 'Info.plist');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
};

const writeAndroidManifest = (dir, info) => {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- Generated by src/pack-app.js; edit the generator, not this file. -->',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"',
    `    package="${info.id}"`,
    `    android:versionCode="${versionCode(info.version)}"`,
    `    android:versionName="${escapeXml(info.version)}">`,
    // The payload is served by an in-process loopback server, so this is the only
    // permission needed. No storage, no location, nothing the WebView can abuse.
    '  <uses-permission android:name="android.permission.INTERNET"/>',
    '  <application',
    '      android:label="@string/app_name"',
    ...(info.icon ? ['      android:icon="@mipmap/ic_launcher"'] : []),
    '      android:allowBackup="false"',
    '      android:hardwareAccelerated="true"',
    // http://127.0.0.1 counts as cleartext, and API 28+ blocks cleartext by
    // default; without this the WebView shows ERR_CLEARTEXT_NOT_PERMITTED.
    '      android:usesCleartextTraffic="true"',
    '      android:theme="@android:style/Theme.Material.NoActionBar.Fullscreen">',
    // Fully qualified because the host class lives in a fixed package
    // (dev.bilup.player) while the application id is per-project.
    '    <activity android:name="dev.bilup.player.MainActivity"',
    '        android:exported="true"',
    `        android:screenOrientation="${info.orientation}"`,
    '        android:configChanges="orientation|keyboardHidden|screenSize|screenLayout|smallestScreenSize|keyboard|density|uiMode">',
    '      <intent-filter>',
    '        <action android:name="android.intent.action.MAIN"/>',
    '        <category android:name="android.intent.category.LAUNCHER"/>',
    '      </intent-filter>',
    '    </activity>',
    '  </application>',
    '</manifest>',
    ''
  ];
  const file = path.join(dir, 'AndroidManifest.xml');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
};

const writeAndroidResources = (dir, info) => {
  const values = path.join(dir, 'res', 'values');
  fs.mkdirSync(values, {recursive: true});
  fs.writeFileSync(path.join(values, 'strings.xml'), [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<resources>',
    `  <string name="app_name">${androidString(info.title)}</string>`,
    '</resources>',
    ''
  ].join('\n'), 'utf8');

  if (info.icon) {
    // A single density-independent slot is enough: Android scales it. Putting
    // the same bytes in five mipmap dirs would only cost APK size.
    const mipmap = path.join(dir, 'res', 'mipmap');
    fs.mkdirSync(mipmap, {recursive: true});
    fs.writeFileSync(path.join(mipmap, 'ic_launcher.png'), info.icon.bytes);
  }
};

const writeLinuxDesktop = (dir, info) => {
  const file = path.join(dir, 'bl-player.desktop');
  fs.writeFileSync(file, [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${desktopValue(info.title)}`,
    'Comment=Packaged with BL-Packager',
    // build.sh always names the executable bl-player, so Exec stays constant even
    // when the bundle name is a Chinese title. The icon name is the application
    // id, which is what an install puts under share/icons/hicolor.
    'Exec=bl-player',
    `Icon=${info.id}`,
    'Terminal=false',
    'Categories=Game;Education;',
    'StartupWMClass=bl-player',
    ''
  ].join('\n'), 'utf8');
  return file;
};

// ------------------------------------------------------------------ pipeline

/**
 * Render once, then write one build directory per target.
 *
 * @param {Buffer|Uint8Array} input raw sb3
 * @param {object} options target (name or 'all'/'comma,list'), plus everything
 *        packToHtml() takes, plus title/id/version/name/width/height/windowMode/
 *        devtools/probe/gzip/gzipLevel/icon/orientation
 * @returns {{htmlBytes: Buffer, payload: Buffer, gzipped: Buffer|null,
 *            icon: object|null, metaLines: string[], title: string, name: string,
 *            id: string, version: string,
 *            targets: Object<string, {dir: string, paths: object}>}}
 */
const writeAppResources = (input, options = {}) => {
  const {
    target = 'macos',
    inputPath = '',
    title,
    name,
    id,
    version = '1.0.0',
    width = 640,
    height = 480,
    windowMode = 'window',
    orientation = 'landscape',
    devtools = true,
    probe = null,
    gzip = true,
    gzipLevel = 9,
    icon = null,
    preload = false,
    noDeflate = false,
    optimizePng = true,
    root = ROOT
  } = options;

  const targets = normalizeTargets(target);
  if (!WINDOW_MODES.includes(windowMode)) {
    throw new Error(`unknown window mode ${windowMode} (window | maximize | fullscreen)`);
  }
  if (!Object.prototype.hasOwnProperty.call(ORIENTATIONS, orientation)) {
    throw new Error(`unknown orientation ${orientation} (auto | landscape | portrait)`);
  }

  const resolvedTitle = title || defaultTitle(inputPath);
  const resolvedName = safeName(name || resolvedTitle);
  const resolvedId = bundleId(id, resolvedTitle);

  const pack = packToHtml(input, Object.assign({
    mode: 'fast',
    inputPath,
    title: resolvedTitle,
    preload,
    noDeflate,
    optimizePng,
    root
  }, options));

  const htmlBytes = Buffer.from(pack.html);
  const gzipped = gzip ? zlib.gzipSync(htmlBytes, {level: gzipLevel}) : null;
  const payload = gzipped || htmlBytes;

  const metaLines = [
    `target=${targets.join(',')}`,
    `name=${metaValue(resolvedName)}`,
    `id=${metaValue(resolvedId)}`,
    `version=${metaValue(version)}`,
    `title=${metaValue(resolvedTitle)}`,
    `width=${width}`,
    `height=${height}`,
    `gzip=${gzipped ? 1 : 0}`,
    `devtools=${devtools ? 1 : 0}`
  ];
  // Only non-defaults, so a rebuilt payload keeps the exact bytes of a previous
  // one whenever the option did not change (same rule as app.meta for the exe).
  if (windowMode !== 'window') metaLines.push(`window=${windowMode}`);
  if (orientation !== 'landscape') metaLines.push(`orientation=${orientation}`);
  if (probe) metaLines.push(`probe=${path.resolve(probe)}`);
  const meta = metaLines.join('\n') + '\n';

  const info = {
    title: resolvedTitle,
    name: resolvedName,
    id: resolvedId,
    version: String(version),
    orientation: ORIENTATIONS[orientation],
    icon: icon || null
  };

  const written = {};
  for (const one of targets) {
    const dir = buildDirFor(one, root);
    fs.mkdirSync(dir, {recursive: true});
    for (const stale of GENERATED) {
      fs.rmSync(path.join(dir, stale), {recursive: true, force: true});
    }

    const paths = {
      html: path.join(dir, 'app.html.gz'),
      meta: path.join(dir, 'app.meta'),
      icon: null
    };
    fs.writeFileSync(paths.html, payload);
    fs.writeFileSync(paths.meta, meta, 'utf8');
    if (info.icon) {
      paths.icon = path.join(dir, 'app.png');
      fs.writeFileSync(paths.icon, info.icon.bytes);
    }

    if (one === 'macos') {
      paths.plist = writeMacPlist(dir, info);
    } else if (one === 'linux') {
      paths.desktop = writeLinuxDesktop(dir, info);
    } else {
      paths.manifest = writeAndroidManifest(dir, info);
      writeAndroidResources(dir, info);
      // The APK's assets are what AssetManager.open() sees at runtime.
      paths.assets = path.join(dir, 'assets');
      fs.mkdirSync(paths.assets, {recursive: true});
      fs.writeFileSync(path.join(paths.assets, 'app.html.gz'), payload);
      fs.writeFileSync(path.join(paths.assets, 'app.meta'), meta, 'utf8');
    }

    written[one] = {dir, paths};
  }

  return {
    pack, htmlBytes, payload, gzipped, icon: icon || null,
    metaLines, title: resolvedTitle, name: resolvedName, id: resolvedId,
    version: String(version), targets: written
  };
};

/**
 * Run a target's build.sh. Never throws: no toolchain is a reportable state, and
 * the resources written above are useful without one (they are what CI builds
 * from). The scripts print `ARTIFACT <absolute path>` for every final file, which
 * is the only contract between them and this side.
 */
const buildApp = (options = {}) => {
  const {target, root = ROOT, env = {}, timeout = 900000} = options;
  if (!TARGETS.includes(target)) throw new Error(`unknown target ${target}`);
  const dir = hostDir(target, root);
  const script = path.join(dir, 'build.sh');
  if (!fs.existsSync(script)) {
    return {ok: false, status: null, stdout: '', stderr: '', artifacts: [],
      reason: `${script} not found`};
  }
  const result = spawnSync('bash', [script], {
    cwd: dir,
    encoding: 'utf8',
    timeout,
    env: Object.assign({}, process.env, env)
  });
  const artifacts = [];
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const match = /^ARTIFACT (.+)$/.exec(line.trim());
    if (match) artifacts.push(match[1].trim());
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    artifacts,
    reason: result.error ? result.error.message : null
  };
};

module.exports = {
  ROOT,
  HOSTS_DIR,
  TARGETS,
  ORIENTATIONS,
  hostDir,
  buildDirFor,
  slug,
  safeName,
  bundleId,
  versionCode,
  escapeXml,
  androidString,
  resolveAppIcon,
  normalizeTargets,
  writeAppResources,
  buildApp
};
