/*
 * render.js — composite a document onto a canvas at panel resolution
 * (DESIGN_WEB_OD_APP_PLAN.md §6).
 *
 * Pure geometry + drawing: no IndexedDB, no BLE. Photo assets arrive as
 * already-decoded ImageBitmaps (main thread resolves them; the worker never
 * opens storage). Every context is created with an explicit sRGB color space
 * and OPAQUE pixels — the M-S(a) spike proved that transparent pixels read
 * back as RGB 0 from the premultiplied backing store and would encode as
 * black.
 */
import { artboardSize } from './model.js';
import { encodeQrMatrix } from './qr.js';

/** Ideal wire palettes, index order = dither palette order per scheme.
 *  These are the same canonical values the encoder classifies exactly
 *  (proven byte-identical to py-opendisplay in tests/webapp). */
export const IDEAL_PALETTES = {
  0: [[0, 0, 0], [255, 255, 255]],
  1: [[0, 0, 0], [255, 255, 255], [255, 0, 0]],
  2: [[0, 0, 0], [255, 255, 255], [255, 255, 0]],
  3: [[0, 0, 0], [255, 255, 255], [255, 255, 0], [255, 0, 0]],
  4: [[0, 0, 0], [255, 255, 255], [255, 255, 0], [255, 0, 0], [0, 0, 255], [0, 255, 0]],
  5: [[0, 0, 0], [85, 85, 85], [170, 170, 170], [255, 255, 255]],
  6: Array.from({ length: 16 }, (_, i) => [i * 17, i * 17, i * 17]),
  8: [[0, 0, 0], [255, 255, 255], [255, 255, 0], [255, 0, 0], [0, 0, 255], [0, 255, 0]],
};

export function paletteFor(colorScheme) {
  const p = IDEAL_PALETTES[colorScheme];
  if (!p) throw new Error(`unsupported color scheme ${colorScheme}`);
  return p;
}

function rgbCss([r, g, b]) {
  return `rgb(${r},${g},${b})`;
}

/** Relative luminance 0..1 of a palette entry. */
function luma([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Darkest ink in a scheme — index 0 in every supported palette. */
export function darkestIndex() {
  return 0;
}

/**
 * Lightest ink. NOT always index 1: the grey schemes run dark→light, so white
 * is the LAST entry there (index 1 is dark grey, which would make a useless
 * QR quiet zone).
 */
export function lightestIndex(scheme) {
  const p = paletteFor(scheme);
  let best = 0;
  for (let i = 1; i < p.length; i++) if (luma(p[i]) > luma(p[best])) best = i;
  return best;
}

/** Minimum module-vs-quiet-zone luminance gap for a scannable QR. */
export const QR_MIN_CONTRAST = 0.4;

function paletteColor(scheme, index) {
  const p = paletteFor(scheme);
  const i = index | 0;
  if (i < 0 || i >= p.length) {
    // Clamping would silently draw the wrong ink (e.g. "Blue" on a mono
    // panel); the UI only offers legal indices, so this is a real bug.
    throw new Error(`palette index ${index} is not valid for colour scheme ${scheme}`);
  }
  return rgbCss(p[i]);
}

/** Create an opaque sRGB 2D context (OffscreenCanvas when available). */
export function makeCanvas(width, height, { alpha = false } = {}) {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', {
    colorSpace: 'srgb',
    willReadFrequently: true,
    alpha,
  });
  return { canvas, ctx };
}

/**
 * Per-photo tonal adjustments, applied in place to RGBA bytes.
 * Pure and exported so it is unit-testable without a canvas.
 *  exposure   multiplicative gain (1 = unchanged)
 *  saturation 0 = greyscale, 1 = unchanged, >1 = more saturated
 *  shadows    0..1 lifts dark tones
 *  highlights 0..1 pulls bright tones down
 * Source ALPHA IS PRESERVED: a transparent PNG must keep revealing the layers
 * beneath it after an adjustment. (Document-level tone/gamut are pre-dither
 * pipeline parameters handed to the wasm dither in M3.)
 */
export function applyAdjustments(data, adj) {
  const exposure = adj?.exposure ?? 1;
  const saturation = adj?.saturation ?? 1;
  const shadows = adj?.shadows ?? 0;
  const highlights = adj?.highlights ?? 0;
  if (exposure === 1 && saturation === 1 && shadows === 0 && highlights === 0) return data;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] * exposure;
    let g = data[i + 1] * exposure;
    let b = data[i + 2] * exposure;

    if (saturation !== 1) {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = y + (r - y) * saturation;
      g = y + (g - y) * saturation;
      b = y + (b - y) * saturation;
    }
    if (shadows !== 0 || highlights !== 0) {
      const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      // Weight each control by how dark / bright the pixel already is.
      const lift = shadows * 255 * Math.max(0, 1 - y * 2) * 0.5;
      const pull = highlights * 255 * Math.max(0, y * 2 - 1) * 0.5;
      r += lift - pull; g += lift - pull; b += lift - pull;
    }
    data[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    // alpha untouched: adjusting must not turn transparency into black
  }
  return data;
}

