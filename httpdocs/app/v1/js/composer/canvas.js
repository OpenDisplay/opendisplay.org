/*
 * canvas.js — interactive editing surface (DESIGN_WEB_OD_APP_PLAN.md §6).
 * Pointer input in CSS pixels is converted to normalized 0…1 artboard
 * coordinates; the display canvas is a scaled preview of the panel-resolution
 * render. Main thread only (pointer + DOM).
 */

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

/** Hit-test layers topmost-first; returns the layer id or null. */
export function hitTest(doc, { x, y }, { W, H }) {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    if (l.type === 'photo') {
      if (x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) return l.id;
    } else if (l.type === 'text') {
      // Approximate box: text is drawn from (x, y) with size as line height.
      const w = Math.min(1, l.text.length * l.size * 0.55 * (H / W));
      if (x >= l.x && x <= l.x + w && y >= l.y && y <= l.y + l.size) return l.id;
    } else if (l.type === 'qr') {
      const side = l.size * Math.min(W, H);
      if (x >= l.x && x <= l.x + side / W && y >= l.y && y <= l.y + side / H) return l.id;
    } else if (l.type === 'stroke') {
      const tol = Math.max(l.width, 0.02);
      if (l.points.some((p) => Math.abs(p.x - x) < tol && Math.abs(p.y - y) < tol)) return l.id;
    }
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
