/*
 * dither-client.js — main-thread side of the dither worker (plan §6).
 *
 * Currency rules (tightened across two review rounds — a stale frame reaching
 * a panel is the worst failure this app can have):
 *  - a result is accepted ONLY if its id is the latest REQUESTED id;
 *  - every request carries an `epoch`; results from an earlier composer
 *    session are discarded even if their id looks current;
 *  - EVERY worker callback is checked against the worker that is current NOW.
 *    terminate() does not unqueue events already sitting in the main thread's
 *    task queue, so a dead worker's ack/error/result can still arrive after a
 *    session switch — identity, not termination, is the safe boundary;
 *  - each asset load carries an attempt token, so a decode that finishes after
 *    a session switch cannot satisfy (or delete) the new session's claim on
 *    the same content hash;
 *  - a render is not issued until every referenced asset is ACKNOWLEDGED;
 *  - at most one pending rerender is queued (rapid edits coalesce).
 */

export function createDitherClient({ workerUrl, onResult, onError }) {
  let worker = null;
  let nextId = 1;
  let epoch = 0;
  let inFlight = null;       // id currently rendering
  let queued = null;         // at most one pending request
  let latestRequested = 0;   // newest id handed out
  // Ids issued before the last invalidate(). "Newest request wins" is NOT
  // enough on its own: an edit invalidates the frame immediately, but the
  // replacement request is debounced, so for ~180 ms the newest id is still
  // the PRE-edit one. A result arriving in that window would look current and
  // be republished as sendable. Invalidation is synchronous with the edit.
  let staleBefore = 0;
  /** assetId -> {state: 'pending'|'ready', attempt: number} */
  const assetState = new Map();
  let nextAttempt = 1;

  function ensureWorker() {
    if (worker) return worker;
    const self_ = new Worker(workerUrl, { type: 'module' });
    worker = self_;
    self_.onmessage = (ev) => {
      // A message from a worker we have already replaced is stale by
      // definition, whatever it says.
      if (worker !== self_) return;
      const msg = ev.data;
      if (msg.type === 'asset-ack') {
        const entry = assetState.get(msg.assetId);
        if (entry && entry.attempt === msg.attempt) entry.state = 'ready';
        pump();
        return;
      }
      if (msg.type !== 'render') return;
      if (msg.id === inFlight) inFlight = null;
      if (msg.id === latestRequested && msg.epoch === epoch && msg.id >= staleBefore) {
        if (msg.ok) onResult?.(msg);
        else onError?.(new Error(msg.error));
      }
      // Anything else is superseded: silently dropped, never shown or sent.
      pump();
    };
    self_.onerror = (ev) => {
      if (worker !== self_) return; // a dead worker's error changes nothing
      inFlight = null;
      queued = null;
      teardownWorker();
      onError?.(new Error(ev.message ?? 'dither worker failed'));
    };
    return self_;
  }

  function teardownWorker() {
    worker?.terminate();
    worker = null;
    assetState.clear();
  }

  function assetsReady(doc) {
    for (const layer of doc.layers ?? []) {
      if (assetState.get(layer.assetId)?.state !== 'ready' && layer.assetId) return false;
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
      const attempt = nextAttempt++;
      assetState.set(assetId, { state: 'pending', attempt });
      const ownerWorkerAtStart = worker;
      try {
        const bitmap = await decode(blob);
        const entry = assetState.get(assetId);
        // Only OUR attempt may satisfy this claim: after a session switch the
        // map may hold a new session's pending entry for the same hash.
        if (!entry || entry.attempt !== attempt || (ownerWorkerAtStart && worker !== ownerWorkerAtStart)) {
          bitmap.close?.();
          return;
        }
        ensureWorker().postMessage({ type: 'asset', assetId, attempt, bitmap }, [bitmap]);
      } catch (err) {
        const entry = assetState.get(assetId);
        // Never delete a claim that belongs to a newer attempt.
        if (entry && entry.attempt === attempt) assetState.delete(assetId);
        throw err;
      }
    },

    hasAsset(assetId) {
      return assetState.has(assetId);
    },

    assetReady(assetId) {
      return assetState.get(assetId)?.state === 'ready';
    },

    /**
     * Mark every outstanding render stale, synchronously. Call on EVERY change
     * that alters what the frame should contain — before the debounced
     * request that will replace it.
     */
    invalidate() {
      staleBefore = nextId;
      queued = null;
    },

    /** Queue a render. Only the newest pending request survives. */
    request(doc, options) {
      const id = nextId++;
      latestRequested = id;
      queued = { id, epoch, doc, options };
      pump();
      return id;
    },

    /**
     * Drop assets the composer can no longer reach, in BOTH caches. The client
     * forgets them too, so a later undo re-sends the asset rather than
     * rendering against a bitmap the worker has released.
     * @param {Set<string>} keep asset ids still reachable
     */
    pruneAssets(keep) {
      // Deliberately NOT gated on the worker existing: addAsset records its
      // claim before decoding and creates the worker only once the decode
      // lands, so an early return here would leave a pending claim for an
      // unreachable asset — which then installs itself into a fresh worker.
      let dropped = 0;
      for (const id of [...assetState.keys()]) {
        if (keep.has(id)) continue;
        assetState.delete(id);
        dropped++;
      }
      if (dropped && worker) worker.postMessage({ type: 'prune', keep: [...keep] });
    },

    /**
     * True while a render that can still be PUBLISHED is outstanding. An
     * in-flight render issued before the last invalidate() does not count:
     * its result will be dropped, so a caller waiting on it would wait
     * forever.
     */
    pending: () => !!(queued || (inFlight && inFlight >= staleBefore)),

    /** Current epoch — a result carrying a different one is stale. */
    epoch: () => epoch,

    /**
     * Begin a new composer session: bump the epoch, drop the queue and replace
     * the worker. Callbacks already queued from the old worker are ignored by
     * the identity checks above.
     */
    newEpoch() {
      epoch += 1;
      queued = null;
      inFlight = null;
      teardownWorker();
      return epoch;
    },

    terminate() {
      teardownWorker();
      inFlight = null;
      queued = null;
    },

    // Test seams.
    _state: () => ({ inFlight, queued: queued?.id ?? null, latestRequested, epoch, staleBefore }),
  };
}
