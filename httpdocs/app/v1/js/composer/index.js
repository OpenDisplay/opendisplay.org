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
import { makeSurface, blitPreview, layerBounds, handlePoints, handleSize, HANDLES } from './canvas.js';
import { createSession } from './session.js';
import { createDitherClient } from './dither-client.js';
import { decodeBounded, readImageSize, SUPPORTED_IMAGE_TYPES } from './image-size.js';
import { prepareSend, panelSignature } from './send.js';
import { errorMessage, describeError } from '../errors.js';
import { paintForSend } from './dither.js';
import { paletteFor } from './palettes.js';
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
/** The document the last content repaint was for; see the onChange handler. */
let lastContentDoc = null;
let sending = false;
/**
 * Connect/disconnect, injected by the device list.
 *
 * The connection, the permission sweep and the busy gate are all owned there,
 * and there must be exactly one owner — so the composer borrows the actions
 * rather than reimplementing them. Injection rather than an import because
 * devices.js already imports this module; importing back would make a cycle.
 * @type {{connect: (recordId: string) => Promise<void>,
 *         disconnect: () => Promise<void>,
 *         gated: () => boolean} | null}
 */
let connectionActions = null;
let connectionBusy = false;
let drawTool = null;
let selectTool = null;
let textTool = null;
let qrTool = null;
let activeTool = null;

function doc() {
  return session.doc();
}

/**
 * How the canvas is PRESENTED for this device, in quarter turns.
 *
 * Nothing downstream of the DOM ever sees this: renderDocument, the dither
 * worker, paintForSend and the encoder all work in panel space, and the turn
 * is a CSS transform on the canvas wrapper. That is the guarantee this feature
 * cannot change what lands on the panel — structural, not a promise to be
 * careful. Not to be confused with panel.rotationQuarterTurns, which is
 * hardware, swaps the artboard and IS sent.
 */
function viewRotation() {
  return (session?.session?.device?.viewRotationQuarterTurns ?? 0) & 0x03;
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

/** Chosen ink per tool, by palette index. Kept per tool the way od-app keeps
 *  drawColorIndex / textColorIndex / qrColorIndex separately. */
const ink = { draw: 0, text: 0, qr: 0 };

const INK_GROUPS = { drawInk: 'draw', textInk: 'text', qrInk: 'qr' };

/**
 * Rebuild the ink swatches for the CURRENT panel scheme. Swatches rather than a
 * <select>: the choice is a colour, and od-app shows it as one. Only legal
 * indices are offered — Blue on a mono panel would silently render as
 * something else.
 */
function rebuildInkOptions() {
  const scheme = doc().panel.colorScheme;
  const labels = SCHEME_INK_LABELS[scheme] ?? SCHEME_INK_LABELS[0];
  const palette = paletteFor(scheme);
  for (const [groupId, key] of Object.entries(INK_GROUPS)) {
    const host = $(groupId);
    if (!host) continue;
    // Keep the choice if it is still legal, else fall back to black.
    if (ink[key] >= labels.length) ink[key] = 0;
    host.textContent = '';
    labels.forEach((label, index) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'composer__swatch';
      b.dataset.index = String(index);
      b.title = label;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', label);
      const [r, g, bl] = palette[index] ?? [0, 0, 0];
      b.style.background = `rgb(${r},${g},${bl})`;
      b.addEventListener('click', () => {
        ink[key] = index;
        if (key === 'draw') drawTool?.setColor(index);
        markInk(groupId, key);
        applyInkToSelection(index);
      });
      host.appendChild(b);
    });
    markInk(groupId, key);
  }
  drawTool?.setColor(ink.draw);
}

