/*
 * gestures.js — who owns the pointer, and what a gesture becomes.
 *
 * DOM-free on purpose. The surface (canvas.js) turns DOM events into
 * normalized points; this decides whether they are a tool gesture or a pinch,
 * and index.js turns the decisions into session edits. Splitting it out is
 * what makes "down A, down B, move both, up A, move B, up B" testable without
 * a browser — the interleavings are the whole difficulty and they are
 * miserable to reproduce through DOM callbacks.
 *
 * The rule, taken from od-app's DisplayCanvasView: a second pointer PREEMPTS
 * whatever the first was doing, and the preemption is STICKY for the rest of
 * the sequence. od-app needs stickiness because SwiftUI keeps its DragGesture
 * alive after the magnification ends and the surviving finger's translation
 * silently carries the pinch's motion, so resuming would jump. Pointer Events
 * give us identities, so we can state the ownership rule directly instead of
 * defending against that accident — but the user-visible behaviour is the
 * same, and it is the right one: a pinch must never leave half an edit, a
 * stray tap, or an undo entry nobody asked for.
 *
 * Preemption CANCELS rather than ends: the tool's in-progress edit is thrown
 * away, not committed. A stroke half-drawn when the second finger lands does
 * not become a stroke.
 */

/** Pointer types that may start a pinch. A mouse has one pointer; a second
 *  mouse "pointer" is not a thing, and pen+touch mixtures are not a pinch. */
const PINCH_TYPES = new Set(['touch', 'pen']);

/**
 * @param {object} handlers
 * @param {(pt) => void} handlers.onToolDown
 * @param {(pt) => void} handlers.onToolMove
 * @param {(pt) => void} handlers.onToolUp
 * @param {() => void}   handlers.onToolCancel  discard the in-progress edit
 * @param {(g) => void}  handlers.onZoomStart   {anchor}
 * @param {(g) => void}  handlers.onZoomMove    {ratio, anchor}
 * @param {() => void}   handlers.onZoomEnd
 */
export function createGestureRouter(handlers = {}) {
  /** id -> {pt, client:{x,y}, type} */
  const pointers = new Map();
  // idle  — nothing in progress
  // tool  — one pointer, driving the active tool
  // zoom  — two or more pointers, pinching
  // dead  — a pinch has ended but pointers remain down; they do NOTHING until
  //         every one of them is released. This is the sticky part.
  let mode = 'idle';
  let toolId = null;
  let pinch = null; // {a, b, startDist}

  const dist = (p, q) => Math.hypot(p.client.x - q.client.x, p.client.y - q.client.y);
  const midpoint = (p, q) => ({ x: (p.pt.x + q.pt.x) / 2, y: (p.pt.y + q.pt.y) / 2 });

  function pinchPair() {
    // The two pointers that own the pinch, if both are still down.
    const a = pointers.get(pinch?.a);
    const b = pointers.get(pinch?.b);
    return a && b ? [a, b] : null;
  }

  function beginPinch() {
    const ids = [...pointers.keys()].filter((id) => PINCH_TYPES.has(pointers.get(id).type));
    if (ids.length < 2) return false;
    const [a, b] = ids.slice(-2); // the two most recent
    const pa = pointers.get(a);
    const pb = pointers.get(b);
    const startDist = dist(pa, pb);
    // Two fingers exactly on top of each other give no baseline to scale from.
    if (!(startDist > 0)) return false;
    pinch = { a, b, startDist };
    mode = 'zoom';
    handlers.onZoomStart?.({ anchor: midpoint(pa, pb) });
    return true;
  }

  return {
    down(id, pt, { x, y }, type = 'mouse') {
      pointers.set(id, { pt, client: { x, y }, type });
      if (mode === 'dead') return;
      if (mode === 'tool') {
        // A second pointer takes over. The tool's edit is DISCARDED — calling
        // its onUp instead would commit the half-drag we are trying to lose.
        if (!PINCH_TYPES.has(type)) return; // a stray non-touch pointer changes nothing
        handlers.onToolCancel?.();
        toolId = null;
        if (!beginPinch()) mode = 'dead';
        return;
      }
      if (mode === 'zoom') return; // a third finger joins the crowd, changes nothing
      toolId = id;
      mode = 'tool';
      handlers.onToolDown?.(pt);
    },

    move(id, pt, { x, y }) {
      const p = pointers.get(id);
      if (!p) return;
      p.pt = pt;
      p.client = { x, y };
      if (mode === 'tool' && id === toolId) {
        handlers.onToolMove?.(pt);
        return;
      }
      if (mode === 'zoom') {
        const pair = pinchPair();
        if (!pair) return;
        const d = dist(pair[0], pair[1]);
        if (!(d > 0)) return;
        handlers.onZoomMove?.({
          // Distances in CLIENT pixels, deliberately: normalized space is
          // anisotropic on a non-square panel, and under a quarter-turn view
          // rotation its axes are swapped, so a normalized ratio would give
          // the wrong magnification for a pinch that rotates as it scales.
          ratio: d / pinch.startDist,
          anchor: midpoint(pair[0], pair[1]),
        });
      }
    },

    up(id, pt) {
      const p = pointers.get(id);
      pointers.delete(id);
      if (mode === 'tool' && id === toolId) {
        toolId = null;
        mode = pointers.size ? 'dead' : 'idle';
        handlers.onToolUp?.(p ? pt : pt);
        return;
      }
      if (mode === 'zoom' && (id === pinch.a || id === pinch.b)) {
        pinch = null;
        handlers.onZoomEnd?.();
        // STICKY: the surviving finger does not become a new tool gesture, and
        // does not resume the one the pinch cancelled.
        mode = pointers.size ? 'dead' : 'idle';
        return;
      }
      if (!pointers.size) mode = 'idle';
    },

    /** A cancelled pointer never commits anything. */
    cancel(id) {
      const wasTool = mode === 'tool' && id === toolId;
      const wasPinch = mode === 'zoom' && (id === pinch?.a || id === pinch?.b);
      pointers.delete(id);
      if (wasTool) {
        toolId = null;
        handlers.onToolCancel?.();
      } else if (wasPinch) {
        pinch = null;
        handlers.onZoomEnd?.();
      }
      mode = pointers.size ? 'dead' : 'idle';
    },

    /** Test seam. */
    _state: () => ({ mode, pointers: pointers.size, toolId }),
  };
}
