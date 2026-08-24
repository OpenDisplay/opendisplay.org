/*
 * dither-worker.js — composite + dither off the main thread (plan §6).
 *
 * Contract (fixed by review):
 *  - the worker NEVER opens IndexedDB: the main thread decodes assets and
 *    hands bitmaps over;
 *  - bitmap OWNERSHIP: a transfer relinquishes the sender's copy, so each
 *    asset is transferred here exactly ONCE and cached by assetId. The main
 *    thread keeps its own separate proxy bitmaps for the live editing
 *    preview; the two caches never share objects. Switching devices replaces
 *    this whole worker rather than pruning it, so `reset` is the only release
 *    path (a stale ack from a surviving worker could otherwise mark a
 *    same-hash asset ready that it no longer holds).
 *  - every render carries a generation id, echoed back so stale results can be
 *    discarded;
 *  - outputs are TRANSFERRED, not cloned.
 *
 * The main thread does the ideal-palette paint-back and owns the send canvas;
 * `ble-common.js` is never touched from a worker.
 */
import { renderDocument } from './render.js';
import { ditherTarget, toRgbTriples, paintPreview } from './dither.js';
import * as lib from '../../vendor/epaper-dithering.js';

/** assetId -> ImageBitmap owned by this worker. */
const assets = new Map();

function setAsset(assetId, bitmap) {
  const prev = assets.get(assetId);
  if (prev && prev !== bitmap) prev.close?.();
  assets.set(assetId, bitmap);
}

function clearAssets() {
  for (const bmp of assets.values()) bmp.close?.();
  assets.clear();
}

self.onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'asset':
      setAsset(msg.assetId, msg.bitmap);
      // Echo the attempt token: the client uses it to ignore an ack that
      // belongs to a superseded load of the same content hash.
      self.postMessage({ type: 'asset-ack', assetId: msg.assetId, attempt: msg.attempt });
      return;
    case 'reset':
      clearAssets();
      return;
    case 'render':
      render(msg);
      return;
    default:
      self.postMessage({ type: 'error', error: `unknown message ${msg.type}` });
  }
};

function render({ id, epoch, doc, options }) {
  try {
    // A frame missing a photo must be a hard error, never a silently
    // incomplete image that could be sent to a panel.
    for (const layer of doc.layers ?? []) {
      if (layer.assetId && !assets.has(layer.assetId)) {
        throw new Error(`asset ${layer.assetId} has not reached the worker`);
      }
    }
    const { ctx, width, height } = renderDocument(doc, assets);
    const composite = ctx.getImageData(0, 0, width, height);

    const scheme = doc.panel.colorScheme;
    const { target, measured } = ditherTarget(lib, {
      colorScheme: scheme,
      panelIcType: doc.panel.panelIcType,
      useMeasured: options?.useMeasured !== false,
    });

    const result = lib.ditherImage(
      { data: composite.data, width, height },
      target,
      {
        mode: options?.mode ?? lib.DitherMode.BURKES,
        serpentine: options?.serpentine !== false,
        // Whole-image pre-dither parameters (document-level, per plan §6).
        ...(doc.tone !== undefined ? { tone: doc.tone } : {}),
        ...(doc.gamut !== undefined ? { gamut: doc.gamut } : {}),
      },
    );

    const palette = toRgbTriples(result.palette);
    // Preview uses the palette we dithered against — measured inks when
    // available, so it matches the physical panel.
    const preview = paintPreview(result.indices, palette);
    const indices = result.indices;

    self.postMessage(
      { type: 'render', id, epoch, ok: true, width, height, measured, indices, preview, palette },
      // Transfer, never clone: these buffers can be megabytes.
      [indices.buffer, preview.buffer],
    );
  } catch (err) {
    self.postMessage({ type: 'render', id, epoch, ok: false, error: String(err?.message ?? err) });
  }
}