function markInk(groupId, key) {
  for (const b of $(groupId).children) {
    const on = Number(b.dataset.index) === ink[key];
    b.classList.toggle('composer__swatch--active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  }
}

/** Recolour the selected element, so a swatch acts on what is selected rather
 *  than only on the next thing placed (od-app binds the picker the same way). */
function applyInkToSelection(index) {
  const id = selectTool?.selectedId();
  const layer = id && doc().layers.find((l) => l.id === id);
  if (!layer || layer.type === 'photo') return;
  try {
    session.apply(model.updateLayer(doc(), id, { color: index }));
  } catch (err) {
    reportError(err);
  }
}

/**
 * Repaint at most ONCE per animation frame.
 *
 * paint() composites the whole panel synchronously (measured at ~44 ms on an
 * 1872x1404 artboard), and pointermove fires far faster than that, so calling
 * it per event pegs the main thread and the app appears to freeze. Coalescing
 * to a frame keeps dragging responsive on the largest supported panels.
 */
let paintScheduled = false;

/**
 * Repaint after a change to what the PANEL shows.
 *
 * Invalidation is synchronous, before the frame this call was triggered by:
 * everything else here may wait for an animation frame, but frame currency may
 * not — a render completing in the meantime would otherwise be published as if
 * it depicted the new document.
 */
function paint() {
  latestDither = null;
  dither?.invalidate();
  requestDither();
  schedulePaint();
}

/**
 * Repaint WITHOUT invalidating the dithered frame.
 *
 * Selection and preview toggles change only what the editor shows, never what
 * the panel would receive. Routing them through paint() would throw away a
 * correct in-flight render — on a large panel, clicking around while one is
 * running could starve it indefinitely and keep Send disabled.
 */
function repaintOnly() {
  schedulePaint();
}

function schedulePaint() {
  if (paintScheduled) return;
  paintScheduled = true;
  requestAnimationFrame(() => {
    paintScheduled = false;
    paintNow();
  });
}

/** Force a synchronous repaint (tests and teardown paths). */
function paintNow() {
  // NOTE: neither invalidation nor requestDither() belongs here — repaintOnly()
  // lands here too, and a redundant request would carry a NEWER id, which is
  // enough on its own to make an in-flight legitimate result fail the
  // latest-request check. Both belong to paint().
  if (!session) return;

  const { canvas, width, height } = renderDocument(doc(), session.bitmaps());
  blitPreview($('composerCanvas'), canvas, { width, height });
  fitCanvasToStage();
  $('undoBtn').disabled = !session.canUndo();
  $('redoBtn').disabled = !session.canRedo();
  $('deleteLayerBtn').disabled = !selectTool?.selectedId();
  $('clearBtn').disabled = doc().layers.length === 0;
  paintOverlay();
  updatePanelInfo();
  updatePhotoControls();
  updateClipWarning();
  updateSendControls();
}

/**
 * Warn about content that the panel will crop.
 *
 * Bleeding a photo or a rule off the edge is a deliberate layout choice, so it
 * is not worth a warning. A CLIPPED QR is different: it silently stops
 * scanning, and losing part of the quiet zone is enough to do it. This used to
 * be impossible because QR position was forced back onto the artboard — which
 * moved the user's code without telling them.
 */
function updateClipWarning() {
  const { W, H } = size();
  const clipped = doc().layers.filter((l) => {
    if (l.type !== 'qr') return false;
    const b = layerBounds(l, { W, H });
    return !!b && (b.x < 0 || b.y < 0 || b.x + b.w > 1 || b.y + b.h > 1);
  });
  const el = $('composerWarning');
  el.hidden = clipped.length === 0;
  el.textContent = clipped.length
    ? `${clipped.length === 1 ? 'A QR code hangs' : `${clipped.length} QR codes hang`} off the `
      + 'canvas and will be cropped — a cropped code will not scan.'
    : '';
}

function updatePanelInfo() {
  if (!session) return;
  const p = doc().panel;
  const rot = viewRotation();
  $('composerPanelInfo').textContent =
    `${p.width}×${p.height}${p.rotationQuarterTurns ? ` · rot ${p.rotationQuarterTurns * 90}°` : ''}` +
    ` · scheme ${p.colorScheme} · ${doc().layers.length} layer(s)`
    // Worded so a turned VIEW can never be read as a turned PANEL: the panel's
    // own rotation above is hardware and changes what is sent; this does not.
    + (rot ? ` · viewing at ${rot * 90}° (display unchanged)` : '');
  $('viewRotateLeft').disabled = !session;
  $('viewRotateRight').disabled = !session;
}

/** True when the radio is connected to the device this composer is for. */
function connectedToThisDevice() {
  return adapter.getState() === 'connected'
    && adapter.connectedBleId() != null
    && session?.session?.device?.bleId === adapter.connectedBleId();
}

function updateSendControls() {
  const connected = connectedToThisDevice();
  // Sending requires a CURRENT dithered frame: the panel must receive exactly
  // what the preview showed.
  $('sendBtn').disabled = sending || !connected || !latestDither;
  $('sendBtn').title = connected
    ? (latestDither ? '' : 'Preparing the dithered image…')
    : 'Connect this device first — the button next to this one will do it';
  updateConnectControl(connected);
}

/**
 * The composer's own connect/disconnect toggle.
 *
 * Composing offline and connecting only to send is the normal path — tags
 * sleep — so the moment a connection is wanted is the moment the composition
 * is finished, and that is here, not two screens away.
 */
function updateConnectControl(connected = connectedToThisDevice()) {
  const btn = $('connectBtn');
  if (!btn) return;
  const gated = connectionActions?.gated?.() ?? true;
  btn.textContent = connected ? 'Disconnect' : 'Connect';
  btn.disabled = !session || sending || connectionBusy || (!connected && gated);
  const note = connectionActions?.persistenceNote?.();
  btn.title = connected
    ? 'Disconnect from this device. The composition is kept.'
    : gated
      ? 'This browser cannot use Bluetooth, so connecting is not possible here.'
      : 'Connect to this device so the composition can be sent. The tag must be '
        + 'awake and advertising.'
        // Say up front that a chooser is coming, and why — otherwise an
        // unexpected picker looks like the button is broken.
        + (note ? `\n\n${note}` : '');
}

/** Called by the device list at startup; see connectionActions. */
export function setConnectionActions(actions) {
  connectionActions = actions;
  updateConnectControl();
}

async function toggleConnection() {
  if (!session || !connectionActions || connectionBusy) return;
  const recordId = session.session.device?.recordId;
  if (!recordId) return;
  const wasConnected = connectedToThisDevice();
  connectionBusy = true;
  updateConnectControl(wasConnected);
  try {
    // Deliberately no awaits before this call: connecting a device with no
    // remembered permission ends up in requestDevice(), which needs the
    // transient user activation from the click that got us here.
    if (wasConnected) await connectionActions.disconnect();
    else await connectionActions.connect(recordId);
  } catch (err) {
    reportError(err);
  } finally {
    connectionBusy = false;
    // The device list refreshes the record and the connection state for us,
    // but do it here too: this must be right even if that changes.
    await refreshConnectionState();
  }
}

/**
 * Draw the selection outline and resize handles onto the OVERLAY canvas.
 * Never onto the render canvas: that would put UI chrome into the image the
 * dither and the panel would receive.
 */
/** Blit an already-rendered dithered frame onto the preview canvas. */
function showDitheredFrame(frame) {
  const { canvas, ctx } = makeCanvas(frame.width, frame.height);
  ctx.putImageData(new ImageData(frame.preview, frame.width, frame.height), 0, 0);
  blitPreview($('composerCanvas'), canvas, { width: frame.width, height: frame.height });
  paintOverlay(); // the blit does not touch the overlay, but selection may have changed
}

/**
 * Size the canvas box to the panel's aspect ratio inside the stage.
 *
 * The backing store is always panel-resolution; this is purely the on-screen
 * box, the way od-app's canvas is `.aspectRatio(ar, .fit)` in the space it is
 * given. Without it a 122x250 tag renders as a postage stamp and a 1872x1404
 * one overflows the page.
 */
function fitCanvasToStage() {
  const stage = $('composerStage');
  const wrap = $('composerCanvas').parentElement;
  const { W, H } = size();
  if (!(W > 0 && H > 0)) return;
  const rot = viewRotation();
  const swap = rot === 1 || rot === 3;
  // The stage has to hold the ROTATED footprint, or a landscape panel viewed
  // portrait overflows the page.
  const viewW = swap ? H : W;
  const viewH = swap ? W : H;
  const style = getComputedStyle(stage);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const availW = Math.max(120, stage.clientWidth - padding);
  const availH = Math.max(160, window.innerHeight * 0.55);
  const scale = Math.min(availW / viewW, availH / viewH);
  wrap.style.width = `${Math.round(viewW * scale)}px`;
  wrap.style.height = `${Math.round(viewH * scale)}px`;
  // ...while the canvases inside keep the UNROTATED size and are turned by the
  // transform. Both read the same two properties, so they cannot drift apart.
  wrap.style.setProperty('--od-canvas-w', `${Math.round(W * scale)}px`);
  wrap.style.setProperty('--od-canvas-h', `${Math.round(H * scale)}px`);
  wrap.dataset.viewRot = String(rot);
}

/** Selection chrome colour — the same accent the active tool chip uses. */
const SELECTION_ACCENT = '#2b6cb0';

/** How many PANEL pixels make one on-screen CSS pixel right now. */
function screenScale() {
  // The CANVAS, not the wrapper: after an odd quarter turn the wrapper's width
  // is the panel's HEIGHT axis, and comparing those would silently rescale the
  // selection chrome and every handle hit box. clientWidth is the untransformed
  // layout width, so it stays on the panel's own axis at any rotation.
  const canvas = $('composerCanvas');
  const { W } = size();
  const shown = canvas.clientWidth || W;
  return W > 0 ? shown / W : 1;
}

/**
 * Handle size in PANEL pixels chosen so handles are a constant ~11 CSS px on
 * screen. The overlay is drawn at panel resolution, so a fixed panel-pixel
 * size would give tiny handles on a 1872px panel and enormous ones on a 122px
 * tag — the opposite of what the finger needs.
 */
function handlePanelPx() {
  const scale = screenScale();
  return Math.max(3, 11 / (scale || 1));
}

function paintOverlay() {
  const overlay = $('composerOverlay');
  const { W, H } = size();
  // Assigning width/height reallocates the backing store and clears it, which
  // is wasted work when the artboard has not changed.
  if (overlay.width !== W || overlay.height !== H) {
    overlay.width = W;
    overlay.height = H;
  }
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const id = selectTool?.selectedId();
  const layer = id && doc().layers.find((l) => l.id === id);
  if (!layer) return;

  const b = layerBounds(layer, { W, H });
  if (!b) return;
  const px = (v, axis) => v * (axis === 'x' ? W : H);

  // Dashed outline, drawn in two passes so it reads on any panel colour.
  const s_ = screenScale() || 1;
  ctx.save();
  ctx.lineWidth = Math.max(1, 2 / s_);
  ctx.setLineDash([6 / s_, 4 / s_]);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.strokeRect(px(b.x, 'x'), px(b.y, 'y'), px(b.w, 'x'), px(b.h, 'y'));
  ctx.lineDashOffset = 6 / s_;
  ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  ctx.strokeRect(px(b.x, 'x'), px(b.y, 'y'), px(b.w, 'x'), px(b.h, 'y'));
  ctx.restore();

  // Corner handles (strokes have none — they move but do not resize).
  const hpx = handlePanelPx();
  const points = handlePoints(layer, { W, H }, hpx);
  if (!points) return;
  const { hw, hh } = handleSize({ W, H }, hpx);
  ctx.save();
  ctx.lineWidth = Math.max(1, 2 / (screenScale() || 1));
  for (const name of HANDLES) {
    const c = points[name];
    const x = px(c.x, 'x') - px(hw, 'x');
    const y = px(c.y, 'y') - px(hh, 'y');
    const w = px(hw, 'x') * 2;
    const h = px(hh, 'y') * 2;
    // Accent fill with a white keyline, like od-app's selection controls: it
    // reads against both the black and the white end of every panel palette.
    ctx.fillStyle = SELECTION_ACCENT;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  }
  ctx.restore();
}

/** The session prunes its own bitmaps on commit; the worker's cache is the
 *  controller's to release, since only it talks to the client. */
function pruneCaches() {
  if (!session) return;
  dither?.pruneAssets(session.liveAssetIds());
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
 * can use is what it is DRAWN at, so cap there. decodeBounded reads the header
 * first, so the full-size bitmap is never allocated at all.
 *
 * The bound has to follow the zoom. It used to be a flat 2x the panel's
 * longest side, which was reasonable when a photo could not be drawn larger
 * than its box; a photo zoomed to 4x now needs four times as many source
 * pixels for the visible crop, and capping at the old value would send a
 * visibly softer image than the preview promised.
 */
function decodeForPanel(blob, panel, doc_ = null, assetId = null) {
  const { width, height } = model.artboardSize(panel);
  // Largest zoom any layer applies to THIS asset (the same photo may appear
  // more than once at different zooms; the sharpest one wins).
  const zoom = (doc_?.layers ?? [])
    .filter((l) => l.type === 'photo' && l.assetId === assetId)
    .reduce((m, l) => Math.max(m, l.scale ?? 1), 1);
  const headroom = 2 * Math.max(1, Math.min(zoom, model.MAX_PHOTO_SCALE));
  return decodeBounded(blob, Math.max(1, Math.round(Math.max(width, height) * headroom)));
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
  // Record the source's DISPLAY size (EXIF applied) before decoding: the "none"
  // fit draws at natural pixels, and it must mean the same thing for the
  // editor's downscaled proxy as for the send path's larger decode.
  const natural = await readImageSize(blob).catch(() => null);
  const bitmap = await decodeProxy(blob);
  // The session may have been replaced while we hashed and decoded.
  if (!isCurrent(owner, gen)) {
    bitmap.close?.();
    return;
  }
  owner.setBitmap(assetId, bitmap);
  owner.apply(tools.placePhoto(owner.doc(), {
    assetId, srcW: natural?.width ?? null, srcH: natural?.height ?? null,
  }));
  selectPhotoLayer(owner.doc().layers.at(-1).id);
  // Put the photo's own controls — fit, size, rotate, adjustments — in front
  // of the user for the photo they just added, however it arrived (picker,
  // drop or paste).
  setTool('toolPhoto');
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

/**
 * Turn the CANVAS a quarter, left or right.
 *
 * Deliberately not an edit: it never enters the undo history, and it must not
 * go through paint(), which would drop the dithered frame and disable Send to
 * re-render pixels that are identical. The frame already in the backing store
 * stays valid and rotates with the canvas.
 */
async function rotateView(delta) {
  if (!session) return;
  const owner = session;
  const gen = owner.generation();
  const device = owner.session.device;
  if (!device?.recordId) return;
  const next = (((device.viewRotationQuarterTurns ?? 0) + delta) % 4 + 4) % 4;
  try {
    // Persist FIRST: a preference that survives the write is the one to show.
    // updateDevice merges inside one transaction, so a view-only patch cannot
    // erase panel facts a config read landed meanwhile.
    await store.updateDevice(device.recordId, { viewRotationQuarterTurns: next });
  } catch (err) {
    reportError(err);
    return;
  }
  // The user may have switched composers while that was in flight.
  if (!isCurrent(owner, gen)) return;
  // Patch the CACHED record rather than installing one returned from the
  // await: setDevice has no owner guard, and a whole re-read record could
  // carry panel facts from a different moment into this session.
  owner.setDevice({ ...owner.session.device, viewRotationQuarterTurns: next });
  applyViewRotation();
}

/** Presentation-only refresh: geometry, chrome, label. No document render. */
function applyViewRotation() {
  fitCanvasToStage();
  paintOverlay();
  updatePanelInfo();
}

/** Turn the selected photo inside its box. One undo step per press; the box
 *  is untouched, so nothing moves and nothing needs re-clamping. */
function rotateSelectedPhoto(delta) {
  const layer = selectedPhotoLayer();
  if (!layer) return;
  const next = (((layer.rotationQuarterTurns ?? 0) + delta) % 4 + 4) % 4;
  try {
    session.apply(model.updateLayer(doc(), layer.id,
      // Turning swaps the footprint's axes, so a pan that was legal before can
      // put the photo out of reach. Re-apply the rule against the NEW shape.
      withPanInBounds({ ...layer, rotationQuarterTurns: next })));
  } catch (err) {
    reportError(err);
  }
}

/** A patch for `layer` that keeps its pan legal for its CURRENT footprint. */
function withPanInBounds(layer) {
  const pan = tools.clampPan(layer, layer.panX ?? 0, layer.panY ?? 0, size());
  return {
    rotationQuarterTurns: layer.rotationQuarterTurns,
    fit: layer.fit,
    scale: layer.scale,
    ...pan,
  };
}

function updatePhotoControls() {
  const layer = selectedPhotoLayer();
  $('photoControls').hidden = !layer;
  $('photoEmptyHint').hidden = !!layer;
  $('photoEmptyHint').textContent = doc().layers.some((l) => l.type === 'photo')
    ? 'Select a photo on the canvas with Move to adjust it — drag to pan it, Zoom to scale it.'
    : 'No photo yet. Choose one; it fills the canvas, then drag to pan and Zoom to scale.';
  if (!layer) return;
  $('photoFit').value = layer.fit;
  // Keep the slider in step with the selected layer, or the next drag would
  // jump it to a stale value.
  $('photoSize').value = String(layer.scale ?? 1);
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
    if (!layer) return;
    // Each mode is a clean framing baseline, so switching resets the zoom and
    // the pan — od-app's ComposerView.setFitMode does exactly this. It also
    // means a fit change can never stand a photo somewhere its new footprint
    // cannot be reached from.
    session.apply(model.updateLayer(doc(), layer.id, {
      fit: ev.target.value, scale: 1, panX: 0, panY: 0,
    }));
    $('photoSize').value = '1';
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
    // Zoom on top of the fit baseline — od-app's pinch, as a slider. Zooming
    // about the photo's own centre is what a pinch does, so the pan is kept —
    // but it must still be re-clamped, because SHRINKING a photo that was
    // panned to the edge can leave its smaller footprint entirely off-canvas.
    const scale = model.clampPhotoScale(Number($('photoSize').value));
    session.updateGesture(model.updateLayer(doc(), layer.id,
      withPanInBounds({ ...layer, scale })));
  });
  $('connectBtn').addEventListener('click', () => { toggleConnection(); });
  $('viewRotateLeft').addEventListener('click', () => { rotateView(-1); });
  $('viewRotateRight').addEventListener('click', () => { rotateView(1); });
  $('photoRotateLeft').addEventListener('click', () => rotateSelectedPhoto(-1));
  $('photoRotateRight').addEventListener('click', () => rotateSelectedPhoto(1));
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
      if (!session) return; // the composer closed while this render was in flight
      // Bind the frame to the panel it was rendered for.
      latestDither = { ...msg, signature: panelSignature(doc().panel) };
      if ($('showDithered').checked) showDitheredFrame(latestDither);
      const note = msg.measured ? ' (measured palette)' : '';
      toast(`Preview ready${note}.`);
      updateSendControls();
    },
    onError: (err) => {
      latestDither = null;
      reportError(err);
      updateSendControls();
    },
  });
  return dither;
}

