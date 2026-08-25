/*
 * session.js — composer session state machine, DOM-free so it is testable.
 *
 * Two correctness rules this exists to enforce:
 *
 *  1. GESTURE UNDO. A drag or stroke mutates a `working` document; the
 *     committed history is untouched until pointer-up. Undo therefore restores
 *     the PRE-gesture state, not the final one.
 *
 *  2. SESSION ISOLATION. Every session has a generation. Autosaves capture
 *     {draftId, recordId, document} at schedule time, and async work (photo
 *     import, bitmap decode, saves) is discarded if the generation moved on —
 *     so opening device B can never save A's edits into B's draft, or import
 *     A's photo into B's document.
 */
import * as model from './model.js';

export const AUTOSAVE_MS = 500;

// Globally unique per session: a per-session counter starting at 0 would let a
// captured generation from session A compare equal to fresh session B's, so an
// async result from A could be applied to B. Callers must ALSO compare the
// owner object itself (see isCurrent() in composer/index.js).
let nextSessionId = 1;

export function createSession({
  device, draftId, document: doc, store, onChange, onSaveError,
  // Revision of the draft this session loaded. 0 means "there was no draft",
  // which is a real expectation to check against — NOT "don't check", or a
  // first save would silently overwrite a draft another tab just created.
  rev = 0,
  // Throws for a document that cannot be rendered (e.g. a QR that does not
  // fit). Commits are pre-flighted with it so an invalid layer can never
  // enter the history or be autosaved.
  validate = () => {},
}) {
  const session = {
    id: nextSessionId++,
    generation: 0,
    device,
    draftId,
    history: model.createHistory(doc),
    working: null,       // in-flight gesture document
    gestureBase: null,   // committed doc when the gesture began
    bitmaps: new Map(),  // assetId -> ImageBitmap (owned; closed on release)
    saveTimer: null,
    rev,
    pendingSave: null,
    saveFailure: null,
    released: false,
    // Counts committed user edits. A session that was only OPENED must never
    // write: opening a reconciled draft and navigating away would otherwise
    // persist the reconciliation (dropped QRs, remapped inks) that the user
    // never asked for. Comparing against `savedEdits` also makes "dirty" mean
    // *changed since the last successful save* rather than *ever edited*, so
    // flush() can tell an edit that landed DURING a write from one that did
    // not, and so switching away twice does not write twice.
    edits: 0,
    savedEdits: 0,
    // Edits covered by the write currently queued or in flight. Without it,
    // flush()'s catch-up loop would re-queue a write for edits an overlapping
    // flush() had already taken responsibility for.
    savingEdits: 0,
  };

  /** Current document: the gesture's working copy if one is active. */
  function doc_() {
    return session.working ?? session.history.present;
  }

  function notify() {
    onChange?.(doc_(), {
      canUndo: model.canUndo(session.history),
      canRedo: model.canRedo(session.history),
    });
  }

  function isDirty() {
    return session.edits !== session.savedEdits;
  }

  function snapshotNow() {
    return {
      id: session.draftId,
      recordId: session.device?.recordId ?? null,
      doc: doc_(),
      generation: session.generation,
      edits: session.edits,
    };
  }

  function scheduleSave() {
    clearTimeout(session.saveTimer);
    // Capture NOW, not when the timer fires: the session may have been
    // replaced by then.
    const snapshot = snapshotNow();
    // The autosave path has no caller to reject to: flushSave already reported
    // through onSaveError, so swallow here rather than emit an
    // unhandledrejection.
    session.saveTimer = setTimeout(() => { flushSave(snapshot).catch(() => {}); }, AUTOSAVE_MS);
  }

  async function flushSave(snapshot) {
    // A released session must never write — not via a pending timer, and not
    // via an explicit late flush() either.
    if (session.released) return;
    // Nor may a session with nothing new to write (see `edits`).
    if (!isDirty()) {
      // Still await any save already in flight so callers can rely on flush()
      // meaning "storage is settled".
      if (session.pendingSave) await session.pendingSave;
      return;
    }
    // A snapshot captured before release() must not be written afterwards.
    if (snapshot.generation !== session.generation) return;
    // Someone is already writing everything this snapshot holds: wait for that
    // write instead of duplicating it.
    if (session.savingEdits >= snapshot.edits) {
      if (session.pendingSave) await session.pendingSave;
      return;
    }
    session.savingEdits = snapshot.edits;
    // Serialize: overlapping saves could otherwise land out of order and
    // persist an older document over a newer one.
    // A prior failure must not poison the chain for later saves.
    const prior = (session.pendingSave ?? Promise.resolve()).catch(() => {});
    session.pendingSave = prior.then(async () => {
      if (session.released || snapshot.generation !== session.generation) return;
      try {
        session.rev = await store.putDraft(model.toDraft(snapshot.doc, {
          id: snapshot.id,
          recordId: snapshot.recordId,
        }), session.rev);
        // Only the edits this snapshot captured are now on disk; anything
        // committed while the write was in flight keeps the session dirty.
        session.savedEdits = snapshot.edits;
        session.saveFailure = null;
      } catch (err) {
        // Never silent: quota and storage failures must reach the user AND
        // must fail flush(), or a caller that flushes-then-releases would
        // discard the only good copy of the edits.
        session.saveFailure = err;
        // Let a retry re-queue — but only if WE still own the advertised
        // value. A newer snapshot may already have claimed savingEdits while
        // this one was writing; clearing it then would let a third flush
        // duplicate that newer write and burn a revision.
        if (session.savingEdits === snapshot.edits) session.savingEdits = session.savedEdits;
        onSaveError?.(err);
        throw err;
      }
    });
    await session.pendingSave;
  }

  return {
    session,
    id: session.id,
    doc: doc_,
    generation: () => session.generation,
    canUndo: () => model.canUndo(session.history),
    canRedo: () => model.canRedo(session.history),
    selection: null,

    /** Begin a gesture: remember the committed document to undo back to. */
    beginGesture() {
      session.gestureBase = session.history.present;
      session.working = session.history.present;
    },

    /** Apply a mid-gesture document (no history entry). */
    updateGesture(next) {
      session.working = next;
      notify();
    },

    /**
     * End a gesture. `commit` records ONE history entry spanning the whole
     * gesture; otherwise the working copy is discarded entirely.
     */
    endGesture(next, commit) {
      if (commit && next !== session.gestureBase) {
        try {
          validate(next);
          session.edits += 1;
          session.history = model.commit(session.history, next);
          this.pruneBitmaps();
          scheduleSave();
        } catch (err) {
          // Invalid result: drop the whole gesture, keep the committed state.
          session.working = null;
          session.gestureBase = null;
          notify();
          throw err;
        }
      }
      session.working = null;
      session.gestureBase = null;
      notify();
    },

    /**
     * Replace the document WITHOUT recording an edit.
     *
     * For repairs the user did not ask for and must not be charged for —
     * backfilling a photo's natural size into a draft saved before that field
     * existed. It cannot go through apply(): that would push an undo entry the
     * user cannot explain, mark the session dirty, and autosave a change they
     * never made. The document is replaced in place, so undo still leads back
     * to whatever they last did themselves.
     */
    setDocumentQuietly(next) {
      validate(next);
      session.history = { ...session.history, present: next };
      if (session.working) session.working = next;
      notify();
    },

    isDirty,

    /** Discrete edit outside a gesture (place text/QR/photo, delete layer).
     *  Rejected edits leave history, the draft and the view untouched. */
    apply(next) {
      validate(next); // throws before anything is committed or scheduled
      session.edits += 1;
      session.history = model.commit(session.history, next);
      session.working = null;
      // Commit can evict the oldest history entry, which may have been the
      // last thing keeping a deleted photo's decode alive.
      this.pruneBitmaps();
      scheduleSave();
      notify();
    },

    undo() {
      session.edits += 1;
      session.history = model.undo(session.history);
      session.working = null;
      scheduleSave();
      notify();
    },

    redo() {
      session.edits += 1;
      session.history = model.redo(session.history);
      session.working = null;
      scheduleSave();
      notify();
    },

    /**
     * Close bitmaps for assets no longer reachable from the document OR any
     * undo/redo state. Deleting a photo used to leave its decode in memory
     * until the session ended, so importing and deleting a few phone photos
     * kept every proxy alive.
     */
    liveAssetIds() {
      const live = new Set();
      const docs = [session.history.present, ...session.history.past, ...session.history.future];
      if (session.working) docs.push(session.working);
      for (const d of docs) for (const id of model.referencedAssets(d)) live.add(id);
      return live;
    },

    pruneBitmaps() {
      const live = this.liveAssetIds();
      let closed = 0;
      for (const [id, bmp] of session.bitmaps) {
        if (live.has(id)) continue;
        bmp.close?.();
        session.bitmaps.delete(id);
        closed++;
      }
      return closed;
    },

    setBitmap(assetId, bitmap) {
      const prev = session.bitmaps.get(assetId);
      if (prev && prev !== bitmap) prev.close?.(); // never leak a replaced bitmap
      session.bitmaps.set(assetId, bitmap);
    },

    bitmaps: () => session.bitmaps,

    /** True when the last write failed and the edits are only in memory. */
    hasUnsavedFailure: () => !!session.saveFailure,

    /** Replace the cached device record (e.g. after a rebind installed a real
     *  binding), so Send state is judged against current facts. */
    setDevice(record) {
      if (record && record.recordId === session.device?.recordId) session.device = record;
    },

    /** Flush any pending autosave and await it (call before switching away).
     *  REJECTS if the write failed — the caller must not discard the session. */
    async flush() {
      clearTimeout(session.saveTimer);
      session.saveTimer = null;
      // Loop until storage has caught up. The session stays editable while a
      // write is awaiting IndexedDB, and a caller that flushes-then-releases
      // cancels the timer the new edit scheduled — so a single write would
      // silently drop anything typed during it. Bounded, because the only way
      // to spin is a user editing faster than storage settles, forever.
      for (let guard = 0; guard < 16; guard++) {
        if (session.released || !isDirty()) return;
        await flushSave(snapshotNow());
      }
      if (session.released || !isDirty()) return; // the last write caught up
      // Exhausting the guard means edits kept arriving faster than storage
      // could settle. Resolving here would tell openComposer the session is
      // safe to release, which is exactly the data loss the loop exists to
      // prevent — so fail, and let the caller keep the session.
      throw new Error('could not finish saving — edits are still arriving; try again in a moment');
    },

    /** Release owned resources; the session must not be used afterwards. */
    release() {
      session.released = true;
      clearTimeout(session.saveTimer);
      session.saveTimer = null;
      session.generation++; // invalidate in-flight async work
      for (const bmp of session.bitmaps.values()) bmp.close?.();
      session.bitmaps.clear();
    },
  };
}
