// Browser key store for SEC2 devices (SECURITY_V2 § 8.8 key retention, § 10.5 rotation).
//
// Per device (by advertised name, e.g. "OD1A2B3C"; the uid is recorded once known):
//   confirmed   the key that last completed an authenticated handshake (or null)
//   candidates  keys that might work: typed by the user, from a ?key= link, from the 2.x key
//               store, a new key staged before CONFIRM / ROTATE_CONFIRM
//   sec2        pinned: this device was seen speaking SEC2; never talk v1 to it again
//   displaySeen the device reported a working panel once (a later "no panel" claim is suspicious)
//   noRotate    the owner's opt-out for rotating a migrated 2.x key, for this device
// and, for every device, the persistent setting "Do not replace keys carried over from firmware
// 2.x" (noRotateAll, its own storage entry; settable before any device was connected).
//
// Rules:
//   - A key is removed ONLY by an explicit user action (forget) or after another key has
//     completed an authenticated handshake for the same device (promote). A refusal, silence
//     or any unauthenticated reply never removes a key.
//   - stage() writes a new key and reads it back BEFORE the caller lets it become the device's
//     only key. If the store cannot hold it, stage() throws Sec2StorageError and the caller
//     must not send CONFIRM / ROTATE_CONFIRM.
//   - keysToTry() returns at most three keys (the spec's HELLO budget per connection).
//
// The storage backend is injectable (localStorage in the browser, a Map in tests).
// UMD: module.exports under node, window.OpenDisplayKeyStore in the browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpenDisplayKeyStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORE_KEY = 'opendisplay.sec2.devices';
  const NO_ROTATE_KEY = 'opendisplay.sec2.noRotateLegacy';   // the global opt-out ('1' = on)
  const V1_STORE_KEY = 'opendisplay.deviceKeys';   // the toolbox's 2.x key store (name -> hex)
  const FORMAT = 1;
  const MAX_TRY = 3;
  const RE_KEY = /^[0-9a-f]{32}$/;

  class Sec2StorageError extends Error {
    constructor(message) { super(message); this.name = 'Sec2StorageError'; this.textKey = 'storage_not_durable'; }
  }

  function normKey(k) {
    if (k instanceof Uint8Array) k = Array.from(k, b => b.toString(16).padStart(2, '0')).join('');
    const s = String(k == null ? '' : k).replace(/[\s:-]/g, '').toLowerCase();
    return RE_KEY.test(s) ? s : null;
  }
  function normName(n) { const s = String(n == null ? '' : n).trim(); return s || null; }

  /** A Map-backed storage with the localStorage interface (tests, and the fallback when localStorage throws). */
  function memoryStorage() {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: k => { m.delete(k); }, _map: m };
  }

  class KeyStore {
    /**
     * @param {{storage?:object, now?:function, persisted?:function}} o
     *   storage    localStorage-like; omitted -> globalThis.localStorage
     *   persisted  async () => boolean, navigator.storage.persisted() in the browser
     */
    constructor({ storage = null, now = () => Date.now(), persisted = null, persist = null } = {}) {
      this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      this.now = now;
      this._persisted = persisted;
      this._persist = persist;
    }

    _read() {
      try {
        const raw = this.storage && this.storage.getItem(STORE_KEY);
        const d = raw ? JSON.parse(raw) : null;
        if (d && d.format === FORMAT && d.devices && typeof d.devices === 'object') return d;
      } catch (e) { /* unreadable: treat as empty, never overwrite blindly (see _write) */ }
      return { format: FORMAT, devices: {} };
    }
    _write(d) {
      if (!this.storage) throw new Sec2StorageError('no storage');
      const s = JSON.stringify(d);
      this.storage.setItem(STORE_KEY, s);
      if (this.storage.getItem(STORE_KEY) !== s) throw new Sec2StorageError('read-back mismatch');
    }
    _update(name, fn) {
      const n = normName(name);
      if (!n) throw new TypeError('device name required');
      const d = this._read();
      const rec = d.devices[n] || { name: n, uid: null, confirmed: null, candidates: [], sec2: false, displaySeen: false, noRotate: false };
      const out = fn(rec) || rec;
      d.devices[n] = out;
      this._write(d);
      return out;
    }

    /** Can this browser keep a key? Writes, reads back and removes a probe. */
    durable() {
      try {
        if (!this.storage) return false;
        const probe = STORE_KEY + '.probe';
        const v = 'p' + this.now();
        this.storage.setItem(probe, v);
        const ok = this.storage.getItem(probe) === v;
        this.storage.removeItem(probe);
        return ok;
      } catch (e) { return false; }
    }
    /** navigator.storage.persisted(): false means the browser may evict the store; offer a key download first. */
    async persisted() {
      try { return this._persisted ? !!(await this._persisted()) : false; } catch (e) { return false; }
    }

    /** navigator.storage.persist(): ask the browser to keep the store. True when it now is persistent. */
    async requestPersist() {
      try { return this._persist ? !!(await this._persist()) : false; } catch (e) { return false; }
    }
    /**
     * May a one-way key step run WITHOUT asking (the automatic rotation)? Only when the store is
     * writable AND the browser keeps it (persisted, or persistence granted now). A private window
     * or a store the browser may evict gives false: the rotation is then skipped and reported.
     */
    async keepsKeys() {
      if (!this.durable()) return false;
      return (await this.persisted()) || (await this.requestPersist());
    }

    get(name) {
      const n = normName(name);
      const rec = n ? this._read().devices[n] : null;
      return rec ? JSON.parse(JSON.stringify(rec)) : null;
    }
    names() { return Object.keys(this._read().devices); }

    /** Add a key that might work. Returns false (and stores nothing) for an invalid key. */
    addCandidate(name, key, source = 'user') {
      const k = normKey(key);
      if (!k) return false;
      this._update(name, rec => {
        if (rec.confirmed === k || rec.candidates.some(c => c.key === k)) return rec;
        rec.candidates.push({ key: k, source: String(source), added: this.now() });
        return rec;
      });
      return true;
    }
    /**
     * Store a key that is about to become the device's only key (claim, rotation), and prove it
     * is stored. Throws Sec2StorageError when it is not: the caller must then abort.
     */
    stage(name, key, kind) {
      const k = normKey(key);
      if (!k) throw new TypeError('invalid key');
      if (!this.durable()) throw new Sec2StorageError('storage is not writable');
      this._update(name, rec => {
        rec.candidates = rec.candidates.filter(c => c.key !== k);
        rec.candidates.unshift({ key: k, source: 'pending-' + (kind || 'key'), added: this.now() });
        return rec;
      });
      const back = this.get(name);
      if (!back || !back.candidates.some(c => c.key === k)) throw new Sec2StorageError('the staged key did not read back');
      return true;
    }
    /**
     * `key` completed an authenticated handshake (AUTH FINISH verified, or the claim's CONFIRM
     * reply verified, or ROTATE_CONFIRM's sealed ACK opened). It becomes confirmed; the old
     * confirmed key and the other candidates are dropped only now. The device is pinned to SEC2.
     */
    promote(name, key, { uid = null } = {}) {
      const k = normKey(key);
      if (!k) throw new TypeError('invalid key');
      return this._update(name, rec => {
        rec.confirmed = k;
        rec.candidates = [];
        rec.sec2 = true;
        if (uid) rec.uid = String(uid);
        rec.confirmedAt = this.now();
        return rec;
      });
    }
    /** Up to three keys, confirmed first, then the newest candidates (a pending key first). */
    keysToTry(name) {
      const rec = this.get(name);
      if (!rec) return [];
      const out = [];
      if (rec.confirmed) out.push(rec.confirmed);
      for (const c of rec.candidates) if (!out.includes(c.key)) out.push(c.key);
      return out.slice(0, MAX_TRY);
    }
    hasAnyKey(name) { return this.keysToTry(name).length > 0; }

    pin(name, uid) { return this._update(name, rec => { rec.sec2 = true; if (uid) rec.uid = String(uid); return rec; }); }
    isPinned(name) { const r = this.get(name); return !!(r && r.sec2); }
    setDisplaySeen(name) { return this._update(name, rec => { rec.displaySeen = true; return rec; }); }
    displaySeen(name) { const r = this.get(name); return !!(r && r.displaySeen); }
    setNoRotate(name, on) { return this._update(name, rec => { rec.noRotate = !!on; return rec; }); }
    noRotate(name) { const r = this.get(name); return !!(r && r.noRotate); }
    /** The persistent setting for every device. Throws Sec2StorageError when it cannot be stored. */
    setNoRotateAll(on) {
      if (!this.storage) throw new Sec2StorageError('no storage');
      if (on) this.storage.setItem(NO_ROTATE_KEY, '1'); else this.storage.removeItem(NO_ROTATE_KEY);
      if (this.noRotateAll() !== !!on) throw new Sec2StorageError('read-back mismatch');
    }
    noRotateAll() { try { return !!(this.storage && this.storage.getItem(NO_ROTATE_KEY) === '1'); } catch (e) { return false; } }
    /** The effective opt-out for this device: the global setting or the per-device choice. */
    noRotateFor(name) { return this.noRotateAll() || this.noRotate(name); }

    /**
     * ROTATE_CONFIRM's sealed ACK arrived: `newKey` is the device's key now but has not opened a
     * session yet. The old confirmed key becomes a candidate ('pre-rotation') AFTER the new one;
     * nothing is dropped until the new key authenticates (promote()).
     */
    demote(name, newKey) {
      const k = normKey(newKey);
      if (!k) throw new TypeError('invalid key');
      return this._update(name, rec => {
        const others = rec.candidates.filter(c => c.key !== k && c.key !== rec.confirmed);
        const staged = rec.candidates.find(c => c.key === k) || { key: k, source: 'pending-rotate', added: this.now() };
        const old = rec.confirmed && rec.confirmed !== k ? [{ key: rec.confirmed, source: 'pre-rotation', added: this.now() }] : [];
        rec.confirmed = null;
        rec.candidates = [staged, ...old, ...others];
        return rec;
      });
    }

    /**
     * Explicit user action only. Keeps the SEC2 pin unless `unpin` (a pinned device must not be
     * spoken to with v1 just because its key was forgotten).
     */
    forget(name, { unpin = false } = {}) {
      const n = normName(name);
      if (!n) return;
      const d = this._read();
      const rec = d.devices[n];
      if (!rec) return;
      if (unpin) delete d.devices[n];
      else { rec.confirmed = null; rec.candidates = []; }
      this._write(d);
    }
    /** After an authenticated UNCLAIM: the keys are dead, the device stays pinned. */
    unclaimed(name) { this.forget(name); }

    /**
     * The 2.x store's key for this name, as a candidate (a migrated 2.x device keeps its v1 key
     * as K_dev until it rotates, § 10.5). The 2.x store is left untouched.
     */
    importV1(name) {
      try {
        const raw = this.storage && this.storage.getItem(V1_STORE_KEY);
        const map = raw ? JSON.parse(raw) : {};
        const k = map && normKey(map[normName(name)]);
        return k ? this.addCandidate(name, k, 'v1-store') : false;
      } catch (e) { return false; }
    }

    /** A text file the user can keep (the download offered when persisted() is false). */
    exportText(name) {
      const rec = this.get(name);
      if (!rec) return null;
      const keys = this.keysToTry(name);
      return ['OpenDisplay key backup', 'Device: ' + rec.name, ...(rec.uid ? ['Device id: ' + rec.uid] : []),
        ...keys.map((k, i) => (i === 0 && rec.confirmed ? 'Key: ' : 'Possible key: ') + k),
        'Anyone with this key can control the display and read its WiFi password.', ''].join('\n');
    }
  }

  return { KeyStore, Sec2StorageError, memoryStorage, normKey, STORE_KEY, V1_STORE_KEY, NO_ROTATE_KEY, MAX_TRY };
});
