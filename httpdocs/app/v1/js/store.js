/*
 * store.js — IndexedDB persistence (DESIGN_WEB_OD_APP_PLAN.md §4).
 *
 * Identity model: `recordId` (random UUID) is the immutable app identity;
 * `bleId` (BluetoothDevice.id) is a replaceable permission binding. Keys and
 * drafts reference recordId, so rebinding never orphans them.
 *
 * Every read/write is try/catch-safe at the call site: an empty or unavailable
 * DB is a valid state, and quota errors surface as thrown errors for the UI —
 * never silent data loss.
 */

const DB_NAME = 'od-app';
const DB_VERSION = 1;

let dbPromise = null;
let persistRequested = false;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('devices')) {
        const devices = db.createObjectStore('devices', { keyPath: 'recordId' });
        devices.createIndex('bleId', 'bleId', { unique: false });
      }
      if (!db.objectStoreNames.contains('keys')) {
        db.createObjectStore('keys', { keyPath: 'recordId' });
      }
      if (!db.objectStoreNames.contains('drafts')) {
        const drafts = db.createObjectStore('drafts', { keyPath: 'id' });
        drafts.createIndex('recordId', 'recordId', { unique: false });
      }
      if (!db.objectStoreNames.contains('assets')) {
        db.createObjectStore('assets', { keyPath: 'assetId' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // A future migration in another tab must not deadlock on this one.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null; // allow retry
      reject(req.error ?? new Error('IndexedDB open failed'));
    };
    req.onblocked = () => {
      dbPromise = null; // blocked must be retryable, same as error
      reject(new Error('IndexedDB open blocked'));
    };
  });
  return dbPromise;
}

// Best-effort durability: a request the browser may deny — and one that can
// hang indefinitely where no permission backend exists (headless). Therefore
// STRICTLY fire-and-forget: callers never await it, writes never gate on it.
let persistenceListener = null;

/** Called ONCE if durable storage could not be CONFIRMED — denied, rejected,
 *  unsupported or too slow to answer — so the UI can warn that devices, drafts
 *  and keys may be evicted (plan §9, M4). */
export function onPersistenceDenied(fn) {
  persistenceListener = fn;
}

/**
 * Is storage durable? Resolves TRUE only on an explicit grant; false covers
 * denial, rejection, a synchronous throw, an unsupported API and a slow or
 * absent answer — all of which mean durability was NOT established. Exported
 * for testing; no write ever awaits it.
 * @param {(() => Promise<boolean>)|undefined} persistFn
 */
export async function checkPersistence(persistFn, timeoutMs = 3000) {
  if (typeof persistFn !== 'function') return false;
  try {
    const UNCONFIRMED = Symbol('unconfirmed');
    // Timeboxed AND non-blocking: this can hang where no permission backend
    // exists, and no write may ever wait on it.
    const granted = await Promise.race([
      Promise.resolve(persistFn()),
      new Promise((r) => setTimeout(() => r(UNCONFIRMED), timeoutMs)),
    ]);
    return granted === true;
  } catch {
    return false;
  }
}

function requestPersistence() {
  if (persistRequested) return;
  persistRequested = true;
  try {
    checkPersistence(navigator.storage?.persist?.bind(navigator.storage))
      .then((confirmed) => { if (!confirmed) persistenceListener?.(); })
      .catch(() => persistenceListener?.());
  } catch {
    // Even a synchronous throw means durability was not established.
    persistenceListener?.();
  }
}

function tx(db, stores, mode) {
  return db.transaction(stores, mode);
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('transaction failed'));
  });
}

export function newRecordId() {
  return crypto.randomUUID();
}

/** Create a device record. Caller supplies fields from a REAL config read. */
export async function createDevice(fields) {
  requestPersistence();
  const db = await openDb();
  const record = {
    recordId: newRecordId(),
    bleId: fields.bleId ?? null,
    name: fields.name ?? 'OpenDisplay',
    width: fields.width,
    height: fields.height,
    rotationQuarterTurns: fields.rotationQuarterTurns ?? 0,
    colorScheme: fields.colorScheme,
    transmissionModes: fields.transmissionModes ?? 0,
    partialUpdateSupport: fields.partialUpdateSupport ?? 0,
    panelIcType: fields.panelIcType ?? null,
    resolutionConfirmed: fields.resolutionConfirmed === true,
    authRequired: fields.authRequired === true,
    firmwareVersion: fields.firmwareVersion ?? null,
    msdSnapshotHex: fields.msdSnapshotHex ?? null,
    lastSeen: Date.now(),
    createdAt: Date.now(),
  };
  const t = tx(db, ['devices'], 'readwrite');
  t.objectStore('devices').add(record);
  await txDone(t);
  return record;
}