let ditherTimer = null;

/**
 * Ask for a dithered frame once the document has SETTLED.
 *
 * Dithering a full panel is expensive and its result is only needed for the
 * preview and for sending, so firing one per pointermove burns the worker (and
 * the structured-clone cost of the document) for frames nobody sees. A short
 * debounce collapses a whole drag into a single dither.
 */
function requestDither() {
  clearTimeout(ditherTimer);
  ditherTimer = setTimeout(() => { void requestDitherNow(); }, 180);
}

function requestDitherNow() {
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
        // A device switch during the load invalidates this asset entirely.
        if (!isCurrent(owner, ownerGen) || client.epoch() !== clientEpoch) return;
        if (!asset?.blob) {
          throw new Error(
            'A photo in this composition is missing from storage — delete that layer '
            + 'or re-import the image to send this composition.',
          );
        }
        await client.addAsset(assetId, asset.blob,
          (b) => decodeForPanel(b, current.panel, current, assetId));
      })
      .catch((err) => {
        if (!isCurrent(owner, ownerGen)) return;
        // NEVER mutate the document here. A transient storage hiccup must not
        // delete the user's photo layer (session.apply would also autosave the
        // deletion), and even a permanently missing asset is the user's to
        // remove. The dithered frame simply never becomes ready, so Send stays
        // disabled and the error says what to do.
        reportError(err);
      });
  }
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

