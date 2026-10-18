'use strict';

// Images that travel inside the packaged page: the loading-screen picture, the
// custom cursor, and (for the exe) the application icon.
//
// Both are `data:` URLs in the output, so three things have to be true and are
// enforced here rather than trusted:
//
//   * the bytes really are an image that a browser will render — a file with
//     the right extension and the wrong contents becomes a broken `<img>`, and
//     in the exe case an `.ico` that rc.exe cannot parse fails the build;
//   * nothing in the payload can escape the CSS `url("…")` or the `src="…"`
//     it lands in, which is why every URI is re-encoded from bytes instead of
//     being pasted through (a percent-encoded `"` would otherwise be ASCII);
//   * the size is bounded — this is user-supplied data going into a page the
//     user then ships.
//
// Runs in Node and in the browser (src/build-site.js), so: no node builtins.

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif'
};

/** The icon has to be a real .ico: that is what rc.exe's ICON statement takes. */
const ICO_MIME = 'image/x-icon';

const startsWith = (bytes, offset, text) => {
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
};

const asText = (bytes) => {
  const decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
  if (!decoder) return '';
  return decoder.decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
};

/**
 * Identify an image by its contents, not its name.
 * @param {Uint8Array|Buffer} input
 * @returns {string|null} one of the MIME_BY_EXT keys, or null
 */
const sniffImage = (input) => {
  const bytes = input;
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && startsWith(bytes, 1, 'PNG')) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (startsWith(bytes, 0, 'GIF8')) return 'gif';
  if (startsWith(bytes, 0, 'RIFF') && startsWith(bytes, 8, 'WEBP')) return 'webp';
  if (startsWith(bytes, 0, 'BM')) return 'bmp';
  // .ico: reserved=0, type=1 (icon), 1..n images.
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'ico';
  if (startsWith(bytes, 4, 'ftypavif')) return 'avif';
  const head = asText(bytes).replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
};

const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');

/**
 * @param {Uint8Array|Buffer} bytes
 * @param {string} [name] used only in the error message
 * @returns {string} `data:<mime>;base64,…`
 */
const imageDataUri = (bytes, name = 'image') => {
  const kind = sniffImage(bytes);
  if (!kind) {
    throw new Error(`${name} is not an image this packager recognises ` +
      '(png, jpeg, gif, webp, bmp, ico, avif or svg)');
  }
  return `data:${MIME_BY_EXT[kind]};base64,${toBase64(bytes)}`;
};

/** @returns {{mime: string, bytes: Buffer}|null} */
const parseDataUri = (uri) => {
  const match = /^data:([a-z0-9.+/-]+)?((?:;[a-z0-9=-]+)*),(.*)$/is.exec(String(uri || ''));
  if (!match) return null;
  const mime = (match[1] || 'text/plain').toLowerCase();
  const base64 = /;base64/i.test(match[2] || '');
  try {
    const bytes = base64
      ? Buffer.from(match[3], 'base64')
      : Buffer.from(decodeURIComponent(match[3]), 'latin1');
    return {mime, bytes};
  } catch {
    return null;
  }
};

/**
 * Accept a data URI from a web front end and hand back one that is safe to
 * interpolate into HTML/CSS: parsed, size-checked, identified by content, and
 * re-encoded as base64 so no quote or angle bracket can survive.
 *
 * @param {string} uri
 * @param {{maxBytes?: number, name?: string}} [options]
 * @returns {string} the normalised data URI, or '' when there is nothing to do
 */
const normalizeImageDataUri = (uri, options = {}) => {
  if (!uri) return '';
  const {maxBytes = 2 * 1024 * 1024, name = 'image'} = options;
  const parsed = parseDataUri(uri);
  if (!parsed) throw new Error(`${name} is not a valid data: URL`);
  if (parsed.bytes.length > maxBytes) {
    throw new Error(`${name} is ${parsed.bytes.length} bytes; the limit is ${maxBytes}`);
  }
  return imageDataUri(parsed.bytes, name);
};

/** Whether a data URI carries an icon, checked by content. */
const isIconDataUri = (uri) => {
  const parsed = parseDataUri(uri);
  return !!parsed && sniffImage(parsed.bytes) === 'ico';
};

module.exports = {
  MIME_BY_EXT,
  ICO_MIME,
  sniffImage,
  imageDataUri,
  parseDataUri,
  normalizeImageDataUri,
  isIconDataUri,
  EXT_MIME: MIME_BY_EXT
};