export async function updateDevice(recordId, patch) {
  const db = await openDb();
  const t = tx(db, ['devices'], 'readwrite');
  const store = t.objectStore('devices');
  const existing = await reqAsPromise(store.get(recordId));
  if (!existing) throw new Error(`device record ${recordId} not found`);
  const updated = { ...existing, ...patch, recordId };
  store.put(updated);
  await txDone(t);
  return updated;
}

export async function listDevices() {
  const db = await openDb();
  return reqAsPromise(tx(db, ['devices'], 'readonly').objectStore('devices').getAll());
}

export async function getDevice(recordId) {
  const db = await openDb();
  return reqAsPromise(tx(db, ['devices'], 'readonly').objectStore('devices').get(recordId));
}

/**
 * Two-phase rebind COMMIT (plan §4): validation (auth + config read) happened
 * first — this writes the new binding AND the validated metadata patch in ONE
 * transaction, so a rebind is never observable half-applied. Keys/drafts
 * follow via recordId.
 */
export async function commitRebind(recordId, newBleId, patch = {}) {
  const db = await openDb();
  const t = tx(db, ['devices'], 'readwrite');
  const store = t.objectStore('devices');
  const existing = await reqAsPromise(store.get(recordId));
  if (!existing) throw new Error(`device record ${recordId} not found`);
  store.put({ ...existing, ...patch, recordId, bleId: newBleId, lastSeen: Date.now() });
  await txDone(t);
}

// --- drafts ---

/**
 * Write a draft, verifying IN THE SAME TRANSACTION that its device still
 * exists. Another tab may have forgotten the device while this tab was
 * editing; without the check, its autosave would resurrect an orphan draft
 * (and keep the device's photos alive forever).
 */
export async function putDraft(draft) {
  requestPersistence();
  const db = await openDb();
  const t = tx(db, ['devices', 'drafts'], 'readwrite');
  if (draft.recordId) {
    const device = await reqAsPromise(t.objectStore('devices').get(draft.recordId));
    if (!device) {
      t.abort();
      throw new Error(`device ${draft.recordId} no longer exists — draft not saved`);
    }
  }
  t.objectStore('drafts').put(draft);
  await txDone(t);
}

export async function getDraft(id) {
  const db = await openDb();
  return reqAsPromise(tx(db, ['drafts'], 'readonly').objectStore('drafts').get(id));
}

export async function listDrafts() {
  const db = await openDb();
  return reqAsPromise(tx(db, ['drafts'], 'readonly').objectStore('drafts').getAll());
}

export async function listDraftsFor(recordId) {
  const db = await openDb();
  return reqAsPromise(
    tx(db, ['drafts'], 'readonly').objectStore('drafts').index('recordId').getAll(recordId),
  );
}

export async function deleteDraft(id) {
  const db = await openDb();
  const t = tx(db, ['drafts'], 'readwrite');
  t.objectStore('drafts').delete(id);
  await txDone(t);
}

// --- assets (content-addressed; stored ONCE, referenced by drafts/layers) ---

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Store a blob under its content hash. Identical images added twice occupy one
 * entry — which is exactly why deletion must be reachability-based (below).
 */
export async function putAsset(blob) {
  requestPersistence();
  const assetId = await sha256Hex(await blob.arrayBuffer());
  const db = await openDb();
  const t = tx(db, ['assets'], 'readwrite');
  const store = t.objectStore('assets');
  const existing = await reqAsPromise(store.get(assetId));
  const now = Date.now();
  if (existing) {
    // Re-importing identical content must REFRESH the claim: an old,
    // currently-unreferenced entry would otherwise be swept by another tab
    // during this import's asset→draft window.
    store.put({ ...existing, lastClaimedAt: now });
  } else {
    store.put({
      assetId, blob, type: blob.type, size: blob.size,
      createdAt: now, lastClaimedAt: now,
    });
  }
  await txDone(t);
  return assetId;
}

