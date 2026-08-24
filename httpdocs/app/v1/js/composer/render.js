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

function paletteColor(scheme, index) {
  const p = paletteFor(scheme);
  return rgbCss(p[Math.max(0, Math.min(p.length - 1, index | 0))]);
}

/** Create an opaque sRGB 2D context (OffscreenCanvas when available). */
export function makeCanvas(width, height) {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', {
    colorSpace: 'srgb',
    willReadFrequently: true,
    alpha: false,
  });
  return { canvas, ctx };
}

function drawPhoto(ctx, layer, bitmap, W, H) {
  if (!bitmap) return;
  const bx = layer.x * W;
  const by = layer.y * H;
  const bw = layer.w * W;
  const bh = layer.h * H;
  const scale = layer.fit === 'cover'
    ? Math.max(bw / bitmap.width, bh / bitmap.height)
    : Math.min(bw / bitmap.width, bh / bitmap.height);
  const dw = bitmap.width * scale;
  const dh = bitmap.height * scale;
  const dx = bx + (bw - dw) / 2;
  const dy = by + (bh - dh) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bx, by, bw, bh);
  ctx.clip();
  ctx.drawImage(bitmap, dx, dy, dw, dh);
  ctx.restore();
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

function drawQr(ctx, layer, scheme, W, H) {
  const { size, modules } = encodeQrMatrix(layer.text, {
    errorCorrectLevel: layer.errorCorrectLevel ?? 'M',
  });
  const boxPx = layer.size * Math.min(W, H);
  // Snap the module size to whole pixels so modules stay crisp on e-paper.
  const modulePx = Math.max(1, Math.floor(boxPx / size));
  const originX = Math.round(layer.x * W);
  const originY = Math.round(layer.y * H);
  const quiet = modulePx * 2;
  ctx.save();
  // QR needs a light quiet zone to scan: paint the background index, not
  // transparency (opaque-pixels rule).
  ctx.fillStyle = paletteColor(scheme, 1);
  ctx.fillRect(originX - quiet, originY - quiet, size * modulePx + quiet * 2, size * modulePx + quiet * 2);
  ctx.fillStyle = paletteColor(scheme, layer.color);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r * size + c]) {
        ctx.fillRect(originX + c * modulePx, originY + r * modulePx, modulePx, modulePx);
      }
    }
  }
  ctx.restore();
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