function drawPhoto(ctx, layer, bitmap, W, H) {
  if (!bitmap) return;
  const bx = Math.round(layer.x * W);
  const by = Math.round(layer.y * H);
  const bw = Math.max(1, Math.round(layer.w * W));
  const bh = Math.max(1, Math.round(layer.h * H));
  const scale = layer.fit === 'cover'
    ? Math.max(bw / bitmap.width, bh / bitmap.height)
    : Math.min(bw / bitmap.width, bh / bitmap.height);
  const dw = bitmap.width * scale;
  const dh = bitmap.height * scale;
  const dx = bx + (bw - dw) / 2;
  const dy = by + (bh - dh) / 2;

  const adj = layer.adjustments;
  const needsAdjust = adj && (
    (adj.exposure ?? 1) !== 1 || (adj.saturation ?? 1) !== 1 ||
    (adj.shadows ?? 0) !== 0 || (adj.highlights ?? 0) !== 0
  );

  if (!needsAdjust) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.clip();
    ctx.drawImage(bitmap, dx, dy, dw, dh);
    ctx.restore();
    return;
  }

  // Adjust off-screen at the layer's box size, then composite: keeps the pixel
  // math bounded by the layer rather than the whole panel. The scratch canvas
  // MUST keep its alpha channel, or transparent regions of the source would
  // composite over black and hide the layers underneath.
  const { canvas: tmp, ctx: tctx } = makeCanvas(bw, bh, { alpha: true });
  tctx.drawImage(bitmap, dx - bx, dy - by, dw, dh);
  const img = tctx.getImageData(0, 0, bw, bh);
  applyAdjustments(img.data, adj);
  tctx.putImageData(img, 0, 0);
  ctx.drawImage(tmp, bx, by); // alpha-blended onto the opaque composite
}

