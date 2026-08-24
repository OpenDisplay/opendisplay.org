/*
 * image-size.js — read an image's pixel dimensions from its HEADER.
 *
 * Why not just decode it: `createImageBitmap(blob)` allocates the full-size
 * bitmap before any resize option can shrink it, so a 48-megapixel phone photo
 * costs hundreds of megabytes at peak — on the device most likely to be a
 * phone. Knowing the dimensions up front lets the caller ask for a bounded
 * decode in ONE step.
 *
 * Formats whose dimensions we cannot read are REFUSED rather than decoded
 * hopefully: a single-axis `resizeWidth` cap does not bound the longest side
 * of a tall image and would upscale a narrow one, which is exactly the
 * unbounded allocation this module exists to prevent.
 */

const HEADER_BYTES = 64 * 1024; // enough for JPEG SOF markers after EXIF

/** Sources beyond this are refused outright on browsers that DO honour the
 *  resize options (the decode is bounded, so this is only a sanity limit). */
export const MAX_SOURCE_MEGAPIXELS = 60;

/** Much lower limit where resize options are ignored: there the FULL bitmap is
 *  allocated before anything can check it, so ~12 MP (≈48 MB at 4 bytes/px) is
 *  the most that can be attempted without risking the tab. */
export const MAX_SOURCE_MEGAPIXELS_UNBOUNDED = 12;

/**
 * Does createImageBitmap actually honour resizeWidth/resizeHeight? WebKit
 * (and therefore Bluefy on iOS) ignores them silently. Probed ONCE with a
 * 2×2 fixture so the answer costs nothing.
 */
let resizeSupport = null;
export async function supportsBitmapResize() {
  if (resizeSupport !== null) return resizeSupport;
  try {
    const probe = new ImageData(new Uint8ClampedArray(2 * 2 * 4).fill(255), 2, 2);
    const src = await createImageBitmap(probe);
    const out = await createImageBitmap(src, { resizeWidth: 1, resizeHeight: 1 });
    resizeSupport = out.width === 1 && out.height === 1;
    src.close?.();
    out.close?.();
  } catch {
    resizeSupport = false;
  }
  return resizeSupport;
}

/** Test seam. */
export function _resetResizeSupport() {
  resizeSupport = null;
}

export async function readImageSize(blob) {
  const head = new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer());
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return png(head, view) ?? jpeg(head, view) ?? gif(head, view) ?? webp(head, view) ?? null;
}

function png(b, view) {
  // 89 50 4E 47 0D 0A 1A 0A, then IHDR with width/height as big-endian u32.
  if (b.length < 24) return null;
  if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpeg(b, view) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < b.length) {
    if (b[off] !== 0xff) { off++; continue; }         // resync on padding
    const marker = b[off + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    const len = view.getUint16(off + 2);
    // SOF0..SOF15 carry the frame size; SOF4/8/12 are not frame headers.
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: view.getUint16(off + 5), width: view.getUint16(off + 7) };
    }
    if (len < 2) return null;
    off += 2 + len;
  }
  return null;
}

function gif(b, view) {
  if (b.length < 10) return null;
  if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null;
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function webp(b, view) {
  // RIFF....WEBP then VP8 / VP8L / VP8X.
  if (b.length < 30) return null;
  const tag = (i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return null;
  const chunk = tag(12);
  if (chunk === 'VP8X') {
    const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
    const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
    return { width: w, height: h };
  }
  if (chunk === 'VP8 ') {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** Formats this module can measure, and therefore the formats the app accepts. */
export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export class UnsupportedImageError extends Error {
  constructor() {
    super('Unsupported image format — use PNG, JPEG, GIF or WebP');
    this.name = 'UnsupportedImageError';
  }
}

/**
 * Decode `blob` so its longest side is at most `cap`, in ONE decode — never
 * allocating the full-size bitmap first. Aspect ratio is preserved and small
 * images are never upscaled.
 *
 * @throws {UnsupportedImageError} when the dimensions cannot be read, because
 *   there is then no way to bound the decode. Failing closed beats decoding a
 *   50-megapixel AVIF at full size on a phone.
 */
export async function decodeBounded(blob, cap, { imageOrientation = 'from-image' } = {}) {
  const size = await readImageSize(blob).catch(() => null);
  if (!size || !(size.width > 0) || !(size.height > 0)) {
    throw new UnsupportedImageError();
  }
  const longest = Math.max(size.width, size.height);
  const megapixels = (size.width * size.height) / 1e6;

  // Refuse absurd sources BEFORE decoding. Where the browser ignores the
  // resize options the full bitmap is allocated first, so the limit there must
  // be far lower — closing it afterwards cannot prevent an out-of-memory.
  const needsDownscale = longest > cap;
  const bounded = !needsDownscale || await supportsBitmapResize();
  const limit = bounded ? MAX_SOURCE_MEGAPIXELS : MAX_SOURCE_MEGAPIXELS_UNBOUNDED;
  if (megapixels > limit) throw new ImageTooLargeError(Math.round(megapixels));

  if (!needsDownscale) return createImageBitmap(blob, { imageOrientation });

  const scale = cap / longest;
  const targetW = Math.max(1, Math.round(size.width * scale));
  const targetH = Math.max(1, Math.round(size.height * scale));

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, {
      imageOrientation, resizeWidth: targetW, resizeHeight: targetH, resizeQuality: 'high',
    });
  } catch {
    bitmap = await createImageBitmap(blob, { imageOrientation });
  }
  // WebKit (and therefore Bluefy on iOS) ignores the resize options rather
  // than throwing, so VERIFY the result instead of trusting it: an ignored
  // resize would hand the worker a full-resolution bitmap.
  if (bitmap.width === targetW && bitmap.height === targetH) return bitmap;
  return downscaleViaCanvas(bitmap, targetW, targetH);
}

export class ImageTooLargeError extends Error {
  constructor(px) {
    super(`Image is too large for this browser to resize safely (${px} megapixels)`);
    this.name = 'ImageTooLargeError';
  }
}

/**
 * Portable fallback when createImageBitmap's resize options are unavailable.
 * FAILS CLOSED: if the downscale cannot be done, the oversized bitmap is
 * closed and rejected rather than handed to the proxy or the worker cache —
 * returning it would reinstate exactly the unbounded allocation this module
 * exists to prevent.
 */
async function downscaleViaCanvas(bitmap, targetW, targetH) {
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(targetW, targetH)
      : Object.assign(document.createElement('canvas'), { width: targetW, height: targetH });
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    const scaled = await createImageBitmap(canvas);
    bitmap.close?.();
    return scaled;
  } catch (err) {
    const px = Math.round((bitmap.width * bitmap.height) / 1e6);
    bitmap.close?.();
    throw new ImageTooLargeError(px);
  }
}
