'use strict';

// Verification suite. Runs entirely in Node and covers every piece of logic that
// also runs inside the browser, including the pure-JS inflate fallback (checked
// against zlib) and the loader's asset-resolution path (driven with a stub
// storage/vm so no browser is needed).

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const {crc32} = require('../src/lib/crc32');
const {readZip, writeZip} = require('../src/lib/zip');
const {encodeChunk, decodeInto, decoderSource} = require('../src/lib/base85');
const {loadSb3} = require('../src/lib/sb3');
const {recompressPng, readChunks, unfilter} = require('../src/lib/png');
const {buildContainer, parseContainer, basename} = require('../src/lib/container');
const {inflateRawJS} = require('../src/runtime/inflate-raw');
const {openBlpk} = require('../src/runtime/container-reader');
const {createProjectSource, createInflateRaw} = require('../src/runtime/loader');
const {checkMessage, subjectOf, TYPES} = require('../.githooks/conventional');
const {
  deflateRaw, deflateZlib, adler32, LEN_BASE, LEN_EXTRA, DIST_BASE, DIST_EXTRA
} = require('../src/lib/deflate');
const {Buffer: ShimBuffer} = require('../src/lib/bytes');
const {createHash: md5CreateHash} = require('../src/lib/md5');
const {imageDataUri, sniffImage, parseDataUri, normalizeImageDataUri, isIconDataUri} =
  require('../src/lib/datauri');
const {bakeExtensions, applyBakedExtensions, encodeExtension, wrapExtensionSource} =
  require('../src/lib/extensions');

const ROOT = path.join(__dirname, '..');
const REF = path.join(ROOT, '..', '_ref', 'turbowarp-packager');

let passed = 0;
let failed = 0;

const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  }
};

const section = (name) => console.log(`\n${name}`);

const randomBytes = (n) => crypto.randomBytes(n);
const md5 = (bytes) => crypto.createHash('md5').update(bytes).digest('hex');
const exact = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);

