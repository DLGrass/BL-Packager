'use strict';

// The browser front end: exactly the calls ui/server.js makes, minus the HTTP
// hop. Bundled into site/app.js by src/build-site.js and run inside a Worker.
//
// It deliberately does not re-derive any option: the page hands it the object
// readOptions() already produced, the same object the server would have received
// as a query string, and it forwards the render options through
// pipeline.pickRenderOptions so the "which keys reach the renderer" list is still
// written in one place.

const safeFileName = (name) =>
  String(name).replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/^\.+/, '').trim() || 'project';

const basenameOf = (value) => String(value).split(/[\\/]/).pop();

const createClient = (deps) => {
  const {pipeline, version} = deps;

  /**
   * The 载入作品 step: parse only. PNG recompression stays off, exactly as in
   * the server path -- it is the expensive half and its result is thrown away
   * here.
   */
  const inspect = (bytes, options = {}) => {
    const started = Date.now();
    let warning = null;
    const info = pipeline.inspectProject(bytes, {
      fullRuntime: !!options.fullRuntime,
      onWarn: (message) => { warning = message; }
    });

    return {
      ok: true,
      ms: Date.now() - started,
      filename: options.filename || '',
      warning,
      analysis: info.analysis,
      byExtension: info.byExtension,
      scaffolding: info.scaffolding,
      scaffoldingAvailable: info.scaffoldingAvailable
    };
  };

  /**
   * The packing step. Same option mapping as ui/server.js's handlePack, so a
   * project packed here and the same project packed by the CLI differ only in
   * what the encoder can do (see README: the browser brings its own deflate).
   *
   * Returns the bytes and their MIME type rather than an html string, because
   * there are now two shapes of output: a page, and a zip that has to be served.
   */
  const pack = (bytes, options = {}) => {
    const started = Date.now();
    const title = options.title || '';
    const target = options.target === 'zip' ? 'zip' : 'html';
    const mode = options.mode === 'tw' ? 'tw' : 'fast';
    const extensions = Array.isArray(options.extensions) ? options.extensions : [];
    const resolvedTitle = safeFileName(title || pipeline.defaultTitle(options.filename || ''));

    const common = Object.assign({
      inputPath: options.filename || '',
      title,
      extensions,
      preload: !!options.preload,
      noDeflate: !!options.noDeflate,
      optimizePng: options.optimizePng !== false,
      onWarn: () => {}
    }, pipeline.pickRenderOptions(options));

    if (target === 'zip') {
      const zipped = pipeline.packToZip(bytes, common);
      return {
        ok: true,
        name: `${resolvedTitle}.zip`,
        mime: 'application/zip',
        output: zipped.zip,
        stats: {
          title: title || pipeline.defaultTitle(options.filename || ''),
          target,
          zipBytes: zipped.zip.length,
          htmlBytes: zipped.html.length,
          entries: zipped.entries.length,
          scaffolding: basenameOf(zipped.scaffoldingSource),
          project: zipped.project.analysis,
          ms: Date.now() - started
        }
      };
    }

    const packed = pipeline.packToHtml(bytes, Object.assign({mode}, common));
    const name = mode === 'tw' ? `${resolvedTitle}.tw.html` : `${resolvedTitle}.html`;

    return {
      ok: true,
      name,
      mime: 'text/html; charset=utf-8',
      output: packed.html,
      stats: {
        title: title || pipeline.defaultTitle(options.filename || ''),
        mode,
        htmlBytes: packed.html.length,
        chunks: packed.stats.chunks,
        payloadBytes: packed.payloadBytes,
        deflatedEntries: packed.deflatedEntries,
        scaffolding: basenameOf(packed.scaffoldingSource),
        container: packed.containerStats,
        project: packed.project.analysis,
        ms: Date.now() - started
      }
    };
  };

  return {inspect, pack, version, safeFileName};
};

module.exports = {createClient, safeFileName};
