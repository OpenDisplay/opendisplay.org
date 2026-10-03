/*
 * canvas.js — interactive editing surface (DESIGN_WEB_OD_APP_PLAN.md §6).
 * Pointer input in CSS pixels is converted to normalized 0…1 artboard
 * coordinates; the display canvas is a scaled preview of the panel-resolution
 * render. Main thread only (pointer + DOM).
 */

import { qrGeometry, photoPlacement } from './render.js';
import { createGestureRouter } from './gestures.js';

/**
 * Map a point in VIEW space (0..1 across the on-screen box) to normalized
 * artboard coordinates, undoing a canvas view rotation.
 *
 * Convention: "rotate right" increments the index and applies CSS
 * `rotate(90deg)`. CSS rotates clockwise and y points down, so the panel's
 * top-left corner lands at the view's top-right:
 *
 *     forward   (u, v) = (1 - y, x)
 *     inverse   (x, y) = (v, 1 - u)
 *
 * Values are deliberately NOT clamped — elements may bleed off the edge, and
 * clamping here would pin every drag at the boundary.
 */
export function viewToPanel(u, v, rotationQuarterTurns = 0) {
  switch (rotationQuarterTurns & 0x03) {
    case 1: return { x: v, y: 1 - u };
    case 2: return { x: 1 - u, y: 1 - v };
    case 3: return { x: 1 - v, y: u };
    default: return { x: u, y: v };
  }
}

/** Inverse of viewToPanel — used by tests and by anything that has to put a
 *  panel coordinate back on the screen. */
export function panelToView(x, y, rotationQuarterTurns = 0) {
  switch (rotationQuarterTurns & 0x03) {
    case 1: return { u: 1 - y, v: x };
    case 2: return { u: 1 - x, v: 1 - y };
    case 3: return { u: y, v: 1 - x };
    default: return { u: x, v: y };
  }
}

/**
 * @param {HTMLCanvasElement} canvasEl
 * @param {object} handlers
 * @param {() => number} [handlers.viewRotation] current canvas view rotation
 */
/** A ctrl+wheel burst this far apart is treated as a new zoom gesture (and so
 *  a new undo entry). Trackpads emit a dense stream, then stop. */
const WHEEL_IDLE_MS = 260;

/** Wheel delta -> multiplicative zoom. Multiplicative so a tick feels the same
 *  at 0.3x as at 3x; linear addition does not. */
const WHEEL_ZOOM_K = 0.0025;

