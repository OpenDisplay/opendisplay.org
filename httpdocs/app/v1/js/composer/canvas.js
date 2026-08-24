/*
 * canvas.js — interactive editing surface (DESIGN_WEB_OD_APP_PLAN.md §6).
 * Pointer input in CSS pixels is converted to normalized 0…1 artboard
 * coordinates; the display canvas is a scaled preview of the panel-resolution
 * render. Main thread only (pointer + DOM).
 */

import { qrGeometry } from './render.js';

export function makeSurface(canvasEl, { onPointerDown, onPointerMove, onPointerUp }) {
  let dragging = false;

  const toNorm = (ev) => {
    const rect = canvasEl.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height)),
    };
  };

  canvasEl.addEventListener('pointerdown', (ev) => {
    dragging = true;
    canvasEl.setPointerCapture(ev.pointerId);
    onPointerDown?.(toNorm(ev), ev);
  });
  canvasEl.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    onPointerMove?.(toNorm(ev), ev);
  });
  const end = (ev) => {
    if (!dragging) return;
    dragging = false;
    try { canvasEl.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    onPointerUp?.(toNorm(ev), ev);
  };
  canvasEl.addEventListener('pointerup', end);
  canvasEl.addEventListener('pointercancel', end);

  return { toNorm };
}

/**
 * Normalized bounding box of a layer as it is actually RENDERED — the single
 * geometry source shared by hit-testing and drag clamping, so the interactive
 * box always matches what the user sees.
 * @returns {{x:number,y:number,w:number,h:number}|null} null for strokes,
 *          whose extent is derived from their points.
 */
export function layerBounds(layer, { W, H }) {
  switch (layer.type) {
    case 'photo':
      return { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
    case 'text': {
      // Advance width ≈ 0.55 em for sans-serif; size is a fraction of H.
      const w = Math.min(1, layer.text.length * layer.size * 0.55 * (H / W));
      const h = layer.size;
      // Alignment shifts the drawn box relative to the anchor point.
      const align = layer.align ?? 'left';
      const x = align === 'center' ? layer.x - w / 2 : align === 'right' ? layer.x - w : layer.x;
      return { x, y: layer.y, w, h };
    }
    case 'qr': {
      const g = qrGeometry(layer, W, H);
      return { x: g.x / W, y: g.y / H, w: g.blockPx / W, h: g.blockPx / H };
    }
    case 'stroke': {
      if (!layer.points.length) return null;
      const xs = layer.points.map((p) => p.x);
      const ys = layer.points.map((p) => p.y);
      return {
        x: Math.min(...xs), y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
      };
    }
    default:
      return null;
  }
}

/** Shortest distance from a point to a line segment (normalized units). */
function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Hit-test layers topmost-first; returns the layer id or null. */
export function hitTest(doc, { x, y }, size) {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    if (l.type === 'stroke') {
      // Distance to the SEGMENTS, not just the sampled vertices: a long
      // straight stroke has few points but is clickable along its length.
      const tol = Math.max(l.width, 0.02);
      for (let j = 1; j < l.points.length; j++) {
        if (distToSegment({ x, y }, l.points[j - 1], l.points[j]) <= tol) return l.id;
      }
      if (l.points.length === 1 && Math.hypot(l.points[0].x - x, l.points[0].y - y) <= tol) return l.id;
      continue;
    }
    const b = layerBounds(l, size);
    if (b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return l.id;
  }
  return null;
}

/** Paint a panel-resolution render into the visible preview canvas. */
export function blitPreview(previewEl, sourceCanvas, { width, height }) {
  previewEl.width = width;
  previewEl.height = height;
  const ctx = previewEl.getContext('2d', { colorSpace: 'srgb', alpha: false });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sourceCanvas, 0, 0);
}
