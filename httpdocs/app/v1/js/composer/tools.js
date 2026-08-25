/*
 * tools.js — composer tool behaviours (DESIGN_WEB_OD_APP_PLAN.md §6).
 * Pure state transitions over the document model: each tool turns pointer
 * events into layer mutations. Kept DOM-free so it is unit-testable.
 */
import { addLayer, updateLayer, strokeLayer, textLayer, qrLayer, photoLayer } from './model.js';
import { hitTest, layerBounds, hitHandle } from './canvas.js';

/**
 * How far an element may hang off the artboard, as a fraction of it. Elements
 * are deliberately NOT confined to the canvas — bleeding a photo or a rule off
 * the edge is ordinary layout, and the render clips whatever crosses it. This
 * only stops an element being pushed so far that it is gone.
 */
export const CANVAS_BLEED = 0.25;

/** …and at least this fraction of the element itself must stay on-canvas, so a
 *  small element cannot be parked in the bleed where it is invisible. */
export const MIN_ON_CANVAS = 0.3;

/**
 * Legal range for one axis of an element's rendered box.
 *
 * The rule is an OVERLAP requirement: enough of the element must stay on the
 * artboard to grab it again. For something that fits, that is MIN_ON_CANVAS of
 * the element, and the drift is additionally capped at CANVAS_BLEED so a small
 * element cannot wander into the far bleed.
 *
 * An element LARGER than the artboard needs both caps lifted, and this is
 * where the first version of this function broke: it asked for MIN_ON_CANVAS
 * of the *element*, which past 1/MIN_ON_CANVAS exceeds the whole artboard and
 * cannot be satisfied, and it capped the leading edge at -CANVAS_BLEED, which
 * for a 3x-wide cover photo forbids panning at all. The interval inverted and
 * every drag collapsed to one value. So the demanded overlap is never more
 * than the artboard minus the bleed, and the drift caps apply only to elements
 * that actually fit.
 *
 * @returns {[number, number]} inclusive min/max for the box's leading edge
 */
export function bleedRange(extent) {
  const overlap = Math.min(extent * MIN_ON_CANVAS, 1 - CANVAS_BLEED);
  let lo = overlap - extent;   // element's trailing edge sits at `overlap`
  let hi = 1 - overlap;        // element's leading edge sits at 1 - overlap
  if (extent <= 1) {
    lo = Math.max(lo, -CANVAS_BLEED);
    hi = Math.min(hi, 1 + CANVAS_BLEED - extent);
  }
  // Defensive: an inverted interval silently pins every drag to one value,
  // which is exactly the failure this replaced.
  return lo <= hi ? [lo, hi] : [(lo + hi) / 2, (lo + hi) / 2];
}

/**
 * Keep a photo's PAN inside the bleed. A photo has no origin to clamp — the
 * pan slides its footprint about the canvas centre — so the rule is applied to
 * the footprint's leading edge and solved back into a pan.
 *
 * Exported because the footprint changes when the FIT, ZOOM or ROTATION
 * changes, not only when the photo is dragged: without re-applying it there,
 * shrinking or turning a panned photo could leave it entirely off-canvas and
 * unreachable.
 */
export function clampPan(layer, panX, panY, size) {
  const b = layerBounds({ ...layer, panX, panY }, size);
  if (!b) return { panX, panY };
  // Where the leading edge sits when the pan is zero.
  const restX = b.x - panX;
  const restY = b.y - panY;
  const [minX, maxX] = bleedRange(b.w);
  const [minY, maxY] = bleedRange(b.h);
  return {
    panX: Math.max(minX - restX, Math.min(maxX - restX, panX)),
    panY: Math.max(minY - restY, Math.min(maxY - restY, panY)),
  };
}

/**
 * Place a layer origin so its RENDERED extent stays within the bleed. Uses the
 * rendered bounds, so text alignment and the QR quiet zone are accounted for.
 */