export function makeSurface(canvasEl, {
  onPointerDown, onPointerMove, onPointerUp, onPointerCancel,
  onZoomStart, onZoomMove, onZoomEnd, viewRotation,
}) {
  // The rotation and the box are frozen for the WHOLE sequence — from the
  // first pointer down until the last is up — not per pointer. A drag survives
  // a rotation (pointer capture keeps delivering), and a pinch has two
  // pointers whose downs would otherwise each re-freeze it mid-gesture.
  let gestureRot = 0;
  let frozenRect = null;
  let active = 0;

  const box = () => canvasEl.parentElement ?? canvasEl;

  function beginSequence() {
    if (active === 0) {
      gestureRot = viewRotation?.() ?? 0;
      frozenRect = box().getBoundingClientRect();
    }
    active += 1;
  }

  function endSequence() {
    active = Math.max(0, active - 1);
    if (active === 0) frozenRect = null;
  }

  // Measured against the WRAPPER, not the canvas: under a view rotation the
  // canvas's own bounding rect is the axis-aligned box of the rotated element,
  // which would give a plausible-looking but wrong mapping (drags move, just
  // along the wrong axis). The wrapper is never transformed.
  //
  // Deliberately UNCLAMPED. Pointer capture keeps delivering moves once the
  // finger leaves the canvas, and elements are allowed to bleed off the edge —
  // clamping here would pin a drag at the boundary no matter how far the user
  // moved. The tools bound how far an element may actually go.
  const toNorm = (ev, rot = gestureRot, rect = frozenRect) => {
    const r = rect ?? box().getBoundingClientRect();
    return viewToPanel(
      (ev.clientX - r.left) / r.width,
      (ev.clientY - r.top) / r.height,
      rot,
    );
  };

  const router = createGestureRouter({
    onToolDown: onPointerDown,
    onToolMove: onPointerMove,
    onToolUp: onPointerUp,
    onToolCancel: onPointerCancel,
    onZoomStart,
    onZoomMove,
    onZoomEnd,
  });

  canvasEl.addEventListener('pointerdown', (ev) => {
    beginSequence();
    // Capture keeps the drag alive once the pointer leaves the canvas, which
    // is now normal — elements may be dragged past the edge. It is not
    // essential to the gesture, so a pointer id the browser will not capture
    // (a synthetic event, a pointer already released) must not abort it.
    try { canvasEl.setPointerCapture(ev.pointerId); } catch { /* not capturable */ }
    router.down(ev.pointerId, toNorm(ev), { x: ev.clientX, y: ev.clientY }, ev.pointerType);
  });
  canvasEl.addEventListener('pointermove', (ev) => {
    router.move(ev.pointerId, toNorm(ev), { x: ev.clientX, y: ev.clientY });
  });
  canvasEl.addEventListener('pointerup', (ev) => {
    try { canvasEl.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    router.up(ev.pointerId, toNorm(ev), { x: ev.clientX, y: ev.clientY });
    endSequence();
  });
  canvasEl.addEventListener('pointercancel', (ev) => {
    try { canvasEl.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    router.cancel(ev.pointerId);
    endSequence();
  });

  // ctrl+wheel is the trackpad pinch on every desktop browser, and the only
  // zoom a mouse has. A PLAIN wheel is deliberately left alone: the canvas is
  // capped at 55% of the viewport, so the tool chips, the photo panel and Send
  // are below the fold — swallowing the wheel would put the composer's own
  // controls out of reach of the commonest scroll gesture. The canvas is not a
  // scroll container, and panning the photo is a document edit, not a view
  // change, so a stray scroll must never alter what gets sent.
  let wheelTimer = null;
  let wheelScale = 1;
  canvasEl.addEventListener('wheel', (ev) => {
    if (!ev.ctrlKey) return;
    ev.preventDefault(); // touch-action does not suppress ctrl+wheel page zoom
    // deltaMode 1 is lines (Firefox), 2 is pages; normalise to pixels.
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1;
    if (wheelTimer === null) {
      gestureRot = viewRotation?.() ?? 0;
      frozenRect = box().getBoundingClientRect();
      wheelScale = 1;
      onZoomStart?.({ anchor: toNorm(ev) });
    }
    clearTimeout(wheelTimer);
    wheelScale *= Math.exp(-ev.deltaY * unit * WHEEL_ZOOM_K);
    onZoomMove?.({ ratio: wheelScale, anchor: toNorm(ev) });
    wheelTimer = setTimeout(() => {
      wheelTimer = null;
      if (active === 0) frozenRect = null;
      onZoomEnd?.();
    }, WHEEL_IDLE_MS);
  }, { passive: false });

  return { toNorm: (ev) => toNorm(ev, viewRotation?.() ?? 0, null) };
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
    case 'photo': {
      // A photo has no frame — it is laid out against the CANVAS and cropped
      // by it — so its bounds are the footprint it actually occupies, derived
      // from the source size recorded at import (never from a bitmap: the
      // editor's proxy and the send decode differ).
      const p = photoPlacement(layer, W, H);
      return {
        x: (p.cx - p.fw / 2) / W,
        y: (p.cy - p.fh / 2) / H,
        w: p.fw / W,
        h: p.fh / H,
      };
    }
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

/** Corner handles, in draw order. */
export const HANDLES = ['nw', 'ne', 'se', 'sw'];

/**
 * Handle size in NORMALIZED units for each axis. Handles are square on screen,
 * so the normalized size differs per axis on a non-square artboard.
 */
export const HANDLE_PX = 14;

/** Touch targets are bigger than what is drawn — od-app allows 10pt of slop
 *  around a tap for the same reason. */
export const HANDLE_HIT_SLOP = 1.6;

export function handleSize({ W, H }, px = HANDLE_PX) {
  return { hw: px / W, hh: px / H };
}

/**
 * Centres of the resize handles for a layer, in normalized coordinates.
 *
 * Handles are pulled back inside the artboard when the element bleeds off it —
 * the overlay canvas is exactly panel-sized, so a handle drawn outside would be
 * both invisible and untouchable, stranding the element the user just pushed
 * off the edge. (od-app clamps its selection controls the same way, and for the
 * same reason: its canvas is .clipped().) The resize maths works from the
 * element's TRUE bounds plus the pointer delta, so a pulled-back handle changes
 * only where you grab, never what the grab does.
 *
 * Returns null for layer types that are not resizable by handle (strokes).
 */
export function handlePoints(layer, size, px = HANDLE_PX) {
  // Photos resize by ZOOM, not by dragging a corner: they have no frame to
  // pull. od-app uses a pinch for the same reason. Strokes have no handles
  // either — they move but do not resize.
  if (layer.type === 'stroke' || layer.type === 'photo') return null;
  const b = layerBounds(layer, size);
  if (!b) return null;
  const { hw, hh } = handleSize(size, px);
  const cx = (x) => Math.max(hw, Math.min(1 - hw, x));
  const cy = (y) => Math.max(hh, Math.min(1 - hh, y));
  return {
    nw: { x: cx(b.x), y: cy(b.y) },
    ne: { x: cx(b.x + b.w), y: cy(b.y) },
    se: { x: cx(b.x + b.w), y: cy(b.y + b.h) },
    sw: { x: cx(b.x), y: cy(b.y + b.h) },
  };
}

/**
 * Which resize handle (if any) is under `pt`. Checked BEFORE layer hit-testing
 * so grabbing a corner resizes rather than moves.
 */
export function hitHandle(layer, pt, size, px = HANDLE_PX) {
  // Hit-test against where the handles are DRAWN (px), but with a slop margin,
  // so a small handle is still comfortably grabbable on a touch screen.
  const points = handlePoints(layer, size, px);
  if (!points) return null;
  const { hw, hh } = handleSize(size, px * HANDLE_HIT_SLOP);
  for (const name of HANDLES) {
    const c = points[name];
    if (Math.abs(pt.x - c.x) <= hw && Math.abs(pt.y - c.y) <= hh) return name;
  }
  return null;
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
