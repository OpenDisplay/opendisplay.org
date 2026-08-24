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
import { renderDocument, validateDocument, reconcileDocument } from './render.js';
import { makeSurface, blitPreview } from './canvas.js';
import { createSession } from './session.js';
import { createDitherClient } from './dither-client.js';
import { decodeBounded, SUPPORTED_IMAGE_TYPES } from './image-size.js';
import { prepareSend, panelSignature } from './send.js';
import { errorMessage, describeError } from '../errors.js';
import { paintForSend } from './dither.js';
import { makeCanvas } from './render.js';
import * as adapter from '../ble-adapter.js';
import * as store from '../store.js';

const $ = (id) => document.getElementById(id);

/** Editing proxy cap: full-resolution originals stay in the asset store and
 *  are only decoded at send time (M3). */
const PROXY_MAX_PX = 1600;

let session = null;
let wired = false;
let dither = null;
/** Latest dither result for the OPEN document — the source of the send canvas
 *  and the dithered preview. Cleared whenever the document changes so a stale
 *  frame can never be sent. */
let latestDither = null;
let ditherPending = false;
let sending = false;
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
  // The dithered frame belongs to the PREVIOUS document state; drop it so the
  // send button cannot ship a stale image.
  latestDither = null;
  requestDither();

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
  updateSendControls();
}

function updateSendControls() {
  const connected = adapter.getState() === 'connected'
    && adapter.connectedBleId() != null
    && session?.session?.device?.bleId === adapter.connectedBleId();
  // Sending requires a CURRENT dithered frame: the panel must receive exactly
  // what the preview showed.
  $('sendBtn').disabled = sending || !connected || !latestDither;
  $('sendBtn').title = connected
    ? (latestDither ? '' : 'Preparing the dithered image…')
    : 'Connect this device on the Devices tab first';
}

function toast(msg, kind = 'info') {
  const el = $('composerStatus');
  el.textContent = msg;
  el.dataset.kind = kind;
}

/** Surface an error as actionable guidance (plan §9, M4). */
function reportError(err) {
  const d = describeError(err);
  toast(errorMessage(err), d.kind === 'cancelled' ? 'info' : 'error');
}

// --- photo handling -------------------------------------------------------

/**
 * Decode a bitmap for the WORKER (and therefore the sent frame), bounded by
 * what the panel can actually show rather than by the source resolution.
 *
 * The editing proxy (1600px) can be too SMALL for a large panel, but a modern
 * 48-megapixel phone photo decoded at full size would cost hundreds of MB per
 * asset — on the device most likely to be a phone. The most detail any layer
 * can use is its box in panel pixels, so cap there (×2 for headroom on `cover`
 * crops). decodeBounded reads the header first, so the full-size bitmap is
 * never allocated at all.
 */
function decodeForPanel(blob, panel) {
  const { width, height } = model.artboardSize(panel);
  return decodeBounded(blob, Math.max(1, Math.max(width, height) * 2));
}

/** Decode a ≤PROXY_MAX_PX editing proxy for the interactive canvas; the
 *  original stays in the asset store and the worker gets its own bounded
 *  decode. Also single-step, so a huge photo never lands full-size in memory. */
