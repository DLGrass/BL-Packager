/* Browser-only. Serves the page's three API routes out of a Worker.
 *
 * The packing pipeline is CPU-bound for several seconds on a real project, and a
 * frozen tab with a "打包中…" that never repaints is worse than a slow one. So
 * the work runs in site/worker.js, which importScripts('app.js') -- the same
 * bundle, the same pipeline, just off the main thread.
 *
 * The shape returned here mirrors fetch() closely enough that ui/index.html does
 * not care which one it is talking to; that is what keeps one page serving both
 * the local server and the static site.
 */
(function () {
  'use strict';

  var worker = new Worker('worker.js');
  var pending = new Map();
  var sequence = 0;
  var fatal = null;

  worker.addEventListener('message', function (event) {
    var entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if (event.data.ok) entry.resolve(event.data.result);
    else entry.reject(new Error(event.data.error));
  });

  worker.addEventListener('error', function (event) {
    fatal = new Error(event.message || '打包线程没能加载');
    pending.forEach(function (entry) { entry.reject(fatal); });
    pending.clear();
  });

  var call = function (message, transfer) {
    return new Promise(function (resolve, reject) {
      if (fatal) { reject(fatal); return; }
      var id = ++sequence;
      pending.set(id, {resolve: resolve, reject: reject});
      worker.postMessage(Object.assign({id: id}, message), transfer || []);
    });
  };

  // Blob/File, ArrayBuffer or a typed array -- always a fresh buffer, because
  // the buffer is transferred to the worker and detaching the caller's would be
  // a nasty surprise.
  var toBytes = async function (body) {
    if (!body) return new Uint8Array(0);
    if (typeof body.arrayBuffer === 'function') return new Uint8Array(await body.arrayBuffer());
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) {
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
    }
    throw new Error('不认识的请求体');
  };

  var jsonResponse = function (status, body) {
    return {
      ok: status < 400,
      status: status,
      headers: {get: function () { return null; }},
      json: async function () { return body; },
      text: async function () { return JSON.stringify(body); },
      blob: async function () { throw new Error('this route returns JSON'); }
    };
  };

  var request = async function (url, init) {
    var options = init || {};
    var parsed = new URL(url, location.href);
    var filename = parsed.searchParams.get('filename') || '';

    try {
      if (parsed.pathname === '/api/health') {
        return jsonResponse(200, {
          ok: true,
          browser: true,
          version: window.__BL_VERSION__ || 'dev',
          // The runtime travels inside the bundle, so it is always there.
          scaffolding: {min: true, full: false},
          // Addons are optional and only bundled when the file was present at
          // build time; the page says so instead of failing on pack.
          addons: window.__BL_ADDONS__ !== false,
          msvc: false,
          node: '—'
        });
      }

      if (parsed.pathname === '/api/inspect') {
        var inspected = await toBytes(options.body);
        var result = await call(
          {kind: 'inspect', bytes: inspected, options: {filename: filename}},
          [inspected.buffer]
        );
        return jsonResponse(200, Object.assign({filename: filename}, result));
      }

      if (parsed.pathname === '/api/pack') {
        var bytes = await toBytes(options.body);
        var packed = await call({
          kind: 'pack',
          bytes: bytes,
          // The page hands over the object readOptions() produced, so no option
          // is parsed a second time here from the query string.
          options: Object.assign({filename: filename}, options.options || {})
        }, [bytes.buffer]);

        return {
          ok: true,
          status: 200,
          headers: {
            get: function (name) {
              var key = String(name).toLowerCase();
              if (key === 'x-pack-stats') return encodeURIComponent(JSON.stringify(packed.stats));
              if (key === 'x-pack-filename') return encodeURIComponent(packed.name);
              if (key === 'content-type') return packed.mime;
              return null;
            }
          },
          json: async function () { return {ok: true}; },
          text: async function () { return ''; },
          blob: async function () { return new Blob([packed.output], {type: packed.mime}); }
        };
      }

      if (parsed.pathname === '/api/pack-exe') {
        return jsonResponse(501, {
          ok: false,
          error: 'EXE 目标只能在本机跑：它要 MSVC 编译宿主、还要往 exe/build/ 写文件，' +
            '这两件事静态网站都做不到。'
        });
      }

      return jsonResponse(404, {ok: false, error: '没有这个接口：' + parsed.pathname});
    } catch (error) {
      return jsonResponse(500, {ok: false, error: String((error && error.message) || error)});
    }
  };

  window.__BL_LOCAL__ = {request: request};
  // Recompressing PNGs in the browser buys nothing (the bundled deflate cannot
  // beat the zlib the PNG was written with) and costs about half the total time.
  window.__BL_DEFAULT_OPTIMIZE_PNG__ = false;
})();