// --- tools ----------------------------------------------------------------

/**
 * Tap-to-place tool for text and QR, mirroring od-app: the panel holds the
 * content and the canvas tap chooses the position. The whole placement is one
 * gesture so it lands as a single undo step, and an invalid result (a QR that
 * cannot fit) is reported instead of thrown at the pointer handler.
 */
function makePlaceTool(kind) {
  let placed = false;
  return {
    name: kind,
    onDown(document_, pt) {
      placed = false;
      const next = placeAt(document_, kind, pt);
      if (!next) return { doc: document_, commit: false };
      placed = true;
      return { doc: next, commit: false };
    },
    onMove(document_) { return { doc: document_, commit: false }; },
    onUp(document_) {
      const did = placed;
      placed = false;
      return { doc: document_, commit: did };
    },
  };
}

/** Build the layer described by the text/QR panel at `pt`, or null if the
 *  panel has nothing to place. Throws only for content the panel cannot fit. */
function placeAt(document_, kind, pt) {
  if (kind === 'text') {
    const text = $('textContent').value.trim();
    if (!text) return null;
    return tools.placeText(document_, pt, {
      text, size: Number($('textSize').value), color: ink.text,
    });
  }
  const text = $('qrContent').value.trim();
  if (!text) return null;
  return tools.placeQr(document_, pt, {
    text, size: Number($('qrSize').value), color: ink.qr,
    errorCorrectLevel: $('qrEcc').value,
  });
}

