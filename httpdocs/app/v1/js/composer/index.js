/*
 * composer/index.js — composer view controller (M2).
 * DOM wiring only: document logic is in model/tools/render, and session
 * lifecycle (gesture history, autosave isolation, bitmap ownership) is in
 * session.js.
 *
 * NOTE FOR M3: the canvas rendered here is a full-colour composite (text and
 * photo edges are anti-aliased). It must NOT be sent to a device directly —
 * M3 dithers it to palette indices and paints those back as exact ideal
 * palette RGB before handing a canvas to the adapter.
 */
import * as model from './model.js';
import * as tools from './tools.js';
import { renderDocument, validateDocument, lightestIndex } from './render.js';
import { makeSurface, blitPreview } from './canvas.js';
import { createSession } from './session.js';
import * as store from '../store.js';

const $ = (id) => document.getElementById(id);

/** Editing proxy cap: full-resolution originals stay in the asset store and
 *  are only decoded at send time (M3). */
const PROXY_MAX_PX = 1600;

let session = null;
let wired = false;
let drawTool = null;
let selectTool = null;
let activeTool = null;

function doc() {
  return session.doc();
}

function size() {
  const { width, height } = model.artboardSize(doc().panel);
  return { W: width, H: height };
}

/** Ink choices legal for the CURRENT panel scheme — offering Blue on a mono
 *  panel would silently render as another colour. */
const SCHEME_INK_LABELS = {
  0: ['Black', 'White'],
  1: ['Black', 'White', 'Red'],
  2: ['Black', 'White', 'Yellow'],
  3: ['Black', 'White', 'Yellow', 'Red'],
  4: ['Black', 'White', 'Yellow', 'Red', 'Blue', 'Green'],
  5: ['Black', 'Dark grey', 'Light grey', 'White'],
  6: Array.from({ length: 16 }, (_, i) => `Grey ${i}/15`),
  8: ['Black', 'White', 'Yellow', 'Red', 'Blue', 'Green'],
};

function rebuildInkOptions() {
  const scheme = doc().panel.colorScheme;
  const labels = SCHEME_INK_LABELS[scheme] ?? SCHEME_INK_LABELS[0];
  const select = $('inkColor');
  const previous = Number(select.value);
  select.textContent = '';
  labels.forEach((label, index) => {
    const opt = document.createElement('option');
    opt.value = String(index);
    opt.textContent = label;
    select.appendChild(opt);
  });
  // Keep the choice if it is still legal, else fall back to black.
  select.value = String(previous < labels.length ? previous : 0);
  drawTool?.setColor(Number(select.value));
}

function paint() {
  const { canvas, width, height } = renderDocument(doc(), session.bitmaps());
  blitPreview($('composerCanvas'), canvas, { width, height });
  $('undoBtn').disabled = !session.canUndo();
  $('redoBtn').disabled = !session.canRedo();
  $('deleteLayerBtn').disabled = !selectTool?.selectedId();
  const p = doc().panel;
  $('composerPanelInfo').textContent =
    `${p.width}×${p.height}${p.rotationQuarterTurns ? ` · rot ${p.rotationQuarterTurns * 90}°` : ''}` +
    ` · scheme ${p.colorScheme} · ${doc().layers.length} layer(s)`;
  updatePhotoControls();
}

function toast(msg, kind = 'info') {
  const el = $('composerStatus');
  el.textContent = msg;
  el.dataset.kind = kind;
}

// --- photo handling -------------------------------------------------------

/** Decode a ≤PROXY_MAX_PX editing proxy; originals stay in the asset store. */
async function decodeProxy(blob) {
  const full = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, PROXY_MAX_PX / Math.max(full.width, full.height));
  if (scale === 1) return full;
  const proxy = await createImageBitmap(full, {
    resizeWidth: Math.max(1, Math.round(full.width * scale)),
    resizeHeight: Math.max(1, Math.round(full.height * scale)),
    resizeQuality: 'high',
  });
  full.close?.();
  return proxy;
}

/**
 * True only if `owner` is STILL the live session and has not been released.
 * Comparing generations alone is not enough: a fresh session also starts at
 * generation 0, so an async result from a released session could be applied
 * to its replacement. Identity of the owner object is the real check.
 */
function isCurrent(owner, capturedGeneration) {
  return session === owner && owner.generation() === capturedGeneration;
}