export async function getAsset(assetId) {
  const db = await openDb();
  return reqAsPromise(tx(db, ['assets'], 'readonly').objectStore('assets').get(assetId));
}

/**
 * Reference-safe garbage collection: sweep every asset not reachable from any
 * draft (layer assetIds + thumbnails). Content-addressed assets are SHARED, so
 * per-draft deletion would corrupt other drafts; this is the only safe form.
 * Also reclaims crash-orphans (an asset stored whose draft write never landed).
 * Assets younger than ASSET_GRACE_MS are never swept: an import stores the
 * asset before the draft that references it, and another tab's sweep must not
 * classify that window as garbage.
 * @param {Set<string>} extraLive ids referenced by unsaved in-memory documents
 */
export const ASSET_GRACE_MS = 5 * 60 * 1000;

export async function sweepAssets(extraLive = new Set(), { graceMs = ASSET_GRACE_MS } = {}) {
  const db = await openDb();
  // ONE transaction spanning both stores: reading drafts and deleting assets
  // separately would let a draft acquire a reference in between and lose its
  // asset. IndexedDB gives us the isolation for free — use it.
  const t = tx(db, ['drafts', 'assets'], 'readwrite');
  const drafts = await reqAsPromise(t.objectStore('drafts').getAll());
  const live = new Set(extraLive);
  for (const d of drafts) {
    if (d.thumbnailAssetId) live.add(d.thumbnailAssetId);
    for (const l of d.doc?.layers ?? []) if (l.assetId) live.add(l.assetId);
  }
  const assets = t.objectStore('assets');
  const all = await reqAsPromise(assets.getAll());
  const cutoff = Date.now() - graceMs;
  let removed = 0;
  for (const asset of all) {
    if (live.has(asset.assetId)) continue;
    // lastClaimedAt covers re-imports of pre-existing content, not just new
    // uploads; fall back to createdAt for records written before it existed.
    const claimed = asset.lastClaimedAt ?? asset.createdAt ?? 0;
    if (claimed > cutoff) continue; // in-flight import window
    assets.delete(asset.assetId);
    removed++;
  }
  await txDone(t);
  return removed;
}

/** Forget: device row + key + draft links, one transaction. */
export async function forgetDevice(recordId) {
  const db = await openDb();
  const t = tx(db, ['devices', 'keys', 'drafts'], 'readwrite');
  t.objectStore('devices').delete(recordId);
  t.objectStore('keys').delete(recordId);
  const draftIdx = t.objectStore('drafts').index('recordId');
  const drafts = await reqAsPromise(draftIdx.getAllKeys(recordId));
  for (const id of drafts) t.objectStore('drafts').delete(id);
  await txDone(t);
}

// --- keys store (raw access; policy lives in keys.js) ---

export async function getKeyRecord(recordId) {
  const db = await openDb();
  return reqAsPromise(tx(db, ['keys'], 'readonly').objectStore('keys').get(recordId));
}

export async function putKeyRecord(record) {
  const db = await openDb();
  const t = tx(db, ['keys'], 'readwrite');
  t.objectStore('keys').put(record);
  await txDone(t);
}

export async function deleteKeyRecord(recordId) {
  const db = await openDb();
  const t = tx(db, ['keys'], 'readwrite');
  t.objectStore('keys').delete(recordId);
  await txDone(t);
}

// --- export/import (devices only; keys are exported separately, plan §5) ---

export async function exportDevices() {
  const devices = await listDevices();
  return {
    format: 'od-app-devices',
    version: 1,
    exportedAt: new Date().toISOString(),
    devices: devices.map(({ bleId, ...rest }) => rest), // bleId is per-browser
  };
}

export async function importDevices(payload) {
  if (payload?.format !== 'od-app-devices' || !Array.isArray(payload.devices)) {
    throw new Error('Not an OD App device export');
  }
  const db = await openDb();
  const t = tx(db, ['devices'], 'readwrite');
  const store = t.objectStore('devices');
  let imported = 0;
  for (const d of payload.devices) {
    if (!d.recordId || !d.width || !d.height) continue;
    const existing = await reqAsPromise(store.get(d.recordId));
    // Imported rows never carry a binding; never clobber a live local one.
    store.put({ ...d, bleId: existing?.bleId ?? null });
    imported++;
  }
  await txDone(t);
  return imported;
}