const main = async () => {
  // -------------------------------------------------------------------------
  section('[crc32]');
  // -------------------------------------------------------------------------
  await test('crc32 matches the standard vector and zlib', () => {
    assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
    if (typeof zlib.crc32 === 'function') {
      for (const n of [0, 1, 15, 1024, 70000]) {
        const data = randomBytes(n);
        assert.strictEqual(crc32(data), zlib.crc32(data) >>> 0, `length ${n}`);
      }
    }
  });

  // -------------------------------------------------------------------------
  section('[zip]');
  // -------------------------------------------------------------------------
  await test('writeZip -> readZip round trip', () => {
    const entries = [
      {name: 'project.json', data: Buffer.from(JSON.stringify({hello: 'world', n: 1}))},
      {name: `${md5('a')}.svg`, data: Buffer.from('<svg>'.repeat(500))},
      {name: `${md5('b')}.bin`, data: randomBytes(4096)}
    ];
    const read = readZip(writeZip(entries));
    assert.strictEqual(read.size, 3);
    for (const entry of entries) {
      assert.ok(read.has(entry.name), `missing ${entry.name}`);
      assert.ok(read.get(entry.name).data.equals(entry.data), `bytes differ for ${entry.name}`);
    }
  });

  await test('readZip rejects a non-zip buffer', () => {
    assert.throws(() => readZip(Buffer.from('definitely not a zip file')), /end of central directory/);
  });

  // -------------------------------------------------------------------------
  section('[base85]');
  // -------------------------------------------------------------------------
  await test('round trips for arbitrary lengths and stays HTML-escape-free', () => {
    for (const n of [1, 2, 3, 4, 5, 7, 8, 255, 4096, 65536, 70001]) {
      const data = randomBytes(n);
      const encoded = encodeChunk(data);
      assert.strictEqual(encoded.length, Math.ceil(n / 4) * 5, `encoded length for ${n}`);
      assert.ok(!/[<>"'&]/.test(encoded), `unsafe character in output for ${n}`);
      const out = new Uint8Array(Math.ceil(n / 4) * 4);
      decodeInto(encoded, out, 0);
      assert.ok(Buffer.from(out.subarray(0, n)).equals(data), `round trip failed for ${n}`);
    }
  });

  // -------------------------------------------------------------------------
  section('[inflate-raw: pure JS vs zlib]');
  // -------------------------------------------------------------------------
  await test('reproduces zlib for every level and payload shape', () => {
    const payloads = [
      Buffer.alloc(0),
      Buffer.from([0]),
      randomBytes(1),
      randomBytes(63),
      randomBytes(64),
      randomBytes(65535),
      randomBytes(200000),
      Buffer.from('the quick brown fox '.repeat(20000)),
      Buffer.alloc(1000, 0)
    ];
    for (const payload of payloads) {
      for (const level of [0, 1, 6, 9]) {
        const deflated = zlib.deflateRawSync(payload, {level});
        const inflated = inflateRawJS(deflated, payload.length);
        assert.strictEqual(inflated.length, payload.length,
          `length mismatch for ${payload.length} bytes at level ${level}`);
        assert.ok(Buffer.from(inflated).equals(payload),
          `bytes mismatch for ${payload.length} bytes at level ${level}`);
      }
    }
  });

  await test('rejects a corrupt stream instead of returning garbage', () => {
    const payload = Buffer.from('hello world '.repeat(200));
    const deflated = zlib.deflateRawSync(payload);
    deflated[deflated.length - 1] ^= 0xff;
    assert.throws(() => inflateRawJS(deflated, payload.length));
  });

  // -------------------------------------------------------------------------
  section('[runtime source guard]');
  // -------------------------------------------------------------------------
  await test('runtime files can be inlined without closing the script tag early', () => {
    for (const file of ['inflate-raw.js', 'container-reader.js', 'loader.js']) {
      const source = fs.readFileSync(path.join(ROOT, 'src', 'runtime', file), 'utf8');
      assert.ok(!source.includes('</script>'), `${file} contains a literal </script>`);
    }
    assert.ok(!decoderSource().includes('</script>'));
  });

  // -------------------------------------------------------------------------
  const exampleSb3 = path.join(REF, 'static', 'example.sb3');
  if (!fs.existsSync(exampleSb3)) {
    console.log(`\n[skipped] reference project not found at ${exampleSb3}`);
  } else {
    const input = fs.readFileSync(exampleSb3);
    const project = loadSb3(input);
    const {container, stats} = buildContainer(project);
    const containerBuffer = exact(container);

    section('[container]');
    await test('parseContainer resolves project.json byte-for-byte', () => {
      const parsed = parseContainer(container);
      assert.ok(parsed.entry(parsed.index.p).equals(project.projectJSONBytes));
    });

    await test('parseContainer resolves every asset byte-for-byte, keyed by md5ext', () => {
      const parsed = parseContainer(container);
      for (const [name, original] of project.assets) {
        const record = parsed.index.a[basename(name)];
        assert.ok(record, `missing asset ${name}`);
        assert.ok(parsed.entry(record).equals(original), `asset bytes differ for ${name}`);
      }
    });

    await test('openBlpk works with the native inflate path', async () => {
      const opened = await openBlpk(containerBuffer, createInflateRaw(), {length: container.length});
      assert.ok(Buffer.from(await opened.getProject()).equals(project.projectJSONBytes));
      for (const [name, original] of project.assets) {
        const bytes = await opened.getAsset(basename(name));
        assert.ok(bytes && Buffer.from(bytes).equals(original), `native path failed for ${name}`);
      }
    });

    await test('openBlpk works with the pure-JS inflate fallback', async () => {
      const opened = await openBlpk(containerBuffer, (bytes) => inflateRawJS(bytes), {length: container.length});
      for (const [name, original] of project.assets) {
        const bytes = await opened.getAsset(basename(name));
        assert.ok(bytes && Buffer.from(bytes).equals(original), `js fallback failed for ${name}`);
      }
    });

    await test('warmUp decodes deflated payloads and results are reused', async () => {
      const opened = await openBlpk(containerBuffer, createInflateRaw(), {length: container.length});
      assert.ok(opened.deflatedAssetNames.length > 0, 'fixture should have deflated entries');
      await opened.warmUp();
      const before = opened.stats();
      for (const name of opened.assetNames) await opened.getAsset(name);
      assert.deepStrictEqual(opened.stats(), before, 'warm-up results were not reused');
      assert.strictEqual(before.cachedAssets, opened.assetNames.length);
    });

    // -----------------------------------------------------------------------
    section('[loader: driven from Node with a stub scaffolding]');
    // -----------------------------------------------------------------------
    const makeStub = () => {
      const stored = new Map();
      const raw = new Map();
      const storage = {
        addHelper: (helper) => { storage.helper = helper; },
        createAsset: (assetType, dataFormat, data, assetId) => {
          const key = `${assetId}.${dataFormat}`;
          // Record the value as handed over, before Buffer.from copies it, so
          // tests can assert on buffer identity (aliasing vs ownership).
          raw.set(key, data);
          stored.set(key, Buffer.from(data));
          return {assetType, dataFormat, assetId};
        }
      };
      return {storage, vm: {runtime: {on: () => {}}}, stored, raw};
    };

    const makeTakePayload = () => {
      let used = false;
      return () => {
        if (used) throw new Error('takePayload called twice');
        used = true;
        return {buffer: containerBuffer, length: container.length};
      };
    };

    const loadAsset = (stub, key) => {
      const dot = key.lastIndexOf('.');
      return stub.storage.helper.load('ImageVector', key.slice(0, dot), key.slice(dot + 1));
    };

    await test('fast loader serves project.json and every asset through addHelper', async () => {
      const stub = makeStub();
      const source = createProjectSource({
        mode: 'fast', storage: stub.storage, vm: stub.vm, takePayload: makeTakePayload()
      });
      assert.ok(Buffer.from(await source.getProjectData()).equals(project.projectJSONBytes));
      for (const [name, original] of project.assets) {
        const key = basename(name);
        await loadAsset(stub, key);
        assert.ok(stub.stored.get(key).equals(original), `asset ${key} differs`);
      }
      assert.strictEqual(source.assetLoads(), project.assets.size);
    });

    await test('fast loader returns null instead of throwing for an unknown asset', async () => {
      const stub = makeStub();
      createProjectSource({
        mode: 'fast', storage: stub.storage, vm: stub.vm, takePayload: makeTakePayload()
      });
      assert.strictEqual(await stub.storage.helper.load('ImageVector', '0'.repeat(32), 'png'), null);
    });

    // A container with one guaranteed-raw entry (incompressible random bytes)
    // and one guaranteed-deflated entry (highly repetitive markup), so the
    // ownership tests do not depend on the fixture's compression profile.
    const makeMixedContainer = () => {
      const stored = randomBytes(4096);
      const deflated = Buffer.from('<svg>' + 'x'.repeat(20000) + '</svg>');
      const built = buildContainer({
        projectJSONBytes: Buffer.from(JSON.stringify({v: 1, targets: []})),
        assets: new Map([
          [`${md5(stored)}.png`, stored],
          [`${md5(deflated)}.svg`, deflated]
        ])
      });
      const parsed = parseContainer(built.container);
      const storedKey = `${md5(stored)}.png`;
      const deflatedKey = `${md5(deflated)}.svg`;
      assert.strictEqual(parsed.index.a[storedKey][2], 0, 'random bytes should be stored raw');
      assert.strictEqual(parsed.index.a[deflatedKey][2], 1, 'repetitive markup should be deflated');
      return {buffer: exact(built.container), stored, deflated, storedKey, deflatedKey};
    };

    await test('openBlpk copies stored entries by default and views only on request', async () => {
      const mixed = makeMixedContainer();

      const copied = await openBlpk(mixed.buffer, createInflateRaw(), {length: mixed.buffer.byteLength});
      assert.strictEqual(copied.copyStored, true, 'copyStored should default to true');
      const copy = await copied.getAsset(mixed.storedKey);
      assert.ok(Buffer.from(copy).equals(mixed.stored), 'copied bytes must match');
      assert.notStrictEqual(copy.buffer, mixed.buffer, 'default must not alias the container');
      assert.strictEqual(copy.byteOffset, 0, 'a copy starts at offset 0');
      assert.strictEqual(copy.buffer.byteLength, copy.byteLength, 'copy buffer must be exactly the entry size');

      // A deflated entry is freshly allocated by the inflater either way.
      const inflated = await copied.getAsset(mixed.deflatedKey);
      assert.ok(Buffer.from(inflated).equals(mixed.deflated), 'inflated bytes must match');
      assert.notStrictEqual(inflated.buffer, mixed.buffer);

      const viewed = await openBlpk(mixed.buffer, createInflateRaw(), {
        length: mixed.buffer.byteLength, copyStored: false
      });
      const alias = await viewed.getAsset(mixed.storedKey);
      assert.strictEqual(alias.buffer, mixed.buffer, 'view mode is expected to alias the container');
      assert.ok(Buffer.from(alias).equals(mixed.stored), 'view bytes must still match');
    });

    await test('fast loader hands the VM owned, exactly-sized asset buffers by default', async () => {
      const mixed = makeMixedContainer();
      const stub = makeStub();
      const source = createProjectSource({
        mode: 'fast', storage: stub.storage, vm: stub.vm,
        takePayload: () => ({buffer: mixed.buffer, length: mixed.buffer.byteLength})
      });
      assert.ok(Buffer.from(await source.getProjectData()).length > 0);
      assert.strictEqual(source.stats().copyAssets, true, 'copying should be the default');

      await loadAsset(stub, mixed.storedKey);
      const storedBytes = stub.raw.get(mixed.storedKey);
      assert.ok(Buffer.from(storedBytes).equals(mixed.stored), 'asset bytes differ');
      assert.notStrictEqual(storedBytes.buffer, mixed.buffer, 'stored asset must not alias the container');
      assert.strictEqual(storedBytes.buffer.byteLength, storedBytes.byteLength,
        'buffer must be exactly the entry size, not the whole container');

      await loadAsset(stub, mixed.deflatedKey);
      assert.ok(Buffer.from(stub.raw.get(mixed.deflatedKey)).equals(mixed.deflated), 'deflated asset differs');
    });

    await test('--view-assets opts back into aliasing the decoded container', async () => {
      const mixed = makeMixedContainer();
      const stub = makeStub();
      createProjectSource({
        mode: 'fast', storage: stub.storage, vm: stub.vm,
        takePayload: () => ({buffer: mixed.buffer, length: mixed.buffer.byteLength}),
        copyAssets: false
      });
      await loadAsset(stub, mixed.storedKey);
      const bytes = stub.raw.get(mixed.storedKey);
      assert.ok(bytes, 'expected the stored asset to load');
      assert.strictEqual(bytes.buffer, mixed.buffer,
        'view mode is the regression case: bytes alias the whole container');
    });

    await test('preload warm-up resolves and leaves every asset cached', async () => {
      const stub = makeStub();
      const source = createProjectSource({
        mode: 'fast', storage: stub.storage, vm: stub.vm,
        takePayload: makeTakePayload(), preload: true
      });
      await source.getProjectData();
      await source.warmUp();
      assert.strictEqual(source.stats().cachedAssets, project.assets.size);
    });

    await test('loader reproduces real projects byte-for-byte', async () => {
      const projectsDir = path.join(REF, 'test', 'packager', 'projects');
      const files = fs.readdirSync(projectsDir).filter((f) => f.endsWith('.sb3'));
      assert.ok(files.length > 0, 'no fixtures found');
      for (const file of files) {
        const loaded = loadSb3(fs.readFileSync(path.join(projectsDir, file)));
        const built = buildContainer(loaded);
        const buffer = exact(built.container);
        const stub = makeStub();
        const source = createProjectSource({
          mode: 'fast', storage: stub.storage, vm: stub.vm,
          takePayload: () => ({buffer, length: built.container.length})
        });
        const projectBytes = Buffer.from(await source.getProjectData());
        assert.ok(projectBytes.equals(loaded.projectJSONBytes), `${file}: project.json differs`);
        for (const [name, original] of loaded.assets) {
          const key = basename(name);
          await loadAsset(stub, key);
          assert.ok(stub.stored.get(key).equals(original), `${file}: asset ${key} differs`);
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  section('[png: lossless re-compression]');
  // -------------------------------------------------------------------------

  const pngChunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
    return Buffer.concat([head, data, crc]);
  };

  // A canvas-like bitmap: smooth vertical gradient with a couple of flat shapes.
  const canvasRows = (width, height) => {
    const rows = [];
    for (let y = 0; y < height; y++) {
      const row = Buffer.alloc(width * 4);
      for (let x = 0; x < width; x++) {
        const i = x * 4;
        const inDisc = (x - width * 0.7) ** 2 + (y - height * 0.25) ** 2 < (width / 8) ** 2;
        const inBox = x > width * 0.1 && x < width * 0.45 && y > height * 0.55;
        if (inDisc) { row[i] = 255; row[i + 1] = 238; row[i + 2] = 120; }
        else if (inBox) { row[i] = 90; row[i + 1] = 160; row[i + 2] = 235; }
        else {
          row[i] = 60 + Math.round((y * 200) / height);
          row[i + 1] = 120 + Math.round((y * 100) / height);
          row[i + 2] = 200 - Math.round((y * 60) / height);
        }
        row[i + 3] = 255;
      }
      rows.push(row);
    }
    return rows;
  };

  const encodePng = (width, height, rows, {filter = 0, level = 6, interlace = 0} = {}) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // truecolour + alpha
    ihdr[12] = interlace;
    const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([filter]), r])));
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlib.deflateSync(raw, {level})),
      pngChunk('IEND', Buffer.alloc(0))
    ]);
  };

  const pngScanlines = (png, width, height) => {
    const chunks = readChunks(png);
    assert.ok(chunks, 'not a PNG');
    const idat = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data);
    assert.ok(idat.length, 'no IDAT');
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const rows = unfilter(raw, width * 4, 4, height);
    assert.ok(rows, 'unfilter failed');
    return rows;
  };

  const W = 96;
  const H = 72;
  const canvasRowsData = canvasRows(W, H);

  await test('recompressPng shrinks a canvas-style PNG and keeps every pixel', () => {
    // filter 0 on every row at level 6 is what canvas.toDataURL tends to emit.
    const original = encodePng(W, H, canvasRowsData, {filter: 0, level: 6});
    const smaller = recompressPng(original);
    assert.ok(smaller, 'expected a smaller encoding');
    assert.ok(smaller.length < original.length,
      `expected a shrink, got ${original.length} -> ${smaller.length}`);

    const before = pngScanlines(original, W, H);
    const after = pngScanlines(smaller, W, H);
    assert.strictEqual(after.length, before.length);
    for (let y = 0; y < before.length; y++) {
      assert.ok(after[y].equals(before[y]), `scanline ${y} differs`);
    }
  });

  await test('recompressPng output has valid chunk CRCs', () => {
    const original = encodePng(W, H, canvasRowsData, {filter: 0, level: 6});
    const smaller = recompressPng(original);
    for (const chunk of readChunks(smaller)) {
      const body = Buffer.concat([Buffer.from(chunk.type, 'latin1'), chunk.data]);
      assert.strictEqual(chunk.raw.readUInt32BE(chunk.raw.length - 4), crc32(body),
        `${chunk.type} CRC is wrong`);
    }
    assert.strictEqual(readChunks(smaller).filter((c) => c.type === 'IDAT').length, 1);
  });

  await test('recompressPng declines when there is nothing to win', () => {
    // Already adaptively filtered at level 9: re-compressing must not lose.
    const rows = canvasRowsData;
    const prevFree = encodePng(W, H, rows, {filter: 0, level: 9});
    const once = recompressPng(prevFree);
    assert.ok(once, 'first pass should win');
    assert.strictEqual(recompressPng(once), null, 'second pass should decline');
  });

  await test('recompressPng refuses anything it cannot prove safe', () => {
    assert.strictEqual(recompressPng(Buffer.from('not a png at all')), null);
    assert.strictEqual(recompressPng(Buffer.alloc(0)), null);
    // Interlaced (Adam7): re-interleaving is not supported, so decline.
    const interlaced = encodePng(W, H, canvasRowsData, {filter: 0, level: 6, interlace: 1});
    assert.strictEqual(recompressPng(interlaced), null);
    // Truncated file: the chunk walker must not read past the end.
    const truncated = encodePng(W, H, canvasRowsData).subarray(0, 40);
    assert.strictEqual(recompressPng(truncated), null);
    // Valid IHDR but a corrupt IDAT stream.
    const broken = Buffer.concat([
      encodePng(W, H, canvasRowsData).subarray(0, 33),
      pngChunk('IDAT', Buffer.from('not deflate data')),
      pngChunk('IEND', Buffer.alloc(0))
    ]);
    assert.strictEqual(recompressPng(broken), null);
  });

  await test('loadSb3 renames a recompressed asset so md5ext stays truthful', () => {
    const original = encodePng(W, H, canvasRowsData, {filter: 0, level: 6});
    const oldMd5 = md5(original);
    const projectData = {
      targets: [
        {
          isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {},
          blocks: {}, comments: {}, costumes: [], sounds: [], volume: 100,
          layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'off'
        },
        {
          isStage: false, name: 'Sprite1', variables: {}, lists: {}, broadcasts: {},
          blocks: {}, comments: {}, volume: 100, layerOrder: 1, visible: true,
          x: 0, y: 0, size: 100, direction: 90, draggable: false,
          rotationStyle: 'all around',
          costumes: [{
            assetId: oldMd5, name: 'costume1', md5ext: `${oldMd5}.png`,
            dataFormat: 'png', rotationCenterX: 0, rotationCenterY: 0
          }],
          sounds: []
        }
      ],
      monitors: [], extensions: [], meta: {semver: '3.0.0', vm: '0.0.0'}
    };
    const sb3 = writeZip([
      {name: 'project.json', data: Buffer.from(JSON.stringify(projectData), 'utf8')},
      {name: `${oldMd5}.png`, data: original}
    ]);

    const loaded = loadSb3(sb3, {optimizePng: true});
    assert.strictEqual(loaded.analysis.png.optimized, 1, 'expected one PNG to be rewritten');
    assert.ok(loaded.analysis.png.after < loaded.analysis.png.before);

    const [key] = Array.from(loaded.assets.keys());
    const bytes = loaded.assets.get(key);
    assert.strictEqual(key, `${md5(bytes)}.png`, 'asset name must be the md5 of its contents');
    assert.notStrictEqual(key, `${oldMd5}.png`, 'the name must have changed');

    const costume = loaded.projectData.targets[1].costumes[0];
    assert.strictEqual(costume.md5ext, key, 'md5ext must follow the rename');
    assert.strictEqual(costume.assetId, key.replace(/\.png$/, ''), 'assetId must follow too');
  });

  await test('optimizePng is off by default', () => {
    const original = encodePng(W, H, canvasRowsData, {filter: 0, level: 6});
    const oldMd5 = md5(original);
    const sb3 = writeZip([
      {name: 'project.json', data: Buffer.from(JSON.stringify({
        targets: [
          {
            isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {},
            blocks: {}, comments: {}, costumes: [], sounds: [], volume: 100, layerOrder: 0
          },
          {
            isStage: false, name: 'S', variables: {}, lists: {}, broadcasts: {},
            blocks: {}, comments: {}, costumes: [{
              assetId: oldMd5, name: 'c', md5ext: `${oldMd5}.png`, dataFormat: 'png'
            }], sounds: []
          }
        ],
        monitors: [], extensions: []
      }), 'utf8')},
      {name: `${oldMd5}.png`, data: original}
    ]);
    const loaded = loadSb3(sb3);
    assert.strictEqual(loaded.analysis.png.optimized, 0);
    assert.ok(loaded.assets.has(`${oldMd5}.png`), 'asset must keep its original name');
  });

  // -------------------------------------------------------------------------
  section('[extensions: baking a source into the page]');
  // -------------------------------------------------------------------------
  // The scenario is the one that makes a packaged project fail offline: its
  // project.json points at a URL on the internet. Baking replaces that with the
  // source, wrapped the way upstream wraps it.
  {
    const SOURCE = [
      'class T { getInfo () { return {id: "blTest", name: "T", blocks: []}; } }',
      'Scratch.extensions.register(new T());'
    ].join('\n');

    /** Decode a data: URL the way a browser would and run it with a stub Scratch. */
    const runBaked = (uri) => {
      assert.match(uri, /^data:text\/javascript/, 'not a javascript data: URL');
      const comma = uri.indexOf(',');
      const meta = uri.slice(0, comma);
      const payload = uri.slice(comma + 1);
      const text = /;base64$/.test(meta)
        ? Buffer.from(payload, 'base64').toString('utf8')
        : decodeURIComponent(payload);
      const registered = [];
      const Scratch = {extensions: {register: (extension) => registered.push(extension)}};
      new Function('Scratch', text)(Scratch);
      return registered;
    };

    await test('the baked source decodes back to working JavaScript', () => {
      const registered = runBaked(encodeExtension(SOURCE));
      assert.strictEqual(registered.length, 1, 'the extension did not register');
      assert.strictEqual(registered[0].getInfo().id, 'blTest');
    });

    await test('the wrapper matches upstream, so sandbox-style sources still work', () => {
      const wrapped = wrapExtensionSource('BODY');
      assert.ok(wrapped.startsWith('(function(Scratch) {'));
      assert.ok(wrapped.endsWith('})(Scratch);'));
      // The payload must survive being dropped into an HTML attribute or a
      // <script> body: no quotes, no angle brackets, no ampersand.
      const uri = encodeExtension(SOURCE);
      assert.ok(!/[<>"']/.test(uri.replace(/^data:[^,]*,/, '')), 'unsafe character in the data URL');
    });

    await test('an id the source declares and the project needs is matched', () => {
      const project = {
        projectData: {
          extensions: ['blTest'],
          extensionURLs: {blTest: 'https://extensions.turbowarp.org/blTest.js'}
        }
      };
      const baked = bakeExtensions(project, [{name: 'whatever.js', source: SOURCE}]);
      assert.strictEqual(baked.report.length, 1);
      assert.strictEqual(baked.report[0].id, 'blTest');
      assert.strictEqual(baked.report[0].how, 'declares');
      assert.match(baked.urls.blTest, /^data:text\/javascript/);
      assert.deepStrictEqual(baked.remote, [], 'nothing should still need a network');
      // Scaffolding only loads the ids its blocks use, so an unused extension has
      // to be registered explicitly as well — see bakeExtensions().
      assert.strictEqual(baked.eager.length, 1, 'the source must also be loaded eagerly');
    });

    await test('a filename that matches the id is accepted when the source is opaque', () => {
      const project = {projectData: {extensionURLs: {myExt: 'https://x/myExt.js'}}};
      const baked = bakeExtensions(project, [{name: 'myExt.js', source: '/* no id in here */'}]);
      assert.strictEqual(baked.report[0].how, 'filename');
      assert.strictEqual(baked.report[0].id, 'myExt');
      assert.match(baked.urls.myExt, /^data:/);
    });

    await test('one opaque file and one unfilled id are paired, and only then', () => {
      const one = bakeExtensions(
        {projectData: {extensionURLs: {solo: 'https://x/solo.js'}}},
        [{name: 'mystery.js', source: '/* nothing */'}]);
      assert.strictEqual(one.report[0].how, 'only-one-left');
      assert.match(one.urls.solo, /^data:/);

      // Two candidates is ambiguous: guessing there would silently wire the wrong
      // extension into the wrong id.
      const two = bakeExtensions(
        {projectData: {extensionURLs: {a: 'https://x/a.js', b: 'https://x/b.js'}}},
        [{name: 'mystery.js', source: '/* nothing */'}]);
      assert.strictEqual(two.report[0].how, 'eager');
      assert.deepStrictEqual(two.remote.slice().sort(), ['a', 'b']);
    });

    await test('a source that matches nothing is loaded eagerly and the remote URL survives', () => {
      const warnings = [];
      const baked = bakeExtensions(
        {projectData: {extensionURLs: {aaa: 'https://x/aaa.js', bbb: 'https://x/bbb.js'}}},
        [{name: 'extra.js', source: '/* unrelated */'}],
        {onWarn: (message) => warnings.push(message)});
      assert.strictEqual(baked.report[0].how, 'eager');
      assert.strictEqual(baked.report[0].id, null);
      assert.strictEqual(baked.eager.length, 1);
      assert.strictEqual(baked.urls.aaa, 'https://x/aaa.js', 'a remote URL must not be invented over');
      assert.ok(warnings.some((w) => w.includes('needs a network')), warnings.join(' | '));
    });

    await test('an empty source is refused instead of baking a broken extension', () => {
      const warnings = [];
      const baked = bakeExtensions({projectData: {}}, [{name: 'empty.js', source: '   '}],
        {onWarn: (message) => warnings.push(message)});
      assert.strictEqual(baked.report.length, 0);
      assert.strictEqual(baked.eager.length, 0);
      assert.ok(warnings.some((w) => w.includes('no source')), warnings.join(' | '));
    });

    await test('applyBakedExtensions rewrites project.json and keeps its byte count honest', () => {
      const project = {
        projectData: {targets: [], extensions: ['blTest'], extensionURLs: {blTest: 'https://x/blTest.js'}},
        projectJSONBytes: Buffer.from('{}'),
        analysis: {projectJSONBytes: 2}
      };
      const result = applyBakedExtensions(project, [{name: 'blTest.js', source: SOURCE}]);
      const written = JSON.parse(project.projectJSONBytes.toString('utf8'));
      assert.match(written.extensionURLs.blTest, /^data:text\/javascript/);
      assert.strictEqual(project.analysis.projectJSONBytes, project.projectJSONBytes.length,
        'analysis must not describe the old byte count');
      assert.strictEqual(project.analysis.bakedExtensions.length, 1);
      assert.deepStrictEqual(project.analysis.remoteExtensions, []);
      assert.strictEqual(result.eager.length, 1);
    });

    await test('a project with no extensions is left completely alone', () => {
      const project = {projectData: {targets: []}, projectJSONBytes: Buffer.from('{"a":1}'),
        analysis: {projectJSONBytes: 7}};
      const before = project.projectJSONBytes;
      const result = applyBakedExtensions(project, []);
      assert.strictEqual(project.projectJSONBytes, before, 'project.json must not be re-serialised');
      assert.strictEqual(project.projectData.extensionURLs, undefined);
      assert.deepStrictEqual(result.report, []);
    });
  }

  // -------------------------------------------------------------------------
  section('[datauri: the two images a page can carry]');
  // -------------------------------------------------------------------------
  {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c00000000049454e44ae426082',
      'hex');
    const ico = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 4, 0, 0, 0, 22, 0, 0, 0]);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>');

    await test('images are identified by content, not by name', () => {
      assert.strictEqual(sniffImage(png), 'png');
      assert.strictEqual(sniffImage(ico), 'ico');
      assert.strictEqual(sniffImage(svg), 'svg');
      assert.strictEqual(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpeg');
      assert.strictEqual(sniffImage(Buffer.from('GIF89a-whatever')), 'gif');
      assert.strictEqual(sniffImage(Buffer.from('this is a text file')), null);
      assert.strictEqual(sniffImage(Buffer.alloc(4)), null, 'a truncated file must not be guessed');
    });

    await test('the data URL round trips and is rebuilt as base64', () => {
      const uri = imageDataUri(png, 'a.png');
      assert.match(uri, /^data:image\/png;base64,/);
      const parsed = parseDataUri(uri);
      assert.ok(parsed.bytes.equals(png));
      assert.strictEqual(parsed.mime, 'image/png');
    });

    await test('a percent-encoded payload cannot smuggle quotes into the page', () => {
      // What a hostile (or merely sloppy) front end could send.
      const hostile = `data:image/svg+xml,${encodeURIComponent('<svg onload="alert(1)"></svg>')}`;
      const normalised = normalizeImageDataUri(hostile, {name: 'cursor'});
      assert.match(normalised, /^data:image\/svg\+xml;base64,/);
      assert.ok(!/[<>"']/.test(normalised), 'the re-encoded URL must be inert inside HTML/CSS');
    });

    await test('non-images, empty values and oversized files are refused', () => {
      assert.strictEqual(normalizeImageDataUri(''), '');
      assert.strictEqual(normalizeImageDataUri(null), '');
      assert.throws(() => normalizeImageDataUri(`data:text/plain,${encodeURIComponent('hello')}`),
        /not an image/);
      assert.throws(() => imageDataUri(Buffer.from('definitely not an image'), 'logo'),
        /not an image this packager recognises/);
      assert.throws(
        () => normalizeImageDataUri(imageDataUri(png, 'big'), {maxBytes: 10, name: 'big'}),
        /limit is 10/);
    });

    await test('only a real .ico counts as an icon', () => {
      assert.strictEqual(isIconDataUri(imageDataUri(ico, 'app.ico')), true);
      assert.strictEqual(isIconDataUri(imageDataUri(png, 'app.png')), false,
        'a PNG renamed to .ico must not be accepted: rc.exe cannot compile it');
      assert.strictEqual(isIconDataUri('not a uri'), false);
    });

    await test('the exe icon accepts both a path and the data URL an export writes', () => {
      const {resolveIcon} = require('../src/lib/pipeline');
      assert.strictEqual(resolveIcon(null), null);
      const icon = resolveIcon(imageDataUri(ico, 'app.ico'));
      assert.strictEqual(icon.name, 'app.ico');
      assert.ok(icon.bytes.equals(ico));
      assert.throws(() => resolveIcon(imageDataUri(png, 'app.png')), /\.ico/);
      assert.throws(() => resolveIcon('data:text/plain,hello'), /not a valid data: URL|\.ico/);
    });
  }

  // -------------------------------------------------------------------------
  section('[html: every option reaches the page, or is refused]');
  // -------------------------------------------------------------------------
  // The UI, the two CLIs and the exe payload all funnel into renderHtml(), so an
  // option that the UI offers but the renderer ignores is a lie told to the
  // user. Each case below flips one option and asserts the exact line it is
  // supposed to turn into — the same line TurboWarp's packager.js emits.
  {
    const {renderHtml, normalizeOptions} = require('../src/lib/html');
    const {pickRenderOptions, loadOptionSet, RENDER_OPTION_KEYS} = require('../src/lib/pipeline');

    const png = encodePng(16, 16, canvasRows(16, 16), {filter: 0, level: 6});
    const pngName = `${md5(png)}.png`;
    const sb3 = writeZip([
      {
        name: 'project.json',
        data: Buffer.from(JSON.stringify({
          targets: [
            {
              isStage: true, name: 'Stage',
              variables: {'☁ score': {name: '☁ score', value: 0, isCloud: true}},
              lists: {}, broadcasts: {}, blocks: {}, comments: [], sounds: [],
              costumes: [{assetId: pngName.replace(/\.png$/, ''), name: 'backdrop1', md5ext: pngName,
                dataFormat: 'png', rotationCenterX: 0, rotationCenterY: 0}],
              volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'off'
            }
          ],
          monitors: [], extensions: [], meta: {semver: '3.0.0', vm: '0.0.0'}
        }), 'utf8')
      },
      {name: pngName, data: png}
    ]);

    const project = loadSb3(sb3, {optimizePng: false, fullRuntime: false});
    const scaffoldingSource = path.join(ROOT, 'vendor', 'scaffolding-min.js');
    // A 1x1 PNG, standing in for whatever the user picked in the file dialog.
    const IMAGE_URI = imageDataUri(png, 'test.png');
    // mode 'tw' keeps the payload the original sb3, so these assertions are about
    // the options and nothing else.
    const render = (options) => renderHtml(project, sb3,
      Object.assign({mode: 'tw', scaffoldingSource}, options)).html.toString('utf8');

    const CASES = [
      ['turbo', {turbo: true}, /vm\.setTurboMode\(true\)/],
      ['framerate', {framerate: 120}, /vm\.setFramerate\(120\)/],
      ['interpolation', {interpolation: true}, /setInterpolation\(true\)/],
      ['highQualityPen', {highQualityPen: true}, /setUseHighQualityRender\(true\)/],
      ['maxClones = Infinity', {maxClones: Infinity}, /maxClones: Infinity/],
      ['fencing off', {fencing: false}, /fencing: false/],
      ['miscLimits off', {miscLimits: false}, /miscLimits: false/],
      ['username', {username: 'bl'}, /scaffolding\.setUsername\("bl"/],
      ['resizeMode stretch', {resizeMode: 'stretch'}, /scaffolding\.resizeMode = "stretch"/],
      ['resizeMode dynamic-resize', {resizeMode: 'dynamic-resize'}, /resizeMode = "dynamic-resize"/],
      ['stage size', {stageWidth: 640, stageHeight: 480}, /scaffolding\.width = 640;/],
      ['cursor none', {cursor: 'none'}, /\.sc-canvas \{ cursor: none; \}/],
      ['accent', {accent: '#123456'}, /setAccentColor\("#123456"\)/],
      ['background', {background: '#010203'}, /background: #010203;/],
      ['foreground', {foreground: '#0a0b0c'}, /color: #0a0b0c;/],
      ['loadingText', {loadingText: '等一会儿'}, /class="loading-text">等一会儿</],
      ['autoplay', {autoplay: true}, /scaffolding\.start\(\);\s*\} else \{/],
      ['controlGreenFlag', {controlGreenFlag: true}, /greenFlagButton/],
      ['controlStopAll', {controlStopAll: true}, /stopAllButton/],
      ['controlPause', {controlPause: true}, /RUNTIME_PAUSED/],
      ['controlFullscreen', {controlFullscreen: true}, /fullscreenButton/],
      ['editableLists', {editableLists: true}, /scaffolding\.editableLists = true/],
      ['packagedRuntime off', {packagedRuntime: false}, /usePackagedRuntime = false/],
      ['variableColor', {variableColor: '#111213'}, /background-color: #111213;/],
      ['listColor', {listColor: '#141516'}, /background-color: #141516;/],
      ['customCSS', {customCSS: '.bl-probe{color:red}'}, /\.bl-probe\{color:red\}/],
      ['customJS', {customJS: 'window.blProbe = 1;'}, /window\.blProbe = 1;/],
      ['compiler off', {compilerEnabled: false}, /enabled: false/],
      ['warpTimer', {warpTimer: true}, /warpTimer: true/],
      ['maxTextureDimension', {maxTextureDimension: 4096}, /setMaxTextureDimension\(4096\)/],
      ['closeWhenStopped', {closeWhenStopped: true}, /vm\.runtime\.on\('PROJECT_RUN_STOP'/],
      ['cloudMode local', {cloudMode: 'local', projectId: 'bl-probe'},
        /new Scaffolding\.Cloud\.LocalStorageProvider\("cloudvariables:bl-probe"\)/],
      ['loadingImage stretch', {loadingImage: IMAGE_URI, loadingImageMode: 'stretch'},
        /#loading \{\s*background-image: url\("data:image\/png;base64,/],
      ['cursor image', {cursorCustom: IMAGE_URI, cursorCenterX: 4, cursorCenterY: 8},
        /\.sc-canvas \{ cursor: url\("data:image\/png;base64,[^"]+"\) 4 8, auto; \}/]
    ];

    await test('each option turns into the scaffolding call upstream emits', () => {
      const stale = [];
      for (const [name, options, needle] of CASES) {
        const html = render(options);
        if (!needle.test(html)) stale.push(name);
      }
      assert.deepStrictEqual(stale, [], `options with no effect: ${stale.join(', ')}`);
    });

    await test('a loading image in normal mode becomes an <img>, not a background', () => {
      const html = render({loadingImage: IMAGE_URI});
      assert.match(html, /class="loading-image"><img alt="" src="data:image\/png;base64,/);
      assert.ok(!html.includes('background-image: url("data:image/png'), 'normal mode must not stretch it');
    });

    await test('an image that is not a data: URL is ignored instead of rendered broken', () => {
      assert.strictEqual(normalizeOptions({loadingImage: 'logo.png'}).loadingImage, '');
      assert.strictEqual(normalizeOptions({cursorCustom: 'cursor.png'}).cursor, 'auto');
      const html = render({loadingImage: 'logo.png', cursorCustom: 'http://example.com/c.png'});
      assert.ok(!html.includes('logo.png'));
      assert.ok(!html.includes('example.com'));
    });

    await test('the addon bundle is inlined only when an addon is asked for', () => {
      const addonsPath = path.join(ROOT, 'vendor', 'scaffolding-addons.js');
      assert.ok(fs.existsSync(addonsPath),
        `${addonsPath} is missing: the pointer-lock/gamepad/cloud-behaviour options cannot be verified`);

      assert.ok(!render({}).includes('ScaffoldingAddons'), 'the bundle leaked into a plain build');

      const html = renderHtml(project, sb3, {
        mode: 'tw',
        scaffoldingSource,
        addonsSource: addonsPath,
        pointerlock: true,
        gamepad: true,
        specialCloudBehaviors: true,
        unsafeCloudBehaviors: true,
        controlPause: true
      }).html.toString('utf8');
      assert.match(html, /window\.ScaffoldingAddons=\{run:/, 'the bundle itself must be inline');
      assert.match(html,
        /ScaffoldingAddons\.run\(scaffolding, \{"pointerlock":true,"gamepad":true,"specialCloudBehaviors":true,"unsafeCloudBehaviors":true,"pause":true\}\)/);
    });

    await test('the two switches that are the absence of a call really are absent', () => {
      // progressBar and the cloud provider are only visible by what is NOT
      // there when they are off, so a needle test cannot cover them. The CSS
      // rule is emitted either way, so the needle has to be the markup.
      assert.match(render({progressBar: true}), /class="progress-bar-outer"/);
      assert.ok(!/class="progress-bar-outer"/.test(render({progressBar: false})));
      // The scaffolding bundle itself defines `addCloudProvider`, so the needle
      // has to be the call we emit, not the method name.
      const PROVIDER = /scaffolding\.addCloudProvider\(new Scaffolding\.Cloud\.LocalStorageProvider/;
      assert.match(render({cloudMode: 'local'}), PROVIDER);
      assert.ok(!PROVIDER.test(render({cloudMode: 'off'})));
      // Off by default: a project that never asked for cloud storage must not
      // start writing to localStorage.
      assert.ok(!PROVIDER.test(render({})));
    });

    await test('a value the renderer cannot honour falls back instead of lying', () => {
      // 'ws' is upstream's default mode; this packager has no WebSocket
      // provider, so accepting the string and doing nothing would be the worst
      // possible outcome — silently no cloud variables at all.
      assert.strictEqual(normalizeOptions({cloudMode: 'ws'}).cloudMode, 'off');
      assert.strictEqual(normalizeOptions({cursor: 'custom'}).cursor, 'auto');
      assert.strictEqual(normalizeOptions({resizeMode: 'stretch-screen'}).resizeMode, 'preserve-ratio');
      assert.strictEqual(normalizeOptions({accent: 'cornflowerblue'}).accent, '#4d97ff');
      assert.strictEqual(normalizeOptions({framerate: 9999}).framerate, 240);
      assert.strictEqual(normalizeOptions({maxTextureDimension: 1e9}).maxTextureDimension, 16384);
      assert.strictEqual(normalizeOptions({maxClones: Infinity}).maxClones, Infinity);
      assert.strictEqual(normalizeOptions({maxClones: 'lots'}).maxClones, 300);
    });

    await test('the option file the page exports is one the CLIs accept', () => {
      // Exactly what ui/index.html writes: a v2 wrapper in the wire format,
      // containing both the pass-through keys and the UI-only ones.
      const exported = JSON.stringify({
        app: 'bl-packager',
        version: 2,
        options: {mode: 'fast', turbo: true, cloudMode: 'local', projectId: 'bl-probe',
          maxClones: 300, fencing: true, packagedRuntime: true, preload: true, optimizePng: true}
      });
      const spec = loadOptionSet(exported);
      assert.strictEqual(spec.cloudMode, 'local');
      assert.strictEqual(spec.projectId, 'bl-probe');

      const passed = pickRenderOptions(spec);
      assert.strictEqual(passed.cloudMode, 'local');
      assert.strictEqual(passed.projectId, 'bl-probe');
      // UI-only keys must not leak into the renderer's option bag...
      for (const key of Object.keys(passed)) {
        assert.ok(RENDER_OPTION_KEYS.includes(key), `${key} is not a render option`);
      }
      assert.ok(!('mode' in passed), 'mode is a pipeline argument, not a render option');
      assert.ok(!('preload' in passed), 'preload is a pipeline argument, not a render option');
      assert.ok(!('optimizePng' in passed), 'optimizePng is a pipeline argument, not a render option');
      // ...and the option the page chose must be the one that gets rendered.
      assert.match(render(passed),
        /scaffolding\.addCloudProvider\(new Scaffolding\.Cloud\.LocalStorageProvider/);
    });
  }

  // -------------------------------------------------------------------------
  section('[zip target: index.html with assets/ next to it]');
  // -------------------------------------------------------------------------
  // The one target where inlining is the wrong answer: the browser fetches the
  // assets itself, in parallel, and caches them. Everything here runs in Node,
  // including the loader path, because createProjectSource's http mode only
  // needs a `fetch`-shaped function.
  {
    const {packToZip} = require('../src/lib/pipeline');
    const {createProjectSource} = require('../src/runtime/loader');

    const png = encodePng(16, 16, canvasRows(16, 16), {filter: 0, level: 6});
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">' +
      '<rect width="8" height="8"/></svg>');
    const pngName = `${md5(png)}.png`;
    const svgName = `${md5(svg)}.svg`;
    const sb3 = writeZip([
      {
        name: 'project.json',
        data: Buffer.from(JSON.stringify({
          targets: [{
            isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {},
            comments: {}, sounds: [], volume: 100, layerOrder: 0,
            costumes: [{assetId: pngName.replace(/\.png$/, ''), name: 'c', md5ext: pngName,
              dataFormat: 'png', rotationCenterX: 0, rotationCenterY: 0}]
          }],
          monitors: [],
          extensions: ['blTest'],
          extensionURLs: {blTest: 'https://extensions.turbowarp.org/blTest.js'},
          meta: {semver: '3.0.0', vm: '0.0.0'}
        }), 'utf8')
      },
      {name: pngName, data: png},
      {name: svgName, data: svg}
    ]);

    const extensionSource = 'Scratch.extensions.register({getInfo: () => ({id: "blTest", name: "T", blocks: []})});';
    const options = {
      inputPath: 'site.sb3',
      title: 'Site',
      optimizePng: false,
      extensions: [{name: 'blTest.js', source: extensionSource}]
    };
    const packed = packToZip(sb3, options);
    const entries = readZip(packed.zip);
    const html = entries.get('index.html').data.toString('utf8');
    const projectJSON = JSON.parse(entries.get('project.json').data.toString('utf8'));

    await test('the archive is index.html + project.json + one file per asset', () => {
      assert.deepStrictEqual([...entries.keys()].sort(),
        ['assets/' + pngName, 'assets/' + svgName, 'index.html', 'project.json'].sort());
    });

    await test('index.html carries no payload at all', () => {
      assert.ok(!/<script data=/.test(html), 'the base85 chunks must be gone');
      assert.ok(!html.includes('decodeChunk'), 'the decoder must not be inlined');
      // loader.js mentions both by name (it has a fallback path for each), so the
      // needles have to be strings only the implementations contain.
      assert.ok(!html.includes('BLPK: bad magic'), 'the container reader must not be inlined');
      assert.ok(!html.includes('inflate: invalid huffman code'),
        'the pure-JS inflater must not be inlined — nothing here decompresses');
      assert.match(html, /mode: "http"/);
      assert.match(html, /assetBase: "assets\/"/);
      // The runtime is still there: this is the same page, not a different one.
      assert.ok(html.length > 1000000, `index.html is suspiciously small: ${html.length}`);
    });

    await test('extension baking survives into project.json', () => {
      assert.match(projectJSON.extensionURLs.blTest, /^data:text\/javascript/);
    });

    await test('the assets are byte-identical to the project', () => {
      assert.ok(entries.get('assets/' + pngName).data.equals(png));
      assert.ok(entries.get('assets/' + svgName).data.equals(svg));
    });

    await test('packing twice produces the same bytes', () => {
      const again = packToZip(sb3, options);
      assert.ok(again.zip.equals(packed.zip), 'the zip target must be byte-deterministic');
    });

    // --- the loader, driven through a fetch-shaped stub ---------------------
    const makeStub = () => {
      const stored = new Map();
      const storage = {
        addHelper: (helper) => { storage.helper = helper; },
        createAsset: (assetType, dataFormat, data, assetId) => {
          stored.set(`${assetId}.${dataFormat}`, Buffer.from(data));
          return {assetType, dataFormat, assetId};
        }
      };
      return {storage, vm: {runtime: {on: () => {}}}, stored};
    };

    const fakeFetch = (files) => async (path) => {
      if (!files.has(path)) return {ok: false, status: 404};
      const data = files.get(path);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.length)
      };
    };

    const fileTable = new Map();
    for (const [name, entry] of entries) fileTable.set(name, entry.data);

    await test('the http loader fetches project.json and every asset', async () => {
      const stub = makeStub();
      const source = createProjectSource({
        mode: 'http', storage: stub.storage, vm: stub.vm, fetch: fakeFetch(fileTable)
      });
      const bytes = Buffer.from(await source.getProjectData());
      assert.ok(bytes.equals(entries.get('project.json').data));
      assert.strictEqual(source.stats().mode, 'http');

      for (const key of [pngName, svgName]) {
        const dot = key.lastIndexOf('.');
        await stub.storage.helper.load('ImageVector', key.slice(0, dot), key.slice(dot + 1));
        assert.ok(stub.stored.get(key).equals(fileTable.get('assets/' + key)), `asset ${key} differs`);
      }
      assert.strictEqual(source.assetLoads(), 2);
      assert.strictEqual(source.warmUp(), null, 'there is nothing to warm up');
    });

    await test('a missing asset is null, a missing project.json is an explanation', async () => {
      const stub = makeStub();
      const source = createProjectSource({
        mode: 'http', storage: stub.storage, vm: stub.vm, fetch: fakeFetch(fileTable)
      });
      assert.strictEqual(await stub.storage.helper.load('ImageVector', '0'.repeat(32), 'png'), null);

      const broken = createProjectSource({
        mode: 'http', storage: stub.storage, vm: stub.vm, fetch: fakeFetch(new Map())
      });
      await assert.rejects(broken.getProjectData(), /has to be served over http/);
    });
  }

  // -------------------------------------------------------------------------
  section('[app targets: macOS / Linux / Android]');
  // -------------------------------------------------------------------------
  // These three targets share one payload with the HTML packager, so the only
  // things worth asserting are the parts that differ: the per-target resource
  // layout, the metadata the hosts parse, and the escaping in the generated
  // plist / manifest / desktop files — the last of which is where a title like
  // `Tom & Jerry's` stops being cosmetic and starts being a build failure.
  {
    const os = require('node:os');
    const apps = require('../src/lib/apps');
    const {packToHtml} = require('../src/lib/pipeline');

    const png = encodePng(16, 16, canvasRows(16, 16), {filter: 0, level: 6});
    const pngName = `${md5(png)}.png`;
    const sb3 = writeZip([
      {
        name: 'project.json',
        data: Buffer.from(JSON.stringify({
          targets: [{
            isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {},
            blocks: {}, comments: [], sounds: [],
            costumes: [{assetId: pngName.replace(/\.png$/, ''), name: 'backdrop1',
              md5ext: pngName, dataFormat: 'png', rotationCenterX: 0, rotationCenterY: 0}],
            volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'off'
          }],
          monitors: [], extensions: [], meta: {semver: '3.0.0', vm: '0.0.0'}
        }), 'utf8')
      },
      {name: pngName, data: png}
    ]);

    // A scratch root: these tests must not overwrite the real hosts/*/build,
    // which is whatever the last manual pack left behind.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-packager-apps-'));
    fs.mkdirSync(path.join(root, 'vendor'), {recursive: true});
    fs.copyFileSync(path.join(ROOT, 'vendor', 'scaffolding-min.js'),
      path.join(root, 'vendor', 'scaffolding-min.js'));

    const TITLE = 'Tom & Jerry\'s <测试>';
    const common = {
      target: 'all',
      inputPath: 'demo.sb3',
      title: TITLE,
      id: 'com.example.game',
      version: '2.5.1',
      root
    };

    const written = apps.writeAppResources(sb3, common);
    const html = packToHtml(sb3, {
      mode: 'fast', inputPath: 'demo.sb3', title: TITLE, root
    }).html;

    await test('one render, three targets, one identical payload', () => {
      assert.deepStrictEqual(Object.keys(written.targets).sort(), ['android', 'linux', 'macos']);
      const macos = fs.readFileSync(written.targets.macos.paths.html);
      const linux = fs.readFileSync(written.targets.linux.paths.html);
      const android = fs.readFileSync(path.join(written.targets.android.paths.assets, 'app.html.gz'));
      assert.ok(macos.equals(linux), 'macOS and Linux payloads differ');
      assert.ok(macos.equals(android), 'the APK assets differ from the bundle payload');
      // gzip, not the raw page: this is the file the host inflates.
      assert.ok(zlib.gunzipSync(macos).equals(html), 'payload is not gzip(packed html)');
      assert.ok(macos.length < html.length);
    });

    await test('app.meta carries the identity the hosts read', () => {
      const meta = fs.readFileSync(written.targets.macos.paths.meta, 'utf8');
      const fields = new Map(meta.trim().split('\n').map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }));
      assert.strictEqual(fields.get('title'), TITLE);
      assert.strictEqual(fields.get('id'), 'com.example.game');
      assert.strictEqual(fields.get('version'), '2.5.1');
      // `<`/`>` are illegal in a file name on every one of the three, so they
      // become spaces; the *title* keeps them, and that is what the window,
      // the Finder label and the Android label show.
      assert.strictEqual(fields.get('name'), "Tom & Jerry's 测试");
      assert.strictEqual(fields.get('gzip'), '1');
      assert.strictEqual(fields.get('target'), 'macos,linux,android');
      // Defaults are omitted so a rebuild keeps the exact bytes.
      assert.ok(!fields.has('window'), 'window=window should not be written');
    });

    await test('the plist is XML-escaped and UTF-8 clean', () => {
      const plist = fs.readFileSync(written.targets.macos.paths.plist, 'utf8');
      assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>com\.example\.game<\/string>/);
      assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>2\.5\.1<\/string>/);
      // The title survives as UTF-8 (a plist is XML), which the exe's app.rc
      // cannot do — that file is parsed in the OEM code page.
      assert.ok(plist.includes('Tom &amp; Jerry&apos;s &lt;测试&gt;'), 'title was not escaped');
      assert.match(plist, /<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/);
      // No stray '&' that would make the plist unparseable.
      assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(plist), 'unescaped ampersand');
    });

    await test('the AndroidManifest names the fixed host class and a numeric versionCode', () => {
      const manifest = fs.readFileSync(written.targets.android.paths.manifest, 'utf8');
      assert.match(manifest, /package="com\.example\.game"/);
      assert.match(manifest, /android:versionName="2\.5\.1"/);
      assert.match(manifest, /android:versionCode="2005001"/);
      assert.match(manifest, /android:name="dev\.bilup\.player\.MainActivity"/);
      assert.match(manifest, /android:usesCleartextTraffic="true"/);
      assert.match(manifest, /android:screenOrientation="sensorLandscape"/);
      // The APK's assets are what AssetManager.open() sees.
      const assets = written.targets.android.paths.assets;
      assert.ok(fs.existsSync(path.join(assets, 'app.meta')));
      assert.strictEqual(fs.readFileSync(path.join(assets, 'app.meta'), 'utf8'),
        fs.readFileSync(written.targets.android.paths.meta, 'utf8'));
    });

    await test('a title with an apostrophe does not break aapt2', () => {
      const strings = fs.readFileSync(
        path.join(written.targets.android.dir, 'res', 'values', 'strings.xml'), 'utf8');
      // aapt2 rejects a bare ' inside <string>; XML does not need it escaped, so
      // it has to be the Android escape.
      assert.ok(strings.includes("Tom &amp; Jerry\\'s &lt;测试&gt;"), strings);
    });

    await test('the desktop entry points at the binary build.sh produces', () => {
      const desktop = fs.readFileSync(written.targets.linux.paths.desktop, 'utf8');
      assert.match(desktop, /^Exec=bl-player$/m);
      assert.match(desktop, /^Icon=com\.example\.game$/m);
      assert.match(desktop, /^Name=Tom & Jerry's <测试>$/m);
    });

    await test('--no-gzip stores the page itself and says so', () => {
      const plain = apps.writeAppResources(sb3, Object.assign({}, common,
        {target: 'macos', gzip: false}));
      const payload = fs.readFileSync(plain.targets.macos.paths.html);
      assert.ok(payload.equals(html), 'the payload should be the raw HTML');
      assert.match(fs.readFileSync(plain.targets.macos.paths.meta, 'utf8'), /^gzip=0$/m);
    });

    await test('an icon is written where each target looks for it', () => {
      const iconPath = path.join(root, 'icon.png');
      fs.writeFileSync(iconPath, png);
      const withIcon = apps.writeAppResources(sb3, Object.assign({}, common,
        {target: 'all', icon: apps.resolveAppIcon(iconPath)}));

      assert.ok(fs.readFileSync(withIcon.targets.macos.paths.icon).equals(png));
      assert.match(fs.readFileSync(withIcon.targets.macos.paths.plist, 'utf8'),
        /<key>CFBundleIconFile<\/key>\s*<string>AppIcon<\/string>/);
      assert.ok(fs.existsSync(path.join(withIcon.targets.android.dir,
        'res', 'mipmap', 'ic_launcher.png')));
      assert.match(fs.readFileSync(withIcon.targets.android.paths.manifest, 'utf8'),
        /android:icon="@mipmap\/ic_launcher"/);
      assert.ok(fs.readFileSync(withIcon.targets.linux.paths.icon).equals(png));
    });

    await test('a .ico is refused with a message that names the right format', () => {
      const icoPath = path.join(root, 'icon.ico');
      // Enough of an ICONDIR for the sniffer to say "ico".
      fs.writeFileSync(icoPath, Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0]));
      assert.throws(() => apps.resolveAppIcon(icoPath), /\.png/);
      assert.throws(() => apps.resolveAppIcon(path.join(root, 'nope.png')), /ENOENT/);
    });

    await test('bundle ids are normalized into something both OSes accept', () => {
      // Hyphens are legal on macOS/CFBundleIdentifier and illegal in an Android
      // applicationId, so one id for both has to use underscores.
      assert.strictEqual(apps.bundleId('', 'My Game!'), 'dev.bilup.my_game');
      assert.strictEqual(apps.bundleId('com.9lives/my-game', 'x'), 'com.a9lives_my_game');
      assert.strictEqual(apps.bundleId('single', 'x'), 'dev.single');
      // Non-ASCII cannot appear in an applicationId; '_' per code point, then a
      // leading letter because no segment may start with one of those.
      assert.strictEqual(apps.bundleId('dev.bilup.测试', ''), 'dev.bilup.a__');
    });

    await test('file names keep UTF-8 but lose what a file system refuses', () => {
      assert.strictEqual(apps.safeName('测试游戏 Test'), '测试游戏 Test');
      assert.strictEqual(apps.safeName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
      assert.strictEqual(apps.safeName('   '), 'bl-app');
      assert.strictEqual(apps.safeName('x'.repeat(100)).length, 60);
    });

    await test('an unknown target is refused before anything is written', () => {
      assert.throws(() => apps.writeAppResources(sb3, {target: 'windows', root}), /unknown target/);
      assert.throws(() => apps.writeAppResources(sb3, {target: '', root}), /no target/);
      assert.throws(() => apps.writeAppResources(sb3, Object.assign({}, common,
        {orientation: 'sideways'})), /unknown orientation/);
      assert.throws(() => apps.writeAppResources(sb3, Object.assign({}, common,
        {windowMode: 'floating'})), /unknown window mode/);
    });

    await test('the build scripts are all present and executable-by-bash', () => {
      for (const target of apps.TARGETS) {
        const script = path.join(ROOT, 'hosts', target, 'build.sh');
        const text = fs.readFileSync(script, 'utf8');
        assert.match(text, /^#!\/usr\/bin\/env bash/, `${target} needs a bash shebang`);
        // CRLF in a shell script is `$'\r: command not found'` on Linux; these
        // files are authored on Windows, so the bytes are asserted, not assumed.
        assert.ok(!text.includes('\r'), `${target}/build.sh has CRLF line endings`);
        // Every script reports artifacts on this exact prefix; the CLI parses it.
        assert.match(text, /^echo "ARTIFACT /m);
      }
    });
  }

  // -------------------------------------------------------------------------
  section('[ui server: the HTTP path is the same pipeline]');
  // -------------------------------------------------------------------------
  // The web UI is a third front end onto src/lib/pipeline.js. These tests drive
  // it over real HTTP and assert the bytes it returns are *identical* to what
  // the CLI produces for the same options — a UI that quietly packed things
  // differently would be worse than no UI.
  //
  // They run against a scratch root so that exe/build/app.html.gz — the payload
  // embedded in whatever exe was compiled last — is never clobbered.
  {
    const http = require('node:http');
    const os = require('node:os');
    const {createServer, listen} = require('../ui/server');
    const {packToHtml, packToZip} = require('../src/lib/pipeline');

    // A canvas-style fixture on purpose: filter 0 / level 6 is what
    // canvas.toDataURL emits, and it is the only shape of PNG the lossless
    // re-encoder can actually improve. A "nice" PNG would make the optimizePng
    // switch unobservable here, and a test that passes either way proves
    // nothing.
    const png = encodePng(96, 72, canvasRows(96, 72), {filter: 0, level: 6});
    const pngName = `${md5(png)}.png`;
    const costume = {
      assetId: pngName.replace(/\.png$/, ''), name: 'costume1', md5ext: pngName,
      dataFormat: 'png', rotationCenterX: 0, rotationCenterY: 0
    };
    const sb3 = writeZip([
      {
        name: 'project.json',
        data: Buffer.from(JSON.stringify({
          targets: [
            {
              isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {},
              blocks: {}, comments: {}, costumes: [costume], sounds: [], volume: 100,
              layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'off'
            },
            {
              isStage: false, name: 'Sprite1', variables: {}, lists: {}, broadcasts: {},
              blocks: {}, comments: {}, costumes: [costume], sounds: [], volume: 100,
              layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90,
              draggable: false, rotationStyle: 'all around'
            }
          ],
          monitors: [], extensions: [], meta: {semver: '3.0.0', vm: '0.0.0'}
        }), 'utf8')
      },
      {name: pngName, data: png}
    ]);

    // The same project, but with an extension whose source only exists on the
    // internet — the case baking is for.
    const extensionSb3 = writeZip([
      {
        name: 'project.json',
        data: Buffer.from(JSON.stringify({
          targets: [{
            isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {},
            blocks: {}, comments: {}, costumes: [costume], sounds: [], volume: 100,
            layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'off'
          }],
          monitors: [],
          extensions: ['blTest'],
          extensionURLs: {blTest: 'https://x/blTest.js'},
          meta: {semver: '3.0.0', vm: '0.0.0'}
        }), 'utf8')
      },
      {name: pngName, data: png}
    ]);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-packager-ui-'));
    fs.mkdirSync(path.join(tmpRoot, 'vendor'), {recursive: true});
    fs.copyFileSync(path.join(ROOT, 'vendor', 'scaffolding-min.js'),
      path.join(tmpRoot, 'vendor', 'scaffolding-min.js'));

    const server = createServer({buildRoot: tmpRoot});
    const port = await listen(server, 0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    const post = (route, body, params = '') =>
      fetch(`${base}${route}${params}`, {method: 'POST', body});

    try {
      await test('serves the UI page', async () => {
        const res = await fetch(`${base}/`);
        assert.strictEqual(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/html/);
        const html = await res.text();
        assert.match(html, /Bilup Packager/);
        assert.match(html, /让创作锦上添花/);
      });

      await test('serves the tab icon the page links to', async () => {
        const html = await (await fetch(`${base}/`)).text();
        // The href has to stay relative: the deployed site lives under
        // /BL-Packager/, where a root-absolute path points at nothing.
        assert.match(html, /<link rel="icon"[^>]*href="favicon\.svg"/);
        const res = await fetch(`${base}/favicon.svg`);
        assert.strictEqual(res.status, 200);
        assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
        assert.match(await res.text(), /^<svg[^>]*viewBox=/);
      });

      await test('GET /api/health reports the runtime and the toolchain', async () => {
        const res = await fetch(`${base}/api/health`);
        assert.strictEqual(res.status, 200);
        const health = await res.json();
        assert.strictEqual(health.scaffolding.min, true);
        assert.strictEqual(typeof health.msvc, 'boolean');
      });

      await test('POST /api/inspect describes the project without rendering it', async () => {
        const res = await post('/api/inspect', sb3, '?filename=demo.sb3');
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.analysis.targetCount, 2);
        assert.strictEqual(data.analysis.assetCount, 1);
        assert.strictEqual(data.byExtension.png, 1);
        assert.strictEqual(data.scaffolding, 'scaffolding-min.js');
        assert.strictEqual(data.scaffoldingAvailable.min, true);
        assert.strictEqual(data.warning, null);
        assert.strictEqual(data.analysis.cloudVariableCount, 0);
        // Inspecting must stay cheap: the expensive PNG re-encode is the
        // packager's job, not the "what is in this file?" screen's.
        assert.strictEqual(data.analysis.png.optimized, 0);
      });

      await test('POST /api/inspect counts cloud variables', async () => {
        const stage = (variables) => ({
          name: 'project.json',
          data: Buffer.from(JSON.stringify({
            targets: [{
              isStage: true, name: 'Stage', variables, lists: {}, broadcasts: {},
              blocks: {}, comments: {}, costumes: [], sounds: [], volume: 100,
              layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'off'
            }],
            monitors: [], extensions: [], meta: {semver: '3.0.0', vm: '0.0.0'}
          }), 'utf8')
        });

        const cloud = writeZip([stage({
          '☁ hi': {name: '☁ hi', value: 0, isCloud: true},
          'score': {name: 'score', value: 0, isCloud: false}
        })]);

        const res = await post('/api/inspect', cloud, '?filename=cloud.sb3');
        assert.strictEqual(res.status, 200);
        // The flag, not the ☁ in the name — that is what the VM keys off.
        assert.strictEqual((await res.json()).analysis.cloudVariableCount, 1);
      });

      await test('POST /api/inspect rejects an empty body', async () => {
        const res = await post('/api/inspect', Buffer.alloc(0), '?filename=demo.sb3');
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /empty request body/);
      });

      await test('POST /api/pack forwards the player options and the PNG switch', async () => {
        const common = {
          mode: 'fast',
          inputPath: 'demo.sb3',
          title: 'T',
          turbo: true,
          autoplay: true,
          framerate: 60,
          username: 'bl'
        };

        const res = await post('/api/pack', sb3,
          '?filename=demo.sb3&title=T&turbo=1&autoplay=1&framerate=60&username=bl&optimizePng=0');
        assert.strictEqual(res.status, 200);

        const served = Buffer.from(await res.arrayBuffer());
        const unoptimized = packToHtml(sb3, Object.assign({}, common, {optimizePng: false})).html;
        assert.ok(served.equals(unoptimized),
          `served ${served.length} bytes, pipeline produced ${unoptimized.length}`);
        assert.strictEqual(JSON.parse(decodeURIComponent(res.headers.get('x-pack-stats'))).title, 'T');

        // Without this, the assertion above would hold just as well if
        // optimizePng were being ignored entirely.
        const optimized = packToHtml(sb3, Object.assign({}, common, {optimizePng: true})).html;
        assert.ok(optimized.length < unoptimized.length,
          `the fixture must be improvable, got ${optimized.length} vs ${unoptimized.length}`);
      });

      await test('POST /api/pack returns byte-identical HTML to the CLI', async () => {
        const res = await post('/api/pack', sb3, '?filename=demo.sb3');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('content-type'), 'text/html; charset=utf-8');

        const served = Buffer.from(await res.arrayBuffer());
        const expected = packToHtml(sb3, {mode: 'fast', inputPath: 'demo.sb3'}).html;
        assert.ok(served.equals(expected),
          `served ${served.length} bytes, CLI produced ${expected.length}`);

        const stats = JSON.parse(decodeURIComponent(res.headers.get('x-pack-stats')));
        assert.strictEqual(stats.htmlBytes, expected.length);
        assert.strictEqual(stats.mode, 'fast');
        assert.strictEqual(stats.project.targetCount, 2);
        assert.ok(stats.project.assetCount >= 1);
        assert.strictEqual(stats.payloadBytes, stats.container.containerBytes);
      });

      await test('POST /api/pack honours mode=tw', async () => {
        const res = await post('/api/pack', sb3, '?filename=demo.sb3&mode=tw');
        assert.strictEqual(res.status, 200);
        const served = Buffer.from(await res.arrayBuffer());
        const expected = packToHtml(sb3, {mode: 'tw', inputPath: 'demo.sb3'}).html;
        assert.ok(served.equals(expected));
        assert.strictEqual(JSON.parse(decodeURIComponent(res.headers.get('x-pack-stats'))).mode, 'tw');
        assert.match(decodeURIComponent(res.headers.get('x-pack-filename')), /\.tw\.html$/);
      });

      await test('POST /api/pack carries the whole option set into the page', async () => {
        // One query string exercising every family the UI can now send:
        // a pass-through player option, a derived one (maxClones), a cloud
        // provider, a resize mode, a control button and raw CSS.
        const options = {
          mode: 'fast',
          inputPath: 'demo.sb3',
          title: 'Opt',
          cloudMode: 'local',
          projectId: 'bl-probe',
          resizeMode: 'dynamic-resize',
          cursor: 'none',
          controlGreenFlag: true,
          maxTextureDimension: 4096,
          packagedRuntime: false,
          maxClones: Infinity,
          customCSS: '.bl{q:1}'
        };

        const res = await post('/api/pack', sb3, '?filename=demo.sb3&title=Opt' +
          '&cloudMode=local&projectId=bl-probe&resizeMode=dynamic-resize&cursor=none' +
          '&controlGreenFlag=1&maxTextureDimension=4096&packagedRuntime=0&maxClones=Infinity' +
          '&customCSS=' + encodeURIComponent('.bl{q:1}'));
        assert.strictEqual(res.status, 200);

        const served = Buffer.from(await res.arrayBuffer());
        const html = served.toString('utf8');
        assert.match(html, /new Scaffolding\.Cloud\.LocalStorageProvider\("cloudvariables:bl-probe"\)/);
        assert.match(html, /scaffolding\.resizeMode = "dynamic-resize"/);
        assert.match(html, /\.sc-canvas \{ cursor: none; \}/);
        assert.match(html, /maxClones: Infinity/);
        assert.match(html, /usePackagedRuntime = false/);
        assert.match(html, /setMaxTextureDimension\(4096\)/);
        assert.match(html, /greenFlagButton/);
        assert.match(html, /\.bl\{q:1\}/);

        // Still the same pipeline: the query string must not be a second,
        // slightly different way of building the page.
        assert.ok(served.equals(packToHtml(sb3, options).html));
      });

      await test('POST /api/pack with target=zip returns the same archive as the CLI', async () => {
        const res = await post('/api/pack', sb3, '?filename=demo.sb3&target=zip&title=Site');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('content-type'), 'application/zip');
        assert.match(decodeURIComponent(res.headers.get('x-pack-filename')), /\.zip$/);

        const served = Buffer.from(await res.arrayBuffer());
        const expected = packToZip(sb3, {inputPath: 'demo.sb3', title: 'Site'}).zip;
        assert.ok(served.equals(expected), `served ${served.length} bytes, CLI produced ${expected.length}`);

        const entries = readZip(served);
        assert.ok(entries.has('index.html'));
        assert.ok(entries.has('project.json'));
        assert.ok([...entries.keys()].some((name) => name.startsWith('assets/')));
      });

      await test('POST /api/pack bakes the extensions sent in the query string', async () => {
        const source = 'Scratch.extensions.register({getInfo: () => ({id: "blTest", name: "T", blocks: []})});';
        const extensions = JSON.stringify([{name: 'blTest.js', source}]);
        const res = await post('/api/pack', extensionSb3,
          '?filename=demo.sb3&target=zip&extensions=' + encodeURIComponent(extensions));
        assert.strictEqual(res.status, 200);

        const entries = readZip(Buffer.from(await res.arrayBuffer()));
        const projectJSON = JSON.parse(entries.get('project.json').data.toString('utf8'));
        assert.match(projectJSON.extensionURLs.blTest, /^data:text\/javascript/,
          'the baked source must be in the page, not the https URL');

        // Without a source the same project would still point at the internet.
        const plain = await post('/api/pack', extensionSb3, '?filename=demo.sb3&target=zip');
        const plainJSON = JSON.parse(readZip(Buffer.from(await plain.arrayBuffer()))
          .get('project.json').data.toString('utf8'));
        assert.strictEqual(plainJSON.extensionURLs.blTest, 'https://x/blTest.js');
      });

      await test('extensions that carry no source, or too much, are refused', () => {
        const {readExtensions, MAX_EXTENSION_BYTES} = require('../ui/server');
        const encode = (value) => new URLSearchParams({extensions: JSON.stringify(value)});

        assert.throws(() => readExtensions(encode([{name: 'x.js'}])), /has no source/);
        assert.throws(() => readExtensions(encode([{name: 'x.js', source: 'a'.repeat(MAX_EXTENSION_BYTES + 1)}])),
          /the limit is/);
        assert.throws(() => readExtensions(new URLSearchParams({extensions: '{not json'})), /not valid JSON/);

        // A file name is used as a download hint; a path separator in it would be
        // an easy way to write somewhere else.
        const [entry] = readExtensions(encode([{name: '../../evil.js', source: 'x'}]));
        assert.ok(!/[\\/]/.test(entry.name), `unsanitised name: ${entry.name}`);
      });

      await test('POST /api/pack-exe writes an icon, a version resource and a window mode', async () => {
        const icoHex = '00000100010010100000010020006804000016000000';
        const icon = `data:image/x-icon;base64,${Buffer.from(icoHex, 'hex').toString('base64')}`;
        const res = await post('/api/pack-exe', sb3,
          '?filename=demo.sb3&title=Iconic&icon=' + encodeURIComponent(icon) +
          '&version=1.2.3&windowMode=maximize&build=0');
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.report.windowMode, 'maximize');
        assert.strictEqual(data.report.icon, 'app.ico');

        const dir = path.join(tmpRoot, 'exe', 'build');
        assert.match(fs.readFileSync(path.join(dir, 'app.meta'), 'utf8'), /window=maximize\n/);
        assert.ok(fs.existsSync(path.join(dir, 'app.ico')), 'the icon file was not written');

        const rc = fs.readFileSync(path.join(dir, 'app.rc'), 'utf8');
        assert.match(rc, /1 ICON "app\.ico"/);
        assert.match(rc, /1 VERSIONINFO/);
        assert.match(rc, /FILEVERSION 1,2,3,0/);
        assert.match(rc, /VALUE "ProductVersion", "1\.2\.3"/);
        // rc.exe parses this file in the OEM code page: one non-ASCII byte turns
        // into a build failure nobody can read.
        assert.ok(rc.split('').every((c) => c.charCodeAt(0) < 0x80), 'app.rc must stay ASCII');
      });

      await test('an icon that is not an .ico is refused before rc.exe sees it', async () => {
        const notAnIcon = imageDataUri(
          Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
            '0000000d4944415478da63f8ffff3f0005fe02fea7d6a4c00000000049454e44ae426082', 'hex'),
          'app.png');
        const res = await post('/api/pack-exe', sb3,
          '?filename=demo.sb3&icon=' + encodeURIComponent(notAnIcon));
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /\.ico/);
      });

      await test('an unreadable loading-screen image is a 400, not a broken page', async () => {
        const res = await post('/api/pack', sb3,
          '?filename=demo.sb3&loadingImage=' + encodeURIComponent('data:text/plain,hello'));
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /not an image/);
      });

      await test('POST /api/pack rejects an empty body instead of packing nothing', async () => {
        const res = await post('/api/pack', Buffer.alloc(0), '?filename=demo.sb3');
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /empty request body/);
      });

      await test('POST /api/pack-exe writes resources into the injected root', async () => {
        const res = await post('/api/pack-exe', sb3,
          '?filename=demo.sb3&title=UI%20demo&width=800&height=600&build=0');
        assert.strictEqual(res.status, 200);
        const data = await res.json();

        assert.strictEqual(data.build.attempted, false);
        assert.strictEqual(data.report.title, 'UI demo');
        assert.strictEqual(data.report.resourceGzip, true);
        assert.ok(data.report.resourceBytes > 0);
        // No compile was requested, so no exe may be advertised.
        assert.strictEqual(data.report.exeBytes, null);
        assert.strictEqual(data.report.hostBytes, null);
        assert.ok(!data.artifacts.some((a) => a.name.endsWith('.exe')));

        const written = path.join(tmpRoot, 'exe', 'build');
        assert.ok(fs.existsSync(path.join(written, 'app.html.gz')));
        assert.strictEqual(fs.statSync(path.join(written, 'app.html.gz')).size, data.report.resourceBytes);
        assert.match(fs.readFileSync(path.join(written, 'app.meta'), 'utf8'),
          /^title=UI demo\nwidth=800\nheight=600\ngzip=1\ndevtools=1\n$/);
        // The resource script must stay pure ASCII: rc.exe parses it in the OEM
        // code page.
        const rc = fs.readFileSync(path.join(written, 'app.rc'));
        assert.ok(rc.every((byte) => byte < 0x80));
      });

      await test('POST /api/pack-exe forwards player options and bounds the window size', async () => {
        const res = await post('/api/pack-exe', sb3,
          '?filename=demo.sb3&title=Geo&width=99999&height=0&framerate=120&turbo=1');
        assert.strictEqual(res.status, 200);
        const data = await res.json();

        // 99999 clamps to the ceiling; 0 is not a legal window height and clamps
        // to the floor. Neither may reach the resource script as-is.
        const meta = fs.readFileSync(path.join(tmpRoot, 'exe', 'build', 'app.meta'), 'utf8');
        assert.match(meta, /width=8192\n/);
        assert.match(meta, /height=160\n/);

        // The payload is not a separate code path: it is the HTML the same
        // options produce, gzipped. Anything else would let an exe and an HTML
        // build of one project disagree.
        const expected = packToHtml(sb3, {
          mode: 'fast',
          inputPath: 'demo.sb3',
          title: 'Geo',
          turbo: true,
          framerate: 120
        });
        assert.strictEqual(data.report.resourceBytes, zlib.gzipSync(expected.html, {level: 9}).length);
      });

      await test('a stale artifact in the shared build directory is not offered', async () => {
        // exe/build/ is shared and never cleaned, so it can hold a previous
        // project's binary. Offering that as the current run's output is worse
        // than offering nothing.
        const dir = path.join(tmpRoot, 'exe', 'build');
        const stale = new Date(Date.now() - 3600 * 1000);
        for (const name of ['bl-player.exe', 'WebView2Loader.dll']) {
          const file = path.join(dir, name);
          fs.writeFileSync(file, 'left over from an earlier run');
          fs.utimesSync(file, stale, stale);
        }

        try {
          const res = await post('/api/pack-exe', sb3, '?filename=demo.sb3&build=0');
          const data = await res.json();
          const names = data.artifacts.map((a) => a.name);
          assert.ok(names.includes('app.html.gz'), `expected the fresh payload, got ${names}`);
          assert.ok(!names.includes('bl-player.exe'), "a stale exe was offered as this run's output");
          assert.ok(!names.includes('WebView2Loader.dll'), "a stale DLL was offered as this run's output");
        } finally {
          for (const name of ['bl-player.exe', 'WebView2Loader.dll']) {
            fs.rmSync(path.join(dir, name), {force: true});
          }
        }
      });

      await test('GET /api/artifact serves only allowlisted names', async () => {
        const ok = await fetch(`${base}/api/artifact?name=app.rc`);
        assert.strictEqual(ok.status, 200);
        assert.match(await ok.text(), /RCDATA/);

        for (const name of ['../vendor/scaffolding-min.js', '..%2Fapp.meta', 'bl-player.exe', 'nope.txt']) {
          const res = await fetch(`${base}/api/artifact?name=${name}`);
          assert.strictEqual(res.status, 404, `expected 404 for ${name}`);
        }
      });

      await test('the loopback guard rejects a foreign Host header', async () => {
        const status = await new Promise((resolve, reject) => {
          const req = http.request(
            {host: '127.0.0.1', port, path: '/', headers: {Host: 'evil.example'}},
            (res) => { res.resume(); resolve(res.statusCode); }
          );
          req.on('error', reject);
          req.end();
        });
        assert.strictEqual(status, 403);
      });

      await test('unknown routes 404 rather than falling through', async () => {
        assert.strictEqual((await fetch(`${base}/api/nope`)).status, 404);
        assert.strictEqual((await fetch(`${base}/../package.json`)).status, 404);
      });
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmpRoot, {recursive: true, force: true});
    }
  }

  // -------------------------------------------------------------------------
  section('[commit messages]');
  // -------------------------------------------------------------------------
  // The rule is a hook and a CI job for the same reason this file exists: a
  // convention that only lives in a document is not a convention. These cases
  // are the ones the two of them have to agree on.

  await test('a conventional header is accepted, with and without a scope', () => {
    for (const header of [
      'feat: add the release workflow',
      'fix(ui): keep the download link on the status line',
      'ci(release): attach the archive to the tag',
      'refactor(pipeline)!: drop the username parameter'
    ]) {
      const result = checkMessage(header);
      assert.ok(result.ok, `"${header}" was rejected: ${result.reason}`);
      assert.strictEqual(result.header, header);
    }
  });

  await test('every type in the allowlist parses', () => {
    for (const type of TYPES) {
      const result = checkMessage(`${type}: do the thing`);
      assert.ok(result.ok, `${type} was rejected: ${result.reason}`);
    }
    // The list is deliberately closed: a new type is a decision, not a typo.
    assert.ok(!TYPES.includes('feature'));
    assert.ok(!TYPES.includes('wip'));
  });

  await test('a header with no type, an unknown type, or an over-long subject is rejected', () => {
    const cases = [
      ['Add the release workflow', /not `type\(scope\): subject`/],
      ['feature: add the release workflow', /not a type/],
      ['feat add the release workflow', /not `type\(scope\): subject`/],
      ['Feat: add the release workflow', /not `type\(scope\): subject`/],
      ['feat:', /not `type\(scope\): subject`/],
      [`feat: ${'x'.repeat(80)}`, /characters; the limit is 72/],
      ['feat: add the release workflow.', /ends with a period/],
      ['feat: ok', /too short/],
      ['', /the message is empty/]
    ];
    for (const [header, expected] of cases) {
      const result = checkMessage(header);
      assert.ok(!result.ok, `"${header}" was accepted`);
      assert.match(result.reason, expected);
    }
  });

  await test('git comments and trailer paragraphs do not confuse the parser', () => {
    const message = [
      '',
      '# Please enter the commit message for your changes. Lines starting',
      '# with \'#\' will be ignored.',
      'feat(release): attach the source archive to the tag',
      '',
      '# On branch main',
      'Why: a tag with no artifact is just a bookmark.'
    ].join('\n');
    const result = checkMessage(message);
    assert.ok(result.ok, result.reason);
    assert.strictEqual(result.header, 'feat(release): attach the source archive to the tag');
    // A custom commentChar must be honoured rather than assumed.
    assert.strictEqual(subjectOf('; comment\nchore: tidy', ';'), 'chore: tidy');
    assert.strictEqual(subjectOf('# comment\nchore: tidy'), 'chore: tidy');
  });

  await test('merge commits and rebase fixups are exempt', () => {
    for (const header of [
      'Merge branch \'main\' into feature/release',
      'Revert "feat: add the release workflow"',
      'fixup! feat: add the release workflow',
      'squash! feat: add the release workflow'
    ]) {
      const result = checkMessage(header);
      assert.ok(result.ok, `"${header}" was rejected`);
      assert.strictEqual(result.exempt, true, `"${header}" was not marked exempt`);
    }
  });

  // -------------------------------------------------------------------------
  section('[browser codecs]');
  // -------------------------------------------------------------------------
  // The static site (src/build-site.js) replaces node:zlib and node:crypto with
  // these, so "does the bundle pack?" reduces to "are they the same function?".
  // The reference is always the Node builtin, called here in the same process.

  await test('the deflate encoder produces streams zlib can inflate', () => {
    const cases = [
      ['empty', Buffer.alloc(0)],
      ['one byte', Buffer.from([0x41])],
      ['three bytes', Buffer.from('abc')],
      ['ramp', Buffer.from(Array.from({length: 4096}, (_, i) => i & 0xff))],
      ['zeros', Buffer.alloc(70000)],
      ['random', crypto.randomBytes(200000)],
      ['text', Buffer.from('the quick brown fox jumps over the lazy dog\n'.repeat(2000))]
    ];
    for (const [name, input] of cases) {
      const back = zlib.inflateRawSync(deflateRaw(input));
      assert.strictEqual(back.length, input.length, `${name}: length changed`);
      assert.ok(back.equals(input), `${name}: round trip differs`);
    }
    // Repetitive input must actually shrink, or the "compressor" is a copier.
    assert.ok(deflateRaw(Buffer.alloc(100000)).length < 20000);
  });

  await test('the zlib-wrapped encoder round trips through zlib.inflateSync', () => {
    const input = Buffer.from('hello hello hello hello'.repeat(500));
    const packed = deflateZlib(input);
    assert.strictEqual(packed[0], 0x78, 'missing the zlib header');
    assert.ok(zlib.inflateSync(packed).equals(input));
    assert.strictEqual(adler32(Buffer.from('Wikipedia')), 0x11e60398);
  });

  await test('md5 matches node:crypto', () => {
    for (const length of [0, 1, 55, 56, 64, 65, 1000]) {
      const input = crypto.randomBytes(length);
      assert.strictEqual(
        md5CreateHash().update(input).digest('hex'),
        crypto.createHash('md5').update(input).digest('hex'),
        `md5 of ${length} bytes differs`
      );
    }
    // Chunked updates have to concatenate before hashing.
    const chunked = md5CreateHash();
    chunked.update(Buffer.from('hello '));
    chunked.update(Buffer.from('world'));
    assert.strictEqual(chunked.digest('hex'),
      crypto.createHash('md5').update('hello world').digest('hex'));
  });

  await test('the Buffer shim agrees with the real Buffer', () => {
    const text = 'hello world, 你好世界 🌍';
    assert.ok(ShimBuffer.from(text).equals(Buffer.from(text)), 'utf8 encode differs');
    assert.strictEqual(ShimBuffer.from(text).toString(), Buffer.from(text).toString());

    const mine = ShimBuffer.alloc(6);
    const real = Buffer.alloc(6);
    for (const target of [mine, real]) {
      target.writeUInt32LE(0xdeadbeef, 0);
      target.writeUInt16LE(0x1234, 4);
    }
    assert.ok(mine.equals(real), 'writeUInt* differ');
    assert.strictEqual(mine.readUInt32LE(0), real.readUInt32LE(0));
    assert.strictEqual(mine.readUInt16LE(4), real.readUInt16LE(4));

    const big = ShimBuffer.alloc(4);
    big.writeUInt32BE(0x01020304, 0);
    assert.strictEqual(big.toString('hex'), '01020304');

    assert.ok(ShimBuffer.concat([ShimBuffer.from('abc'), ShimBuffer.from('defg')])
      .equals(Buffer.from('abcdefg')), 'concat differs');
    assert.strictEqual(ShimBuffer.from('caf\u00e9', 'latin1').toString('latin1'), 'café');
    assert.strictEqual(ShimBuffer.from('00ff10', 'hex').toString('hex'), '00ff10');
    assert.strictEqual(ShimBuffer.from('AAECAwQ=', 'base64').toString('base64'), 'AAECAwQ=');

    // slice() is a view on Buffer (unlike Uint8Array), and the packing code
    // relies on that when it walks a zip's central directory.
    const view = ShimBuffer.from('abcdef');
    view[0] = 0x7a;
    assert.strictEqual(view.slice(0, 1).toString(), 'z');
  });

  await test('the constant tables the encoder indexes into are the right length', () => {
    // A silent off-by-one here would still inflate, just to the wrong bytes, so
    // the ranges are asserted against the RFC's own numbers.
    assert.strictEqual(LEN_BASE.length, 29);
    assert.strictEqual(LEN_EXTRA.length, 29);
    assert.strictEqual(DIST_BASE.length, 30);
    assert.strictEqual(DIST_EXTRA.length, 30);
    assert.strictEqual(LEN_BASE[28], 258, 'the last length code must be 258');
    assert.strictEqual(DIST_BASE[29], 24577, 'the last distance code must be 24577');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error('suite crashed');
  console.error(error);
  process.exit(1);
});