/** "Add it in the middle" — the keyboard-reachable equivalent of a canvas tap. */
function placeCentred(kind) {
  try {
    const next = placeAt(doc(), kind, { x: 0.5, y: 0.5 });
    if (!next) {
      toast(kind === 'text' ? 'Type some text first.' : 'Enter the QR content first.', 'error');
      return;
    }
    // placeText/placeQr anchor at the point; centre the element on it.
    const layer = next.layers.at(-1);
    const b = layerBounds(layer, size());
    session.apply(model.updateLayer(next, layer.id, {
      x: layer.x - (b?.w ?? 0) / 2, y: layer.y - (b?.h ?? 0) / 2,
    }));
    selectTool.setSelection(next.layers.at(-1).id);
  } catch (err) {
    reportError(err);
  }
}

/** Push the panel's content/ECC onto the SELECTED element of that kind. */
function retitleSelected(kind) {
  const layer = selectedOfType(kind);
  if (!layer) return;
  const patch = kind === 'text'
    ? { text: $('textContent').value.trim() }
    : { text: $('qrContent').value.trim(), errorCorrectLevel: $('qrEcc').value };
  if (!patch.text) return;
  try {
    session.apply(model.updateLayer(doc(), layer.id, patch));
  } catch (err) {
    reportError(err);
  }
}

