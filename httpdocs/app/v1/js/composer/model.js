/*
 * model.js — composer document model (DESIGN_WEB_OD_APP_PLAN.md §6).
 *
 * Geometry is NORMALIZED 0…1 against the artboard (od-app's ComposerView
 * pattern), so a document is portable across panels. The artboard itself uses
 * the panel's ROTATED logical dimensions: an 800×480 panel at
 * rotationQuarterTurns=1 composes as 480×800; render.js maps normalized
 * coordinates onto that canvas and the encoder un-rotates at send time.
 *
 * Undo/redo holds structure-only snapshots: image bytes live once in the
 * `assets` store and layers reference them by assetId, so 50 snapshots cost
 * kilobytes, not megabytes.
 */

import { lightestIndex } from './palettes.js';

export const MAX_UNDO = 50;

export function artboardSize(device) {
  const rot = (device.rotationQuarterTurns ?? 0) & 0x03;
  const swap = rot === 1 || rot === 3;
  return {
    width: swap ? device.height : device.width,
    height: swap ? device.width : device.height,
  };
}

let nextLayerId = 1;
function newLayerId() {
  return `L${nextLayerId++}`;
}

export function createDocument(device) {
  return {
    deviceRecordId: device.recordId ?? null,
    // Panel facts the render needs; copied so a document renders identically
    // even if the device record is later updated.
    panel: {
      width: device.width,
      height: device.height,
      rotationQuarterTurns: (device.rotationQuarterTurns ?? 0) & 0x03,
      colorScheme: device.colorScheme,
      panelIcType: device.panelIcType ?? null,
    },
    // Palette index painted before layers. NOT hardcoded to 1: that is white
    // on the colour schemes but dark grey on 4-grey and near-black on 16-grey.
    background: lightestIndex(device.colorScheme),
    // Whole-image pre-dither parameters consumed by M3's wasm pass.
    tone: 'auto',
    gamut: 'auto',
    layers: [],
  };
}

// --- layer constructors (all geometry normalized 0…1) ---

/** How a photo is mapped onto the CANVAS, mirroring od-app's PhotoFitMode:
 *   cover   — aspect-fill: covers the whole canvas, overflow cropped (default)
 *   contain — aspect-fit: the whole photo is visible inside the canvas
 *   none    — natural pixel size, neither scaled up nor down
 *
 * The reference frame is the canvas, NOT any per-photo rectangle: a photo is
 * the canvas background, exactly as in od-app, where PhotoLayout.drawRect is
 * given the canvas box as its container. `scale` then zooms on top of that
 * baseline and `panX`/`panY` slide it, both the way od-app's pinch and drag
 * gestures do. The canvas edge is what crops. */
export const PHOTO_FIT_MODES = ['cover', 'contain', 'none'];

/** od-app's DisplayCanvasView.minPhotoScale: below the fit baseline the photo
 *  shrinks inside the canvas and reveals the background; this stops it
 *  collapsing to a dot. */
export const MIN_PHOTO_SCALE = 0.2;
export const MAX_PHOTO_SCALE = 4;

export function photoLayer({
  assetId, fit = 'cover', adjustments = {},
  // Offset from the CANVAS centre, as a fraction of the canvas (od-app's
  // normalized `pan`). Box-independent, so it survives a panel change.
  panX = 0, panY = 0,
  // Zoom multiplier on top of the fit-mode baseline (od-app's `scale`).
  scale = 1,
  // Natural size of the SOURCE in pixels, recorded at import. Needed by the
  // 'none' fit, and by every hit-test and bound, because the editor holds a
  // <=1600px proxy while the send path decodes larger — so the drawn size can
  // never be derived from the bitmap in hand.
  srcW = null, srcH = null,
  // Quarter turns applied to the image itself.
  rotationQuarterTurns = 0,
}) {
  if (!PHOTO_FIT_MODES.includes(fit)) {
    throw new Error(`unknown photo fit mode: ${fit}`);
  }
  if (!Number.isInteger(rotationQuarterTurns)
      || rotationQuarterTurns < 0 || rotationQuarterTurns > 3) {
    throw new Error(`photo rotation must be 0-3 quarter turns, got ${rotationQuarterTurns}`);
  }
  return {
    id: newLayerId(),
    type: 'photo',
    assetId,
    fit,
    panX, panY,
    scale: clampPhotoScale(scale),
    srcW, srcH,
    rotationQuarterTurns,
    adjustments: {
      // Applied per layer when compositing. Tone/gamut are NOT here: they are
      // whole-image pre-dither parameters (doc.tone / doc.gamut), because M3
      // runs one wasm pass over the finished composite and could not honour
      // conflicting per-layer tone settings.
      exposure: 1, saturation: 1, shadows: 0, highlights: 0,
      ...adjustments,
    },
  };
}

export function clampPhotoScale(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(MIN_PHOTO_SCALE, Math.min(MAX_PHOTO_SCALE, n));
}