async function importPhoto(blob) {
  const owner = session;
  const gen = owner.generation();
  const assetId = await store.putAsset(blob);
  const bitmap = await decodeProxy(blob);
  // The session may have been replaced while we hashed and decoded.
  if (!isCurrent(owner, gen)) {
    bitmap.close?.();
    return;
  }
  owner.setBitmap(assetId, bitmap);
  owner.apply(tools.placePhoto(owner.doc(), { assetId }));
  selectPhotoLayer(owner.doc().layers.at(-1).id);
  toast('Photo added.');
}

function selectedPhotoLayer() {
  const id = selectTool?.selectedId();
  const layer = id && doc().layers.find((l) => l.id === id);
  return layer && layer.type === 'photo' ? layer : null;
}

function selectPhotoLayer(id) {
  selectTool.setSelection?.(id);
  paint();
}

function updatePhotoControls() {
  const layer = selectedPhotoLayer();
  $('photoControls').hidden = !layer;
  if (!layer) return;
  $('photoFit').value = layer.fit;
  // Keep the slider in step with the selected layer, or the next drag would
  // jump it to a stale value.
  $('photoSize').value = String(layer.w ?? 1);
  for (const [id, key] of Object.entries(ADJUST_INPUTS)) {
    $(id).value = String(layer.adjustments[key] ?? (key === 'exposure' || key === 'saturation' ? 1 : 0));
  }
}

const ADJUST_INPUTS = {
  adjExposure: 'exposure',
  adjSaturation: 'saturation',
  adjShadows: 'shadows',
  adjHighlights: 'highlights',
};

function wirePhotoControls() {
  $('photoFit').addEventListener('change', (ev) => {
    const layer = selectedPhotoLayer();
    if (layer) session.apply(model.updateLayer(doc(), layer.id, { fit: ev.target.value }));
  });
  for (const [id, key] of Object.entries(ADJUST_INPUTS)) {
    // `input` previews live; `change` commits one history entry per drag.
    $(id).addEventListener('input', () => {
      const layer = selectedPhotoLayer();
      if (!layer) return;
      const next = model.updateLayer(doc(), layer.id, {
        adjustments: { ...layer.adjustments, [key]: Number($(id).value) },
      });
      session.updateGesture(next);
    });
    $(id).addEventListener('change', () => {
      const layer = selectedPhotoLayer();
      if (!layer) return;
      session.endGesture(doc(), true);
    });
    $(id).addEventListener('pointerdown', () => session.beginGesture());
  }
  $('photoSize').addEventListener('input', () => {
    const layer = selectedPhotoLayer();
    if (!layer) return;
    const f = Number($('photoSize').value);
    // Growing a layer that sits near an edge must not push it off-canvas:
    // re-clamp the origin against the NEW extent.
    const x = Math.max(0, Math.min(1 - f, layer.x));
    const y = Math.max(0, Math.min(1 - f, layer.y));
    session.updateGesture(model.updateLayer(doc(), layer.id, { w: f, h: f, x, y }));
  });
  $('photoSize').addEventListener('pointerdown', () => session.beginGesture());
  $('photoSize').addEventListener('change', () => session.endGesture(doc(), true));
}

// --- wiring ---------------------------------------------------------------