function resizeSelected(kind) {
  const layer = selectedOfType(kind);
  if (!layer) return;
  const value = Number(kind === 'text' ? $('textSize').value : $('qrSize').value);
  try {
    session.apply(model.updateLayer(doc(), layer.id, { size: value }));
  } catch (err) {
    reportError(err);
  }
}

function selectedOfType(kind) {
  const id = selectTool?.selectedId();
  const layer = id && doc().layers.find((l) => l.id === id);
  return layer && layer.type === kind ? layer : null;
}

const CHIP_TOOLS = {
  toolSelect: () => selectTool,
  toolDraw: () => drawTool,
  toolText: () => textTool,
  toolQr: () => qrTool,
  toolPhoto: () => selectTool,
  toolDither: () => selectTool,
};

/** Activate a chip: switch the tool AND reveal only that tool's panel. */
function setTool(chipId) {
  activeTool = CHIP_TOOLS[chipId]?.() ?? selectTool;
  for (const chip of document.querySelectorAll('.composer__chip')) {
    const on = chip.id === chipId;
    chip.classList.toggle('composer__chip--active', on);
    chip.setAttribute('aria-selected', on ? 'true' : 'false');
    const panel = $(chip.dataset.panel);
    if (panel) panel.hidden = !on;
  }
  const canvas = $('composerCanvas');
  canvas.dataset.tool = activeTool === selectTool ? 'select' : activeTool.name;
}

// --- wiring ---------------------------------------------------------------

