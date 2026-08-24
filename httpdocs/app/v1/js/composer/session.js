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
    pendingSave: null,
    released: false,
    // Set by the first real user edit. A session that was only OPENED must
    // never write: opening a reconciled draft and navigating away would
    // otherwise persist the reconciliation (dropped QRs, remapped inks) that
    // the user never asked for.
    dirty: false,
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

  function scheduleSave() {
    clearTimeout(session.saveTimer);
    // Capture NOW, not when the timer fires: the session may have been
    // replaced by then.
    const snapshot = {
      id: session.draftId,
      recordId: session.device?.recordId ?? null,
      doc: doc_(),
      generation: session.generation,
    };
    session.saveTimer = setTimeout(() => { void flushSave(snapshot); }, AUTOSAVE_MS);
  }

  async function flushSave(snapshot) {
    // A released session must never write — not via a pending timer, and not
    // via an explicit late flush() either.
    if (session.released) return;
    // Nor may a session that has not been edited (see `dirty`).
    if (!session.dirty) {
      // Still await any save already in flight so callers can rely on flush()
      // meaning "storage is settled".
      if (session.pendingSave) await session.pendingSave;
      return;
    }
    // A snapshot captured before release() must not be written afterwards.
    if (snapshot.generation !== session.generation) return;
    // Serialize: overlapping saves could otherwise land out of order and
    // persist an older document over a newer one.
    const prior = session.pendingSave ?? Promise.resolve();
    session.pendingSave = prior.then(async () => {
      if (session.released || snapshot.generation !== session.generation) return;
      try {
        await store.putDraft(model.toDraft(snapshot.doc, {
          id: snapshot.id,
          recordId: snapshot.recordId,
        }));
      } catch (err) {
        // Never silent: quota and storage failures must reach the user.
        onSaveError?.(err);
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
          session.dirty = true;
          session.history = model.commit(session.history, next);
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

    isDirty: () => session.dirty,

    /** Discrete edit outside a gesture (place text/QR/photo, delete layer).
     *  Rejected edits leave history, the draft and the view untouched. */
    apply(next) {
      validate(next); // throws before anything is committed or scheduled
      session.dirty = true;
      session.history = model.commit(session.history, next);
      session.working = null;
      scheduleSave();
      notify();
    },

    undo() {
      session.dirty = true;
      session.history = model.undo(session.history);
      session.working = null;
      scheduleSave();
      notify();
    },

    redo() {
      session.dirty = true;
      session.history = model.redo(session.history);
      session.working = null;
      scheduleSave();
      notify();
    },

    setBitmap(assetId, bitmap) {
      const prev = session.bitmaps.get(assetId);
      if (prev && prev !== bitmap) prev.close?.(); // never leak a replaced bitmap
      session.bitmaps.set(assetId, bitmap);
    },

    bitmaps: () => session.bitmaps,

    /** Flush any pending autosave and await it (call before switching away). */
    async flush() {
      clearTimeout(session.saveTimer);
      session.saveTimer = null;
      await flushSave({
        id: session.draftId,
        recordId: session.device?.recordId ?? null,
        doc: doc_(),
        generation: session.generation,
      });
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