function wire() {
  drawTool = tools.makeDrawTool({ color: 0, width: 0.012 });
  selectTool = tools.makeSelectTool({ onSelect: () => paint() });
  activeTool = selectTool;

  const setTool = (tool, btnId) => {
    activeTool = tool;
    for (const b of document.querySelectorAll('.composer__tool')) {
      b.classList.toggle('composer__tool--active', b.id === btnId);
    }
  };
  $('toolSelect').addEventListener('click', () => setTool(selectTool, 'toolSelect'));
  $('toolDraw').addEventListener('click', () => setTool(drawTool, 'toolDraw'));

  $('toolText').addEventListener('click', () => {
    const text = window.prompt('Text to place:');
    if (!text) return;
    session.apply(tools.placeText(doc(), { x: 0.1, y: 0.1 }, {
      text, color: Number($('inkColor').value),
    }));
  });
  $('toolQr').addEventListener('click', () => {
    const text = window.prompt('QR contents (URL or text):', 'https://opendisplay.org');
    if (!text) return;
    try {
      session.apply(tools.placeQr(doc(), { x: 0.1, y: 0.1 }, {
        text, color: Number($('inkColor').value),
      }));
    } catch (err) {
      toast(String(err.message ?? err), 'error');
    }
  });
  $('inkColor').addEventListener('change', (ev) => drawTool.setColor(Number(ev.target.value)));

  makeSurface($('composerCanvas'), {
    onPointerDown: (pt) => {
      session.beginGesture();
      const r = activeTool.onDown(doc(), pt, size());
      session.updateGesture(r.doc);
    },
    onPointerMove: (pt) => {
      const r = activeTool.onMove(doc(), pt, size());
      session.updateGesture(r.doc);
    },
    onPointerUp: (pt) => {
      const r = activeTool.onUp(doc(), pt, size());
      session.endGesture(r.doc, r.commit);
    },
  });

  $('undoBtn').addEventListener('click', () => session.undo());
  $('redoBtn').addEventListener('click', () => session.redo());
  $('deleteLayerBtn').addEventListener('click', () => {
    const id = selectTool.selectedId();
    if (!id) return;
    selectTool.clearSelection();
    session.apply(model.removeLayer(doc(), id));
  });

  $('photoFile').addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (file) importPhoto(file).catch((err) => toast(String(err.message ?? err), 'error'));
  });

  // Drag-drop and paste, per plan §6.
  const stage = $('composerStage');
  stage.addEventListener('dragover', (ev) => { ev.preventDefault(); });
  stage.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const file = [...(ev.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (file) importPhoto(file).catch((err) => toast(String(err.message ?? err), 'error'));
  });
  window.addEventListener('paste', (ev) => {
    if ($('viewComposer').hidden) return;
    const item = [...(ev.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile?.();
    if (file) importPhoto(file).catch((err) => toast(String(err.message ?? err), 'error'));
  });

  wirePhotoControls();
  wired = true;
}

// --- entry point ----------------------------------------------------------

/** Open the composer for a device record, restoring its draft if present.
 *  Any previous session is flushed and released first. */
export async function openComposer(device) {
  if (session) {
    await session.flush();   // never lose the outgoing device's edits
    session.release();       // closes bitmaps, invalidates in-flight work
  }
  const draftId = `draft-${device.recordId}`;
  const existing = await store.getDraft(draftId).catch(() => null);
  let document_;
  if (existing?.doc) {
    document_ = model.fromDraft(existing);
    // Panel facts may have changed since the draft was written.
    document_.panel = model.createDocument(device).panel;
  } else {
    document_ = model.createDocument(device);
  }

  session = createSession({
    device,
    draftId,
    document: document_,
    store,
    validate: validateDocument,
    onChange: () => paint(),
    onSaveError: (err) => toast(`Could not save draft: ${err.message ?? err}`, 'error'),
  });

  if (!wired) wire();
  selectTool?.clearSelection();
  rebuildInkOptions();

  // Restore editing proxies for referenced assets (owner-guarded).
  const owner = session;
  const gen = owner.generation();
  for (const layer of document_.layers) {
    if (!layer.assetId) continue;
    const asset = await store.getAsset(layer.assetId).catch(() => null);
    if (!asset?.blob) continue;
    const bmp = await decodeProxy(asset.blob);
    if (!isCurrent(owner, gen)) { bmp.close?.(); return; }
    owner.setBitmap(layer.assetId, bmp);
  }

  // Reclaim assets no longer reachable from any draft; protect this session's.
  store.sweepAssets(model.referencedAssets(document_)).catch(() => {});
  paint();
}

/** Flush pending edits without tearing the session down — used when
 *  navigating away from the composer view (navigating back must still work).
 *  A different device's openComposer() does the flush AND release. */
export async function flushComposer() {
  if (!session) return;
  await session.flush();
}

/** Flush and release entirely (e.g. the open device was forgotten). */
export async function closeComposer({ discard = false } = {}) {
  if (!session) return;
  // `discard` skips the flush: the device (and its draft) are being deleted,
  // so writing the draft back would resurrect it.
  if (!discard) await session.flush();
  session.release();
  session = null;
  selectTool?.clearSelection();
}

/** The record id whose composer session is currently open, if any. */
export function openRecordId() {
  return session?.session?.device?.recordId ?? null;
}

export function hasSession() {
  return !!session;
}