function wire() {
  // Single-source the accepted formats: the picker's accept attribute is set
  // from the same list the decoder enforces, so they cannot drift.
  $('photoFile').accept = SUPPORTED_IMAGE_TYPES.join(',');

  drawTool = tools.makeDrawTool({ color: 0, width: 0.012 });
  selectTool = tools.makeSelectTool({
    onSelect: () => repaintOnly(),
    handlePx: () => handlePanelPx(),
  });
  textTool = makePlaceTool('text');
  qrTool = makePlaceTool('qr');
  activeTool = selectTool;

  for (const chip of document.querySelectorAll('.composer__chip')) {
    chip.addEventListener('click', () => setTool(chip.id));
  }
  // The Photo chip's panel holds the picker; opening the panel is the whole
  // action, so it selects the Move tool underneath (od-app does the same —
  // its photo tool leaves the canvas in .move).
  $('addTextBtn').addEventListener('click', () => placeCentred('text'));
  $('addQrBtn').addEventListener('click', () => placeCentred('qr'));
  $('drawWidth').addEventListener('change', (ev) => drawTool.setWidth(Number(ev.target.value)));
  // Retyping re-arms placement feedback and re-renders a selected element.
  $('textContent').addEventListener('change', () => retitleSelected('text'));
  $('qrContent').addEventListener('change', () => retitleSelected('qr'));
  $('textSize').addEventListener('change', () => resizeSelected('text'));
  $('qrSize').addEventListener('change', () => resizeSelected('qr'));
  $('qrEcc').addEventListener('change', () => retitleSelected('qr'));

  // A tool may reject the edit it is asked for — a QR whose content cannot fit
  // the panel is the real case. Report it and abandon the gesture rather than
  // letting it escape a pointer handler as an unhandled error.
  const guard = (fn) => (pt) => {
    try {
      fn(pt);
    } catch (err) {
      try { session?.endGesture(doc(), false); } catch { /* already ended */ }
      reportError(err);
    }
  };
  makeSurface($('composerCanvas'), {
    viewRotation,
    onPointerDown: guard((pt) => {
      session.beginGesture();
      const r = activeTool.onDown(doc(), pt, size());
      session.updateGesture(r.doc);
    }),
    onPointerMove: guard((pt) => {
      const r = activeTool.onMove(doc(), pt, size());
      session.updateGesture(r.doc);
    }),
    onPointerUp: guard((pt) => {
      const r = activeTool.onUp(doc(), pt, size());
      session.endGesture(r.doc, r.commit);
      // Placement is a one-shot: hand the canvas back to Move so the next tap
      // selects what was just placed instead of stamping another copy.
      if (r.commit && (activeTool === textTool || activeTool === qrTool)) {
        selectTool.setSelection(doc().layers.at(-1)?.id ?? null);
        setTool('toolSelect');
      }
    }),
  });

  $('undoBtn').addEventListener('click', () => session.undo());
  $('redoBtn').addEventListener('click', () => session.redo());
  $('deleteLayerBtn').addEventListener('click', () => {
    const id = selectTool.selectedId();
    if (!id) return;
    selectTool.clearSelection();
    session.apply(model.removeLayer(doc(), id));
  });

  $('clearBtn').addEventListener('click', () => {
    if (!doc().layers.length) return;
    selectTool.clearSelection();
    // One history entry, so a mis-click is a single Undo away. No confirm
    // dialog for that reason.
    session.apply(model.clearLayers(doc()));
    toast('Canvas cleared — Undo restores it.');
  });

  $('photoFile').addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (file) importPhoto(file).catch((err) => reportError(err));
  });

  // The box is derived from the viewport, so it has to follow it.
  window.addEventListener('resize', () => { if (session) fitCanvasToStage(); });

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

  const ditherOptionChanged = () => {
    latestDither = null;
    dither?.invalidate(); // the in-flight render used the OLD options
    requestDither();
    updateSendControls();
  };
  $('ditherMode').addEventListener('change', ditherOptionChanged);
  $('useMeasured').addEventListener('change', ditherOptionChanged);
  $('showDithered').addEventListener('change', () => {
    // Showing or hiding the dithered preview changes the editor's view only —
    // so never spend a render on it. A frame we already have is displayed as
    // it is; a request is issued only if there is none AND none is coming,
    // because a fresh request carries a newer id and would supersede the
    // in-flight one that is about to answer.
    if (!$('showDithered').checked) { repaintOnly(); return; }
    if (latestDither) showDitheredFrame(latestDither);
    else if (!dither?.pending()) requestDither();
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
export async function openComposer(record) {
  // STAGED HANDOFF. Everything that can fail — flushing the outgoing session,
  // reading and reconciling the incoming draft — happens BEFORE the old
  // session is released or the global is reassigned. Releasing first meant a
  // failed read left a released "zombie" session installed: still editable,
  // but permanently unable to save.
  //
  // Re-read the record rather than trusting the one the device CARD captured
  // when the list was rendered: that copy is as old as the last render, so
  // rotating device A's canvas, opening B, then reopening A from the unchanged
  // card would bring back the stale preference. Falls back to the captured
  // copy if the read fails — an unreachable database is not a reason to refuse
  // to open the composer.
  const device = (await store.getDevice(record.recordId).catch(() => null)) ?? record;
  const draftId = `draft-${device.recordId}`;

  // 1. Persist the outgoing session. A write failure ABORTS the switch rather
  //    than throwing away the only copy of those edits.
  if (session) {
    try {
      await session.flush();
    } catch (err) {
      throw new Error(
        `Could not save the current composition, so it was not closed: ${err.message ?? err}`,
      );
    }
  }

  // 2. Build the incoming document. Still no mutation of live state.
  let existing;
  try {
    existing = await store.getDraft(draftId);
  } catch (err) {
    throw new Error(`Could not open the saved draft for this device: ${err.message ?? err}`);
  }
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
      // Photos used to carry a box; convert before anything tries to render.
      document_ = model.migrateDocument(document_);
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

  // 3. An edit may have landed while step 2 was reading storage — the outgoing
  //    session is still live and editable until now. Flush again so that edit
  //    is not cancelled by release().
  if (session?.isDirty()) {
    try {
      await session.flush();
    } catch (err) {
      throw new Error(
        `Could not save the current composition, so it was not closed: ${err.message ?? err}`,
      );
    }
  }

  // 4. Only now commit: release the old session and install the new one.
  if (session) session.release();
  latestDither = null;
  // New epoch: invalidates in-flight renders and releases the worker's bitmaps
  // so a result for the old device can never be shown or sent for the new one.
  dither?.newEpoch();

  session = createSession({
    device,
    draftId,
    document: document_,
    rev: existing?.rev ?? 0,
    store,
    validate: validateDocument,
    onChange: (nextDoc) => {
      // Prune on every committed change, not just Delete/Clear: a bitmap kept
      // for Undo becomes garbage once it is evicted from the bounded history.
      pruneCaches();
      // A gesture that changed nothing still notifies — a plain selection
      // click runs update/endGesture over the same immutable document. Treat
      // that as a repaint, not a content change, or clicking around during a
      // large-panel render would discard render after render. Documents are
      // immutable, so identity is a sound "unchanged" test.
      if (nextDoc === lastContentDoc) {
        repaintOnly();
        return;
      }
      lastContentDoc = nextDoc;
      paint();
    },
    onSaveError: (err) => reportError(err),
  });

  if (!wired) wire();
  selectTool?.clearSelection();
  setTool('toolSelect');   // every open starts on Move, with only its panel up
  rebuildInkOptions();

  // Restore editing proxies for referenced assets (owner-guarded).
  const owner = session;
  const gen = owner.generation();
  for (const layer of document_.layers) {
    if (!layer.assetId) continue;
    let asset;
    try {
      asset = await store.getAsset(layer.assetId);
    } catch (err) {
      reportError(err);
      continue;
    }
    if (!asset?.blob) continue;
    // A corrupt or newly-undecodable stored image must not reject
    // openComposer: the session is already installed by this point, and
    // throwing would leave it hidden with the old one gone.
    try {
      const bmp = await decodeProxy(asset.blob);
      if (!isCurrent(owner, gen)) { bmp.close?.(); return; }
      owner.setBitmap(layer.assetId, bmp);
    } catch (err) {
      reportError(err);
    }
    // Backfill the natural size for drafts saved before it was recorded. Every
    // photo's geometry is derived from it — the bitmap cannot stand in, because
    // the editor's is a downscaled proxy — so a layer without it falls back to
    // the canvas dimensions and draws at the wrong aspect until this lands.
    if (layer.srcW == null || layer.srcH == null) {
      try {
        const natural = await readImageSize(asset.blob);
        if (!isCurrent(owner, gen)) return;
        if (natural?.width > 0 && natural?.height > 0) {
          owner.setDocumentQuietly(model.updateLayer(owner.doc(), layer.id, {
            srcW: natural.width, srcH: natural.height,
          }));
        }
      } catch { /* leave the fallback in place; it is at least self-consistent */ }
    }
  }

  // Reclaim assets no longer reachable from any draft; protect this session's.
  store.sweepAssets(model.referencedAssets(document_)).catch(() => {});
  // Baseline for the unchanged-document check in onChange.
  lastContentDoc = session.doc();
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
  // Clear the selection BEFORE the session goes: clearSelection fires the
  // selection callback, which schedules a repaint that would dereference it.
  selectTool?.clearSelection();
  // Retire the epoch too, or an already-accepted render can still land in
  // onResult and read doc() off the session we are about to drop. Forgetting
  // the open device takes exactly this path.
  dither?.newEpoch();
  latestDither = null;
  lastContentDoc = null;
  session.release();
  session = null;
}

/** The record id whose composer session is currently open, if any. */
export function openRecordId() {
  return session?.session?.device?.recordId ?? null;
}

/** Test seam: the open document. Read-only — the document is immutable. */
export function _doc() {
  return session ? doc() : null;
}

export function hasSession() {
  return !!session;
}

/**
 * Re-evaluate Send.
 *
 * The composer's Send state depends on the CONNECTION, which is owned by the
 * device list — a different module. Compose-offline-then-connect is the normal
 * workflow (tags sleep), so without this the intended path leaves Send stuck
 * disabled after connecting, and a disconnect leaves it stuck enabled until
 * something else happens to repaint.
 */
export async function refreshConnectionState() {
  if (!session) return;
  const owner = session;
  const gen = owner.generation();
  // Reflect the adapter's state at once: a disconnect must disable Send now,
  // not after an IndexedDB read that could be slow or blocked.
  updateSendControls();
  const recordId = owner.session.device?.recordId;
  if (recordId) {
    // Re-read the record: a repair/rebind may have installed the real binding
    // (imported records start with bleId null), and comparing the connection
    // against the copy captured when the composer opened would keep Send
    // disabled forever.
    try {
      const fresh = await store.getDevice(recordId);
      // "Still a session" is NOT enough. setDevice only checks that the record
      // ids match, so closing this composer and reopening the SAME device
      // builds a new session that would happily accept this older read — and
      // with it whatever the record looked like at the earlier moment.
      if (fresh && isCurrent(owner, gen)) owner.setDevice(fresh);
    } catch { /* fall through to the cached copy */ }
  }
  if (!isCurrent(owner, gen)) return;   // a switch happened while we read
  updateSendControls();
}
