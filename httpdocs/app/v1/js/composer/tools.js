/*
 * tools.js — composer tool behaviours (DESIGN_WEB_OD_APP_PLAN.md §6).
 * Pure state transitions over the document model: each tool turns pointer
 * events into layer mutations. Kept DOM-free so it is unit-testable.
 */
import { addLayer, updateLayer, strokeLayer, textLayer, qrLayer, photoLayer } from './model.js';
import { hitTest, layerBounds } from './canvas.js';

/**
 * Clamp a layer origin so its RENDERED extent stays on the artboard — moving
 * by origin alone would let a photo or QR slide almost entirely off-canvas.
 * A layer larger than the artboard is pinned at 0 rather than pushed negative.
 */
function clampOrigin(layer, x, y, size) {
  const b = layerBounds({ ...layer, x, y }, size);
  const w = b?.w ?? 0;
  const h = b?.h ?? 0;
  // layerBounds already accounts for text alignment / QR quiet zone, so the
  // offset between the anchor and the drawn box is preserved here.
  const offX = (b?.x ?? x) - x;
  const offY = (b?.y ?? y) - y;
  const maxX = Math.max(0, 1 - w);
  const maxY = Math.max(0, 1 - h);
  return {
    x: Math.max(-offX, Math.min(maxX - offX, x)),
    y: Math.max(-offY, Math.min(maxY - offY, y)),
  };
}

/** Freehand drawing: down starts a stroke, move extends it, up commits. */
export function makeDrawTool({ color = 0, width = 0.01 } = {}) {
  let activeId = null;
  return {
    name: 'draw',
    onDown(doc, pt) {
      const layer = strokeLayer({ points: [pt], color, width });
      activeId = layer.id;
      return { doc: addLayer(doc, layer), commit: false };
    },
    onMove(doc, pt) {
      if (!activeId) return { doc, commit: false };
      const layer = doc.layers.find((l) => l.id === activeId);
      if (!layer) return { doc, commit: false };
      const last = layer.points.at(-1);
      // Drop sub-pixel jitter: keeps stroke arrays small for the undo stack.
      if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 0.002) return { doc, commit: false };
      return { doc: updateLayer(doc, activeId, { points: [...layer.points, pt] }), commit: false };
    },
    onUp(doc) {
      const done = activeId;
      activeId = null;
      // Discard a stray tap that produced no line.
      const layer = doc.layers.find((l) => l.id === done);
      if (layer && layer.points.length < 2) {
        return { doc: { ...doc, layers: doc.layers.filter((l) => l.id !== done) }, commit: false };
      }
      return { doc, commit: true };
    },
    setColor(c) { color = c; },
    setWidth(w) { width = w; },
  };
}

/**
 * Select/move. `selectedId` PERSISTS after pointer-up (the Delete button acts
 * on it); `dragId` is the transient gesture target and is cleared on up.
 */
export function makeSelectTool({ onSelect } = {}) {
  let selectedId = null;
  let dragId = null;
  let grab = null;
  let strokeDrag = null; // {origin, points} — strokes move by translation
  let moved = false;
  return {
    name: 'select',
    onDown(doc, pt, size) {
      const hit = hitTest(doc, pt, size);
      selectedId = hit;
      dragId = hit;
      moved = false;
      strokeDrag = null;
      grab = null;
      onSelect?.(selectedId);
      if (!dragId) return { doc, commit: false };
      const layer = doc.layers.find((l) => l.id === dragId);
      if (layer.type === 'stroke') {
        // A stroke has no origin — remember where the drag started and the
        // points it started from, then translate the whole polyline.
        strokeDrag = { origin: pt, points: layer.points.map((p) => ({ ...p })) };
      } else {
        grab = { dx: pt.x - (layer.x ?? 0), dy: pt.y - (layer.y ?? 0) };
      }
      return { doc, commit: false };
    },
    onMove(doc, pt, size) {
      if (!dragId) return { doc, commit: false };
      const layer = doc.layers.find((l) => l.id === dragId);
      if (!layer) return { doc, commit: false };

      if (layer.type === 'stroke') {
        if (!strokeDrag) return { doc, commit: false };
        const xs = strokeDrag.points.map((p) => p.x);
        const ys = strokeDrag.points.map((p) => p.y);
        // Clamp the translation so the whole polyline stays on the artboard.
        const dx = Math.max(-Math.min(...xs), Math.min(1 - Math.max(...xs), pt.x - strokeDrag.origin.x));
        const dy = Math.max(-Math.min(...ys), Math.min(1 - Math.max(...ys), pt.y - strokeDrag.origin.y));
        if (dx === 0 && dy === 0) return { doc, commit: false };
        moved = true;
        return {
          doc: updateLayer(doc, dragId, {
            points: strokeDrag.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
          }),
          commit: false,
        };
      }

      if (!grab) return { doc, commit: false };
      const next = clampOrigin(layer, pt.x - grab.dx, pt.y - grab.dy, size);
      if (next.x === layer.x && next.y === layer.y) return { doc, commit: false };
      moved = true;
      return { doc: updateLayer(doc, dragId, next), commit: false };
    },
    onUp(doc) {
      const didMove = moved;
      dragId = null;
      grab = null;
      strokeDrag = null;
      moved = false;
      // Commit only if the layer actually moved: a plain click selects
      // without polluting the undo stack.
      return { doc, commit: didMove };
    },
    selectedId() { return selectedId; },
    setSelection(id) { selectedId = id; onSelect?.(id); },
    clearSelection() { selectedId = null; onSelect?.(null); },
  };
}

/** Placement tools: a single click drops a text/QR/photo layer. */
export function placeText(doc, pt, { text, size = 0.08, color = 0 }) {
  return addLayer(doc, textLayer({ text, x: pt.x, y: pt.y, size, color }));
}

export function placeQr(doc, pt, { text, size = 0.3, color = 0, errorCorrectLevel = 'M' }) {
  return addLayer(doc, qrLayer({ text, x: pt.x, y: pt.y, size, color, errorCorrectLevel }));
}

export function placePhoto(doc, { assetId, fit = 'contain' }) {
  // Photos default to the full artboard; drag/resize adjusts afterwards.
  return addLayer(doc, photoLayer({ assetId, x: 0, y: 0, w: 1, h: 1, fit }));
}
