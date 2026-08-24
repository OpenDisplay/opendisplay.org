/*
 * image-size.js — read an image's pixel dimensions from its HEADER.
 *
 * Why not just decode it: `createImageBitmap(blob)` allocates the full-size
 * bitmap before any resize option can shrink it, so a 48-megapixel phone photo
 * costs hundreds of megabytes at peak — on the device most likely to be a
 * phone. Knowing the dimensions up front lets the caller ask for a bounded
 * decode in ONE step.
 *
 * Only the containers a browser will hand us from a file picker are parsed;
 * anything else returns null and the caller falls back to a safe single-axis
 * cap (which preserves aspect ratio and still bounds the wider dimension).
 */

const HEADER_BYTES = 64 * 1024; // enough for JPEG SOF markers after EXIF

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

/**
 * Decode `blob` so its longest side is at most `cap`, in ONE decode — never
 * allocating the full-size bitmap first. Aspect ratio is preserved and small
 * images are never upscaled.
 */
export async function decodeBounded(blob, cap, { imageOrientation = 'from-image' } = {}) {
  const size = await readImageSize(blob).catch(() => null);
  if (size && size.width > 0 && size.height > 0) {
    const longest = Math.max(size.width, size.height);
    if (longest <= cap) return createImageBitmap(blob, { imageOrientation });
    const scale = cap / longest;
    return createImageBitmap(blob, {
      imageOrientation,
      resizeWidth: Math.max(1, Math.round(size.width * scale)),
      resizeHeight: Math.max(1, Math.round(size.height * scale)),
      resizeQuality: 'high',
    });
  }
  // Unknown container: cap ONE axis. Aspect ratio is preserved, so the other
  // axis is bounded by the image's aspect rather than unbounded.
  return createImageBitmap(blob, { imageOrientation, resizeWidth: cap, resizeQuality: 'high' });
}