function clampOrigin(layer, x, y, size) {
  const b = layerBounds({ ...layer, x, y }, size);
  const w = b?.w ?? 0;
  const h = b?.h ?? 0;
  // The offset between the anchor and the drawn box must be preserved.
  const offX = (b?.x ?? x) - x;
  const offY = (b?.y ?? y) - y;
  const [minX, maxX] = bleedRange(w);
  const [minY, maxY] = bleedRange(h);
  return {
    x: Math.max(minX - offX, Math.min(maxX - offX, x)),
    y: Math.max(minY - offY, Math.min(maxY - offY, y)),
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

/** A layer may not be resized smaller than this (normalized), so it can never
 *  become impossible to grab again. */
export const MIN_LAYER_SIZE = 0.05;

/**
 * Apply a corner-handle resize to a text or QR layer's box, keeping it within
 * the bleed and never smaller than MIN_LAYER_SIZE. Pure, so it is unit-testable
 * without pointer plumbing. (Photos do not use this: they have no box.)
 * @param {{x,y,w,h}} start  the box when the gesture began
 * @param {string} handle    'nw' | 'ne' | 'se' | 'sw'
 * @param {{x,y}} delta      pointer movement since the gesture began
 */
export function resizeBox(start, handle, delta) {
  let { x, y, w, h } = start;
  const right = start.x + start.w;
  const bottom = start.y + start.h;

  if (handle === 'se') {
    w = start.w + delta.x;
    h = start.h + delta.y;
  } else if (handle === 'ne') {
    w = start.w + delta.x;
    y = start.y + delta.y;
    h = bottom - y;
  } else if (handle === 'sw') {
    x = start.x + delta.x;
    w = right - x;
    h = start.h + delta.y;
  } else { // nw
    x = start.x + delta.x;
    y = start.y + delta.y;
    w = right - x;
    h = bottom - y;
  }

  // Enforce the minimum by pushing the moving EDGE back, so the anchored
  // corner stays put rather than the whole box sliding.
  if (w < MIN_LAYER_SIZE) {
    if (handle === 'nw' || handle === 'sw') x = right - MIN_LAYER_SIZE;
    w = MIN_LAYER_SIZE;
  }
  if (h < MIN_LAYER_SIZE) {
    if (handle === 'nw' || handle === 'ne') y = bottom - MIN_LAYER_SIZE;
    h = MIN_LAYER_SIZE;
  }
  // Keep the box within the bleed without changing the anchored corner. A box
  // LARGER than the artboard is fine — the render clips it.
  const lo = -CANVAS_BLEED;
  const hi = 1 + CANVAS_BLEED;
  if (x < lo) { w += x - lo; x = lo; }
  if (y < lo) { h += y - lo; y = lo; }
  if (x + w > hi) w = hi - x;
  if (y + h > hi) h = hi - y;
  w = Math.max(MIN_LAYER_SIZE, w);
  h = Math.max(MIN_LAYER_SIZE, h);
  return { x, y, w, h };
}

/**
 * Select/move/resize. `selectedId` PERSISTS after pointer-up (the Delete
 * button acts on it); `dragId` is the transient gesture target.
 *
 * A pointer-down on a corner HANDLE of the selected layer starts a resize;
 * anywhere else on the layer starts a move.
 */
export function makeSelectTool({ onSelect, handlePx } = {}) {
  let selectedId = null;
  let dragId = null;
  let grab = null;
  let strokeDrag = null; // {origin, points} — strokes move by translation
  let resize = null;     // {handle, origin, box} — corner-handle resize
  let moved = false;
  return {
    name: 'select',
    onDown(doc, pt, size) {
      // A handle on the ALREADY-selected layer wins over hit-testing, so a
      // corner sitting on top of another layer still resizes.
      const selected = selectedId && doc.layers.find((l) => l.id === selectedId);
      if (selected) {
        const handle = hitHandle(selected, pt, size, handlePx?.());
        if (handle) {
          dragId = selectedId;
          moved = false;
          grab = null;
          strokeDrag = null;
          resize = { handle, origin: pt, box: layerBounds(selected, size) };
          return { doc, commit: false };
        }
      }

      const hit = hitTest(doc, pt, size);
      selectedId = hit;
      dragId = hit;
      moved = false;
      strokeDrag = null;
      grab = null;
      resize = null;
      onSelect?.(selectedId);
      if (!dragId) return { doc, commit: false };
      const layer = doc.layers.find((l) => l.id === dragId);
      if (layer.type === 'stroke') {
        // A stroke has no origin — remember where the drag started and the
        // points it started from, then translate the whole polyline.
        strokeDrag = { origin: pt, points: layer.points.map((p) => ({ ...p })) };
      } else if (layer.type === 'photo') {
        // Dragging a photo PANS it, exactly as od-app's DragGesture does.
        grab = { dx: pt.x - (layer.panX ?? 0), dy: pt.y - (layer.panY ?? 0) };
      } else {
        grab = { dx: pt.x - (layer.x ?? 0), dy: pt.y - (layer.y ?? 0) };
      }
      return { doc, commit: false };
    },
    onMove(doc, pt, size) {
      if (!dragId) return { doc, commit: false };
      const layer = doc.layers.find((l) => l.id === dragId);
      if (!layer) return { doc, commit: false };

      if (resize) {
        // QR and text scale via their own `size` field, driven from the shorter
        // artboard edge. Photos have no handles at all (they zoom instead).
        const delta = { x: pt.x - resize.origin.x, y: pt.y - resize.origin.y };
        const box = resizeBox(resize.box, resize.handle, delta);
        moved = true;
        const shorter = Math.min(box.w * size.W, box.h * size.H);
        return {
          doc: updateLayer(doc, dragId, {
            x: box.x, y: box.y,
            size: Math.max(0.02, shorter / Math.min(size.W, size.H)),
          }),
          commit: false,
        };
      }

      if (layer.type === 'stroke') {
        if (!strokeDrag) return { doc, commit: false };
        const xs = strokeDrag.points.map((p) => p.x);
        const ys = strokeDrag.points.map((p) => p.y);
        // Translate the polyline as a unit, bounded by the same bleed rule.
        const x0 = Math.min(...xs);
        const y0 = Math.min(...ys);
        const [minX, maxX] = bleedRange(Math.max(...xs) - x0);
        const [minY, maxY] = bleedRange(Math.max(...ys) - y0);
        const dx = Math.max(minX - x0, Math.min(maxX - x0, pt.x - strokeDrag.origin.x));
        const dy = Math.max(minY - y0, Math.min(maxY - y0, pt.y - strokeDrag.origin.y));
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
      if (layer.type === 'photo') {
        const pan = clampPan(layer, pt.x - grab.dx, pt.y - grab.dy, size);
        if (pan.panX === layer.panX && pan.panY === layer.panY) return { doc, commit: false };
        moved = true;
        return { doc: updateLayer(doc, dragId, pan), commit: false };
      }
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
      resize = null;
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

export function placePhoto(doc, { assetId, fit = 'cover', srcW = null, srcH = null }) {
  // Centred and unzoomed: the fit mode alone decides how it meets the canvas.
  return addLayer(doc, photoLayer({ assetId, fit, srcW, srcH }));
}