/**
 * Bring a stored document up to the current photo model.
 *
 * Photos used to carry a box (x, y, w, h) that set the fit reference, the
 * position AND the crop. The box is gone: fit is relative to the canvas, the
 * position is a pan and the size is a zoom. A saved draft is converted rather
 * than rejected — the box's centre becomes the pan, its size the zoom, which
 * reproduces the common cases (a full-canvas photo maps to pan 0, zoom 1)
 * and puts the rest close enough to recognise.
 *
 * Returns the SAME object when nothing needed converting, so callers can use
 * identity to tell whether a draft was touched.
 */
export function migrateDocument(doc) {
  if (!doc?.layers?.some(isLegacyPhoto)) return doc;
  return {
    ...doc,
    layers: doc.layers.map((l) => (isLegacyPhoto(l) ? migrateLegacyPhoto(l) : l)),
  };
}

function isLegacyPhoto(l) {
  return l?.type === 'photo' && l.panX === undefined && l.w !== undefined;
}

function migrateLegacyPhoto(l) {
  const w = Number(l.w) || 1;
  const h = Number(l.h) || 1;
  const {
    x, y, w: _w, h: _h, ...rest
  } = l;
  return {
    ...rest,
    // Box centre, relative to the canvas centre.
    panX: (Number(x) || 0) + w / 2 - 0.5,
    panY: (Number(y) || 0) + h / 2 - 0.5,
    // The box's size was its zoom in all but name.
    scale: clampPhotoScale(w),
  };
}

export function strokeLayer({ points = [], color = 0, width = 0.01 }) {
  return { id: newLayerId(), type: 'stroke', points, color, width };
}

export function textLayer({ text, x = 0.1, y = 0.1, size = 0.08, color = 0, align = 'left' }) {
  return { id: newLayerId(), type: 'text', text, x, y, size, color, align };
}

export function qrLayer({ text, x = 0.1, y = 0.1, size = 0.3, color = 0, errorCorrectLevel = 'M' }) {
  return { id: newLayerId(), type: 'qr', text, x, y, size, color, errorCorrectLevel };
}

// --- immutable editing ---

function cloneDoc(doc) {
  return {
    ...doc,
    panel: { ...doc.panel },
    layers: doc.layers.map((l) => ({
      ...l,
      ...(l.points ? { points: l.points.map((p) => ({ ...p })) } : {}),
      ...(l.adjustments ? { adjustments: { ...l.adjustments } } : {}),
    })),
  };
}

export function addLayer(doc, layer) {
  const next = cloneDoc(doc);
  next.layers.push(layer);
  return next;
}

export function updateLayer(doc, layerId, patch) {
  const next = cloneDoc(doc);
  const i = next.layers.findIndex((l) => l.id === layerId);
  if (i === -1) throw new Error(`layer ${layerId} not found`);
  next.layers[i] = { ...next.layers[i], ...patch };
  return next;
}

export function removeLayer(doc, layerId) {
  const next = cloneDoc(doc);
  next.layers = next.layers.filter((l) => l.id !== layerId);
  return next;
}

export function moveLayer(doc, layerId, delta) {
  const next = cloneDoc(doc);
  const i = next.layers.findIndex((l) => l.id === layerId);
  if (i === -1) throw new Error(`layer ${layerId} not found`);
  const j = Math.max(0, Math.min(next.layers.length - 1, i + delta));
  const [layer] = next.layers.splice(i, 1);
  next.layers.splice(j, 0, layer);
  return next;
}

/** Remove every layer, keeping the panel and page settings. One undo step. */
export function clearLayers(doc) {
  const next = cloneDoc(doc);
  next.layers = [];
  return next;
}

/** Asset ids still referenced by a document (for mark-and-sweep GC). */
export function referencedAssets(doc) {
  const ids = new Set();
  for (const l of doc.layers) if (l.assetId) ids.add(l.assetId);
  return ids;
}

// --- undo stack (bounded, structure-only) ---

export function createHistory(doc) {
  return { past: [], present: doc, future: [] };
}

export function commit(history, doc) {
  const past = [...history.past, history.present];
  return {
    past: past.length > MAX_UNDO ? past.slice(past.length - MAX_UNDO) : past,
    present: doc,
    future: [],
  };
}

export function undo(history) {
  if (!history.past.length) return history;
  const present = history.past.at(-1);
  return {
    past: history.past.slice(0, -1),
    present,
    future: [history.present, ...history.future],
  };
}

export function redo(history) {
  if (!history.future.length) return history;
  const [present, ...future] = history.future;
  return { past: [...history.past, history.present], present, future };
}

export function canUndo(history) {
  return history.past.length > 0;
}

export function canRedo(history) {
  return history.future.length > 0;
}

/** Serializable draft form (assets referenced, never embedded). */
export function toDraft(doc, { id, recordId }) {
  return {
    id,
    recordId: recordId ?? doc.deviceRecordId ?? null,
    doc: cloneDoc(doc),
    updatedAt: Date.now(),
  };
}

export function fromDraft(draft) {
  const doc = cloneDoc(draft.doc);
  // Keep the id generator ahead of anything restored from storage.
  for (const l of doc.layers) {
    const n = Number(String(l.id).replace(/^L/, ''));
    if (Number.isFinite(n) && n >= nextLayerId) nextLayerId = n + 1;
  }
  return doc;
}