function drawStroke(ctx, layer, scheme, W, H) {
  if (layer.points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = paletteColor(scheme, layer.color);
  ctx.lineWidth = Math.max(1, layer.width * Math.min(W, H));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(layer.points[0].x * W, layer.points[0].y * H);
  for (const p of layer.points.slice(1)) ctx.lineTo(p.x * W, p.y * H);
  ctx.stroke();
  ctx.restore();
}

function drawText(ctx, layer, scheme, W, H) {
  const px = Math.max(6, layer.size * H);
  ctx.save();
  ctx.fillStyle = paletteColor(scheme, layer.color);
  ctx.font = `${px}px sans-serif`;
  ctx.textAlign = layer.align ?? 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(layer.text, layer.x * W, layer.y * H);
  ctx.restore();
}

/** QR quiet zone required by the spec, in modules, on every side. */
export const QR_QUIET_MODULES = 4;

/**
 * Geometry for a QR layer — the SINGLE source of truth shared by rendering and
 * hit-testing, so the interactive box always matches the drawn block.
 *
 * layer.size is the requested block side as a fraction of min(W, H) and
 * INCLUDES the quiet zone. Module size is snapped to whole pixels for crisp
 * edges; the resulting block is clamped inside the artboard so the quiet zone
 * can never be clipped (a clipped quiet zone is the classic unscannable QR).
 */
export function qrGeometry(layer, W, H) {
  const { size, modules } = encodeQrMatrix(layer.text, {
    errorCorrectLevel: layer.errorCorrectLevel ?? 'M',
  });
  const totalModules = size + QR_QUIET_MODULES * 2;
  const requestedPx = (layer.size ?? 0.3) * Math.min(W, H);
  // Never smaller than 1 device pixel per module, and never bigger than the
  // artboard — a QR that does not fit whole cannot be made to scan.
  const maxModulePx = Math.floor(Math.min(W, H) / totalModules);
  if (maxModulePx < 1) {
    // Even at one pixel per module the code plus its quiet zone exceeds the
    // panel. Rendering it anyway would clip the quiet zone and produce an
    // unscannable block, so fail loudly instead.
    throw new Error(
      `QR needs ${totalModules}px minimum (incl. quiet zone) but the panel is ` +
      `${Math.min(W, H)}px on its short side — shorten the text or LOWER the ` +
      'error-correction level (higher ECC needs a bigger code)',
    );
  }
  const modulePx = Math.min(Math.max(1, Math.floor(requestedPx / totalModules)), maxModulePx);
  const blockPx = totalModules * modulePx;

  // Clamp the WHOLE block (quiet zone included) inside the artboard.
  const x = Math.round(Math.max(0, Math.min(W - blockPx, layer.x * W)));
  const y = Math.round(Math.max(0, Math.min(H - blockPx, layer.y * H)));

  return {
    size, modules, modulePx, blockPx,
    x, y,
    // Where the dark modules start (inside the quiet zone).
    codeX: x + QR_QUIET_MODULES * modulePx,
    codeY: y + QR_QUIET_MODULES * modulePx,
  };
}

/**
 * A QR only scans if its modules contrast with the quiet zone. White-on-white
 * (and yellow-on-white) are silently unscannable, so reject them outright.
 */
export function assertQrContrast(layer, scheme) {
  const palette = paletteFor(scheme);
  const ink = palette[layer.color | 0];
  if (!ink) throw new Error(`palette index ${layer.color} is not valid for colour scheme ${scheme}`);
  const quiet = palette[lightestIndex(scheme)];
  const delta = Math.abs(luma(quiet) - luma(ink));
  if (delta < QR_MIN_CONTRAST) {
    throw new Error(
      `QR ink is too light to scan against its quiet zone (contrast ${delta.toFixed(2)} ` +
      `< ${QR_MIN_CONTRAST}) — use a darker colour`,
    );
  }
}

function drawQr(ctx, layer, scheme, W, H) {
  const g = qrGeometry(layer, W, H);
  assertQrContrast(layer, scheme);
  ctx.save();
  // The quiet zone must be light and OPAQUE (never transparent) or the code
  // will not scan. Index 1 is NOT always the lightest ink — on the grey
  // schemes it is dark grey.
  ctx.fillStyle = paletteColor(scheme, lightestIndex(scheme));
  ctx.fillRect(g.x, g.y, g.blockPx, g.blockPx);
  ctx.fillStyle = paletteColor(scheme, layer.color);
  for (let r = 0; r < g.size; r++) {
    for (let c = 0; c < g.size; c++) {
      if (g.modules[r * g.size + c]) {
        ctx.fillRect(g.codeX + c * g.modulePx, g.codeY + r * g.modulePx, g.modulePx, g.modulePx);
      }
    }
  }
  ctx.restore();
}

/**
 * Validate a document WITHOUT drawing it: every QR must fit its artboard and
 * contrast with its quiet zone, and every ink index must exist in the panel's
 * palette. Sessions run this BEFORE committing an edit, so an invalid layer
 * can never enter the history or be autosaved.
 * @throws {Error} describing the first problem found
 */
export function validateDocument(doc) {
  const { width: W, height: H } = artboardSize(doc.panel);
  const scheme = doc.panel.colorScheme;
  const palette = paletteFor(scheme);
  const checkInk = (index, what) => {
    if (!(index >= 0 && index < palette.length)) {
      throw new Error(`${what}: colour ${index} is not valid for scheme ${scheme}`);
    }
  };
  checkInk(doc.background ?? 1, 'background');
  for (const layer of doc.layers) {
    switch (layer.type) {
      case 'qr':
        checkInk(layer.color, 'QR');
        assertQrContrast(layer, scheme);
        qrGeometry(layer, W, H); // throws when it cannot fit
        break;
      case 'text': checkInk(layer.color, 'text'); break;
      case 'stroke': checkInk(layer.color, 'stroke'); break;
      default: break;
    }
  }
  return doc;
}

/**
 * Composite a document at panel resolution.
 * @param {object} doc composer document
 * @param {Map<string, ImageBitmap>} bitmaps assetId -> decoded bitmap
 * @returns {{canvas: any, ctx: any, width: number, height: number}}
 */
export function renderDocument(doc, bitmaps = new Map()) {
  const { width: W, height: H } = artboardSize(doc.panel);
  const scheme = doc.panel.colorScheme;
  const { canvas, ctx } = makeCanvas(W, H);

  // Opaque background first: no pixel may ever be left transparent.
  ctx.fillStyle = paletteColor(scheme, doc.background ?? 1);
  ctx.fillRect(0, 0, W, H);

  for (const layer of doc.layers) {
    switch (layer.type) {
      case 'photo': drawPhoto(ctx, layer, bitmaps.get(layer.assetId), W, H); break;
      case 'stroke': drawStroke(ctx, layer, scheme, W, H); break;
      case 'text': drawText(ctx, layer, scheme, W, H); break;
      case 'qr': drawQr(ctx, layer, scheme, W, H); break;
      default: throw new Error(`unknown layer type ${layer.type}`);
    }
  }
  return { canvas, ctx, width: W, height: H };
}
