/*
 * dither-client.js — main-thread side of the dither worker (plan §6).
 *
 * Currency rules (tightened after review — a stale frame reaching a panel is
 * the worst failure this app can have):
 *  - a result is accepted ONLY if its id is the latest REQUESTED id; a result
 *    that completes while a newer render is queued is dropped, not shown;
 *  - every request carries an `epoch`; results from an earlier epoch (a
 *    different composer session) are discarded even if their id looks current;
 *  - a render is not issued until every asset the document references has been
 *    ACKNOWLEDGED by the worker, so a frame can never be missing a photo;
 *  - at most one pending rerender is queued (rapid edits coalesce);
 *  - a failed asset decode is retryable (never marked sent).
 */

export function createDitherClient({ workerUrl, onResult, onError }) {
  let worker = null;
  let nextId = 1;
  let epoch = 0;
  let inFlight = null;       // id currently rendering
  let queued = null;         // at most one pending request
  let latestRequested = 0;   // newest id handed out
  /** assetId -> 'pending' | 'ready' */
  const assetState = new Map();

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(workerUrl, { type: 'module' });
    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === 'asset-ack') {
        if (assetState.get(msg.assetId) === 'pending') assetState.set(msg.assetId, 'ready');
        pump(); // a render may have been waiting on this asset
        return;
      }
      if (msg.type !== 'render') return;
      if (msg.id === inFlight) inFlight = null;
      const current = msg.id === latestRequested && msg.epoch === epoch;
      if (current) {
        if (msg.ok) onResult?.(msg);
        else onError?.(new Error(msg.error));
      }
      // Anything else is superseded: silently dropped, never shown or sent.
      pump();
    };
    worker.onerror = (ev) => {
      // A fatal worker error leaves it unusable: posting the next render to a
      // dead worker would wedge the composer. Tear it down and forget the
      // assets it held so the next request rehydrates a fresh one.
      inFlight = null;
      queued = null;
      teardownWorker();
      onError?.(new Error(ev.message ?? 'dither worker failed'));
    };
    return worker;
  }

  function teardownWorker() {
    worker?.terminate();
    worker = null;
    assetState.clear();
  }

  function assetsReady(doc) {
    for (const layer of doc.layers ?? []) {
      if (layer.assetId && assetState.get(layer.assetId) !== 'ready') return false;
    }
    return true;
  }

  function pump() {
    if (inFlight || !queued) return;
    // Hold the render until every referenced photo is in the worker: an
    // otherwise-complete frame missing an image must never become sendable.
    if (!assetsReady(queued.doc)) return;
    const req = queued;
    queued = null;
    inFlight = req.id;
    ensureWorker().postMessage({
      type: 'render', id: req.id, epoch: req.epoch, doc: req.doc, options: req.options,
    });
  }

  return {
    /** Hand the worker its OWN bitmap for an asset (transferred once). */
    async addAsset(assetId, blob, decode) {
      if (assetState.has(assetId)) return;
      assetState.set(assetId, 'pending');
      try {
        const bitmap = await decode(blob);
        // A session switch during decode invalidates this bitmap.
        if (!assetState.has(assetId)) { bitmap.close?.(); return; }
        ensureWorker().postMessage({ type: 'asset', assetId, bitmap }, [bitmap]);
      } catch (err) {
        assetState.delete(assetId); // decode failures must stay retryable
        throw err;
      }
    },

    hasAsset(assetId) {
      return assetState.has(assetId);
    },

    assetReady(assetId) {
      return assetState.get(assetId) === 'ready';
    },

    /** Queue a render. Only the newest pending request survives. */
    request(doc, options) {
      const id = nextId++;
      latestRequested = id;
      queued = { id, epoch, doc, options };
      pump();
      return id;
    },

    /** Current epoch — a result carrying a different one is stale. */
    epoch: () => epoch,

    /**
     * Begin a new composer session: bump the epoch (invalidating in-flight
     * work), drop the pending queue and release the worker's bitmaps.
     */
    newEpoch() {
      epoch += 1;
      queued = null;
      inFlight = null;
      // TERMINATE rather than reset: an in-flight asset-ack from the old
      // session could otherwise arrive after the reset and mark a same-hash
      // asset "ready" in the new session, whose bitmap the worker no longer
      // holds — wedging every later render. A fresh worker cannot lie.
      teardownWorker();
      return epoch;
    },

    terminate() {
      teardownWorker();
      inFlight = null;
      queued = null;
    },

    // Test seams.
    _state: () => ({ inFlight, queued: queued?.id ?? null, latestRequested, epoch }),
  };
}