function decodeProxy(blob) {
  return decodeBounded(blob, PROXY_MAX_PX);
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

// --- dithering -------------------------------------------------------------

function ditherOptions() {
  return {
    mode: Number($('ditherMode').value),
    useMeasured: $('useMeasured').checked,
    serpentine: true,
  };
}

function ensureDitherClient() {
  if (dither) return dither;
  dither = createDitherClient({
    workerUrl: new URL('./dither-worker.js', import.meta.url),
    onResult: (msg) => {
      // Bind the frame to the panel it was rendered for.
      latestDither = { ...msg, signature: panelSignature(doc().panel) };
      ditherPending = false;
      if ($('showDithered').checked) {
        const { canvas, ctx } = makeCanvas(msg.width, msg.height);
        ctx.putImageData(new ImageData(msg.preview, msg.width, msg.height), 0, 0);
        blitPreview($('composerCanvas'), canvas, { width: msg.width, height: msg.height });
      }
      const note = msg.measured ? ' (measured palette)' : '';
      toast(`Preview ready${note}.`);
      updateSendControls();
    },
    onError: (err) => {
      ditherPending = false;
      latestDither = null;
      reportError(err);
      updateSendControls();
    },
  });
  return dither;
}

function requestDither() {
  if (!session) return;
  const client = ensureDitherClient();
  const owner = session;
  const ownerGen = owner.generation();
  const clientEpoch = client.epoch();
  const current = doc();

  // The worker keeps its OWN bitmaps (a transfer would take ours), so send
  // each asset across exactly once — at FULL resolution, since this is the
  // frame that gets sent. The client holds the render until every referenced
  // asset is acknowledged, so a frame can never be missing a photo.
  for (const layer of current.layers) {
    if (!layer.assetId || client.hasAsset(layer.assetId)) continue;
    const assetId = layer.assetId;
    store.getAsset(assetId)
      .then(async (asset) => {
        if (!asset?.blob) return;
        // A device switch during the load invalidates this asset entirely.
        if (!isCurrent(owner, ownerGen) || client.epoch() !== clientEpoch) return;
        await client.addAsset(assetId, asset.blob, (b) => decodeForPanel(b, current.panel));
      })
      .catch((err) => {
        if (isCurrent(owner, ownerGen)) {
          reportError(err);
        }
      });
  }
  ditherPending = true;
  client.request(current, ditherOptions());
}

/** Build the send canvas: dither indices painted back as EXACT ideal-palette
 *  RGB, which is the only form the shared encoder classifies losslessly. */
function buildSendCanvas(frame = latestDither) {
  if (!frame) throw new Error('no dithered frame is ready');
  const { width, height, indices } = frame;
  const panel = doc().panel;
  const expected = model.artboardSize(panel);
  if (width !== expected.width || height !== expected.height) {
    throw new Error(
      `dithered frame ${width}x${height} does not match the artboard ` +
      `${expected.width}x${expected.height}`,
    );
  }
  const rgba = paintForSend(indices, panel.colorScheme, panel.panelIcType);
  const { canvas, ctx } = makeCanvas(width, height);
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return { canvas, width, height };
}

async function sendToDisplay() {
  // Capture the session AND the exact frame SYNCHRONOUSLY: everything below
  // awaits, and the user can open another composer meanwhile. Two identical
  // tags share a panel signature, so signature checks alone cannot tell them
  // apart — only object identity can.
  const owner = session;
  const ownerGen = owner?.generation();
  const frame = latestDither;
  const openRecord = owner?.session?.device;
  if (!openRecord || !frame) return;
  sending = true;
  updateSendControls();
  const progress = $('sendProgress');
  progress.hidden = false;
  progress.value = 0;
  try {
    // All the "may this frame go to this panel?" logic lives in send.js so the
    // switch-during-await interleavings are unit-testable.
    const { record } = await prepareSend({
      owner, ownerGen, frame, record: openRecord,
      currentSession: () => session,
      currentFrame: () => latestDither,
      getDevice: store.getDevice,
      connectedBleId: adapter.connectedBleId,
    });
    // Build from the CAPTURED frame, never from whatever is current now.
    const { canvas } = buildSendCanvas(frame);
    toast('Uploading…');
    const result = await adapter.sendCanvas(canvas, record.colorScheme, {
      rotationQuarterTurns: record.rotationQuarterTurns ?? 0,
      originalWidth: record.width,
      originalHeight: record.height,
      transmissionModes: record.transmissionModes,
      partialUpdateSupport: record.partialUpdateSupport,
      panelIcType: record.panelIcType,
      onProgress: (sent, total) => {
        progress.value = total ? Math.round((sent / total) * 100) : 0;
      },
      onTransferComplete: () => toast('Transfer complete — the panel is refreshing…'),
    });
    // sendCanvas resolves only after the panel's refresh-complete frame —
    // unless the library found nothing to send at all.
    toast(result.skipped
      ? 'Already up to date — the panel image is unchanged.'
      : 'Done — the panel has refreshed.');
  } catch (err) {
    reportError(err);
  } finally {
    sending = false;
    progress.hidden = true;
    updateSendControls();
  }
}

// --- wiring ---------------------------------------------------------------

function wire() {
  // Single-source the accepted formats: the picker's accept attribute is set
  // from the same list the decoder enforces, so they cannot drift.
  $('photoFile').accept = SUPPORTED_IMAGE_TYPES.join(',');

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
      reportError(err);
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
    if (file) importPhoto(file).catch((err) => reportError(err));
  });

  // Drag-drop and paste, per plan §6.
  const stage = $('composerStage');
  stage.addEventListener('dragover', (ev) => { ev.preventDefault(); });
  stage.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const file = [...(ev.dataTransfer?.files ?? [])].find((f) => SUPPORTED_IMAGE_TYPES.includes(f.type));
    if (file) importPhoto(file).catch((err) => reportError(err));
  });
  window.addEventListener('paste', (ev) => {
    if ($('viewComposer').hidden) return;
    const item = [...(ev.clipboardData?.items ?? [])].find((i) => SUPPORTED_IMAGE_TYPES.includes(i.type));
    const file = item?.getAsFile?.();
    if (file) importPhoto(file).catch((err) => reportError(err));
  });

  $('ditherMode').addEventListener('change', () => { latestDither = null; requestDither(); updateSendControls(); });
  $('useMeasured').addEventListener('change', () => { latestDither = null; requestDither(); updateSendControls(); });
  $('showDithered').addEventListener('change', () => {
    if ($('showDithered').checked) requestDither();
    else paint();
  });
  $('sendBtn').addEventListener('click', () => {
    sendToDisplay().catch((err) => reportError(err));
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
  latestDither = null;
  // New epoch: invalidates in-flight renders and releases the worker's bitmaps
  // so a result for the old device can never be shown or sent for the new one.
  dither?.newEpoch();
  const draftId = `draft-${device.recordId}`;
  const existing = await store.getDraft(draftId).catch(() => null);
  let document_;
  let reconcileNote = '';
  if (existing?.doc) {
    document_ = model.fromDraft(existing);
    // The device may have been rebound to different hardware (repair allows
    // dimension and scheme changes), so the draft's layers can be invalid for
    // the panel it is about to render on: reconcile BEFORE installing the
    // session, or paint() throws with an unusable session already in place.
    const previousScheme = document_.panel?.colorScheme;
    document_.panel = model.createDocument(device).panel;
    const { doc: reconciled, changes } = reconcileDocument(document_, previousScheme);
    document_ = reconciled;
    if (changes.length) {
      reconcileNote = `Adjusted for this panel: ${changes.join('; ')}.`;
    }
    try {
      validateDocument(document_);
    } catch (err) {
      // Unreconcilable: start clean rather than install a session that cannot
      // paint. The stored draft is left untouched (nothing is saved until the
      // user edits), so no work is destroyed silently.
      document_ = model.createDocument(device);
      reconcileNote = `Saved draft could not be shown on this panel (${err.message ?? err}) — started a new one.`;
    }
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
    onSaveError: (err) => reportError(err),
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
  if (reconcileNote) toast(reconcileNote, 'error');
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
