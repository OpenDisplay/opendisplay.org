/*
 * dither-client.js — main-thread side of the dither worker (plan §6).
 *
 * Enforces the message contract: generation-tagged requests, stale results
 * discarded, at most ONE pending rerender queued (rapid edits coalesce), and
 * per-asset transfer exactly once.
 */

export function createDitherClient({ workerUrl, onResult, onError }) {
  let worker = null;
  let nextId = 1;
  let inFlight = null;      // id currently being rendered
  let queued = null;        // at most one pending request
  let latestAccepted = 0;   // highest id whose result has been applied
  const sentAssets = new Set();

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(workerUrl, { type: 'module' });
    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === 'asset-ack') return;
      if (msg.type !== 'render') return;
      if (msg.id === inFlight) inFlight = null;
      // Discard anything superseded by a newer render.
      if (msg.id < latestAccepted) { pump(); return; }
      latestAccepted = msg.id;
      if (msg.ok) onResult?.(msg);
      else onError?.(new Error(msg.error));
      pump();
    };
    worker.onerror = (ev) => {
      inFlight = null;
      onError?.(new Error(ev.message ?? 'dither worker failed'));
      pump();
    };
    return worker;
  }

  function pump() {
    if (inFlight || !queued) return;
    const req = queued;
    queued = null;
    inFlight = req.id;
    ensureWorker().postMessage({ type: 'render', id: req.id, doc: req.doc, options: req.options });
  }

  return {
    /** Hand the worker its OWN bitmap for an asset (transferred once). */
    async addAsset(assetId, blob, decode) {
      if (sentAssets.has(assetId)) return;
      sentAssets.add(assetId);
      const bitmap = await decode(blob);
      ensureWorker().postMessage({ type: 'asset', assetId, bitmap }, [bitmap]);
    },

    hasAsset(assetId) {
      return sentAssets.has(assetId);
    },

    /** Queue a render. Only the newest pending request survives. */
    request(doc, options) {
      const id = nextId++;
      queued = { id, doc, options };
      pump();
      return id;
    },

    /** Drop every asset except `keep` (e.g. when switching devices). */
    dropAssets(keep = []) {
      const keepSet = new Set(keep);
      for (const id of sentAssets) if (!keepSet.has(id)) sentAssets.delete(id);
      if (worker) worker.postMessage({ type: 'drop', keep: [...keepSet] });
    },

    terminate() {
      worker?.terminate();
      worker = null;
      sentAssets.clear();
      inFlight = null;
      queued = null;
    },

    // Test seams.
    _state: () => ({ inFlight, queued: queued?.id ?? null, latestAccepted }),
  };
}
