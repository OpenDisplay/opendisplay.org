// SEC2 session driver: one object per connection, on top of a frame transport.
//
//   transport.send(frame)                 write one frame to the device (no sealing here)
//   transport.receive(match, timeoutMs)   the next notification for which match(frame) is
//                                         true, or null on timeout; frames that do not match
//                                         stay queued for other readers
//   transport.connected                   false once the link is gone
//
// What it does (SECURITY_V2 rev 5): the v1/SEC2 selection with pinning (§ 13.6), SEC_STATUS,
// the auth handshake with up to three stored keys (§ 8.8), BUSY back-off (§ 17), the claim with
// a TYPED code and the no-panel / blank-panel acknowledgements (§ 8.4-8.6), key rotation that
// stores the new key before it becomes the only one (§ 11), UNCLAIM, claim-mode EXIT, and sealed
// requests under the § 9.5 client receive rules with an immediate error for an oversize refusal.
//
// It never deletes a key on its own: only an authenticated success (promote) or an authenticated
// UNCLAIM changes what the key store holds.
// UMD: module.exports under node; window.OpenDisplaySec2Session in the browser (needs
// OpenDisplaySec2, OpenDisplaySec2Policy and OpenDisplayKeyStore loaded first).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./od-sec2.js'), require('./od-sec2-policy.js'), require('./od-keystore.js'));
  } else {
    root.OpenDisplaySec2Session = factory(root.OpenDisplaySec2, root.OpenDisplaySec2Policy, root.OpenDisplayKeyStore);
  }
})(typeof self !== 'undefined' ? self : this, function (S, P, KS) {
  'use strict';

  // The sealed BLE frame limit is 244 B on EVERY target (shared OD_DISPATCH_MAX_BLE). A client
  // uses min(negotiated ATT MTU - 3, 244); sealed frames are never split, and the handshake
  // declares frag_max (20..244). Web Bluetooth cannot read the MTU, so the browser assumes 244
  // (every 3.x target negotiates ATT MTU 256) unless a caller passes `mtu`.
  const DEFAULT_MAX_FRAME = 244;
  /** min(MTU - 3, 244); an unknown MTU (null / 0) gives 244. */
  function frameLimit(mtu) {
    const m = Number(mtu);
    if (!Number.isFinite(m) || m <= 0) return DEFAULT_MAX_FRAME;
    return Math.max(0, Math.min(DEFAULT_MAX_FRAME, Math.floor(m) - 3));
  }
  const DEFAULT_FRAG_MAX = S.FRAG_MAX_MIN;
  const REPLY_TIMEOUT_MS = 5000;
  const HANDSHAKE_TIMEOUT_MS = 8000;
  // BUSY back-off, the same policy as py-opendisplay (v3/py-v9 sec2/client.py): the device counts
  // every BEGIN / HELLO it answers (BUSY included), every AUTH_FAILED on FINISH and every failed
  // CONFIRM tag in a ring of RATE_RING per RATE_WINDOW_MS (§ 8.7); RATE_LIMITED is not counted.
  // Quick retries burned that ring on hardware and turned a brief BUSY into RATE_LIMITED, so
  // retries are spaced 2/4/8/16 s and stop while BUSY_RETRY_RESERVE starts must stay free.
  const BUSY_BACKOFF_MS = [2000, 4000, 8000, 16000];
  const BUSY_RETRIES = BUSY_BACKOFF_MS.length;
  const RATE_RING = 10;
  const RATE_WINDOW_MS = 60000;
  const BUSY_RETRY_RESERVE = 3;   // = MAX_HELLOS_PER_CONNECTION: one full authenticate

  /**
   * This page's view of a device's handshake rate limiter, per uid. Shared by every session
   * object of the page (a reconnect makes a new one; the device's ring persists until reboot).
   */
  class HandshakeBudget {
    constructor(clock = Date.now) { this.clock = clock; this._events = new Map(); }
    _ring(uid) {
      const k = typeof uid === 'string' ? uid : S.bytesToHex(uid);
      if (!this._events.has(k)) this._events.set(k, []);
      const ring = this._events.get(k);
      const now = this.clock();
      while (ring.length && now - ring[0] >= RATE_WINDOW_MS) ring.shift();
      while (ring.length > RATE_RING) ring.shift();
      return ring;
    }
    /** One counted event: a BEGIN / HELLO sent, or an AUTH_FAILED. */
    note(uid) { const r = this._ring(uid); r.push(this.clock()); if (r.length > RATE_RING) r.shift(); }
    /** The device answered RATE_LIMITED: that start was not counted. */
    forgetLast(uid) { const r = this._ring(uid); if (r.length) r.pop(); }
    used(uid) { return this._ring(uid).length; }
    reset(uid) { if (uid == null) this._events.clear(); else this._events.delete(typeof uid === 'string' ? uid : S.bytesToHex(uid)); }
  }
  const HANDSHAKE_BUDGET = new HandshakeBudget();
  const FE_REFUSALS_CLOSE_LINK = 3;   // BG22 closes the link after 3 FE in a row (ESP32 after 10)
  const MAX_GATED_WITHOUT_SESSION = 2; // the device closes the link after 3 FE in a row (BG22)

  class Sec2SessionError extends Error {
    /** textKey names a text in od-texts.js; code is a short machine name. */
    constructor(code, textKey, message, extra) {
      super(message || code);
      this.name = 'Sec2SessionError';
      this.code = code;
      this.textKey = textKey || null;
      Object.assign(this, extra || {});
    }
  }
  const fail = (code, textKey, message, extra) => { throw new Sec2SessionError(code, textKey, message, extra); };

  const isFrom = lo => f => f && f.length >= 2 && f[1] === lo && (f[0] === 0x00 || f[0] === 0xff);

  class Sec2Session {
    /**
     * @param {object} o
     * @param {object} o.transport
     * @param {object} o.keyStore      OpenDisplayKeyStore.KeyStore
     * @param {string} o.name          advertised name, e.g. "OD1A2B3C" (the key-store index)
     * @param {number} [o.maxFrame]    largest frame the device accepts (sealed frames count whole);
     *                                 capped at 244, and at mtu - 3 when `mtu` is given
     * @param {number} [o.mtu]         negotiated ATT MTU, when the platform exposes it
     * @param {number} [o.fragMax]     handshake fragment size (20 when the MTU is unknown); 20..maxFrame
     * @param {function} [o.sleep]     async ms => void (tests pass a no-op)
     * @param {function} [o.log]
     */
    constructor({ transport, keyStore, name, maxFrame = DEFAULT_MAX_FRAME, mtu = null, fragMax = DEFAULT_FRAG_MAX,
      sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {}, now = Date.now, budget = HANDSHAKE_BUDGET } = {}) {
      if (!transport) throw new TypeError('transport required');
      this.t = transport; this.store = keyStore; this.name = name;
      this.maxFrame = Math.min(maxFrame, frameLimit(mtu));
      this.fragMax = Math.max(S.FRAG_MAX_MIN, Math.min(fragMax, this.maxFrame, 244));
      this.sleep = sleep; this.log = log; this.now = now; this.budget = budget;
      this.mode = null;          // 'sec2' | 'v1' after select()
      this.status = null;        // last parsed SEC_STATUS (advisory, unauthenticated)
      this.rl = null;            // ClientRecordLayer while a session is up
      this.key = null;           // hex of the key the session was opened with
      this.keyLegacy = false;
      this.gatedWithoutSession = 0;
      this.feSeen = 0;
      this._inflight = new Set();
    }

    // ---- selection ---------------------------------------------------------------------
    /**
     * Decide how to talk to this device. Pinned (seen on SEC2 before): SEC_STATUS first; no
     * answer = refuse to downgrade. Otherwise FIRMWARE_VERSION decides: major >= 3 -> SEC_STATUS.
     * @returns {Promise<{mode:'sec2'|'v1', status:object|null, fw:object|null}>}
     */
    async select() {
      const pinned = !!(this.store && this.name && this.store.isPinned(this.name));
      let fw = null;
      if (!pinned) {
        fw = await this.readFirmwareVersion();
        if (!fw || fw.major < 3) { this.mode = 'v1'; return { mode: 'v1', status: null, fw }; }
      }
      const st = await this.readStatus();
      if (!st || st.secVer !== S.VERSION) {
        if (pinned) fail('downgrade_refused', 'seen_on_sec2', 'this display used SEC2 before and did not answer SEC_STATUS now');
        this.mode = 'v1';
        return { mode: 'v1', status: null, fw };
      }
      this.mode = 'sec2';
      if (this.store && this.name) this.store.pin(this.name, st.uidHex);
      return { mode: 'sec2', status: st, fw };
    }
    async readFirmwareVersion() {
      const r = await this._plainRequest(Uint8Array.of(0x00, 0x43), REPLY_TIMEOUT_MS);
      if (!r || r[0] !== 0x00 || r.length < 5) return null;
      return { major: r[2], minor: r[3], patch: r[4], text: r[2] + '.' + r[3] + '.' + r[4] };
    }
    async readStatus() {
      const r = await this._plainRequest(Uint8Array.of(0x00, 0x54), REPLY_TIMEOUT_MS);
      const st = r ? S.parseSecStatus(r) : null;
      if (st) this.status = st;
      return st;
    }
    /** READ_MSD (0x0044) is plaintext on every state since rev 4: the 16 advertised bytes. */
    async readMsd() {
      const r = await this._plainRequest(Uint8Array.of(0x00, 0x44), REPLY_TIMEOUT_MS);
      return r && r[0] === 0x00 && r.length >= 18 ? Uint8Array.from(r.subarray(2, 18)) : null;
    }
    async readIdent() { return this._plainRequest(Uint8Array.of(0x00, 0x46), REPLY_TIMEOUT_MS); }

    // ---- auth ----------------------------------------------------------------------------
    /**
     * Open a session with a stored key: confirmed first, then candidates, at most three HELLOs.
     * A wrong key is never deleted. Throws Sec2SessionError('not_authorised') when none works.
     */
    async authenticate({ keys = null } = {}) {
      const st = this.status || await this.readStatus();
      if (!st) fail('no_status', null, 'no SEC_STATUS');
      if (st.locked) fail('locked', 'locked', 'the display is LOCKED');
      if (!st.claimed) fail('not_claimed', null, 'the display is not claimed; no session is needed');
      if (this.store && this.name) this.store.importV1(this.name);
      const list = (keys || (this.store ? this.store.keysToTry(this.name) : [])).slice(0, KS.MAX_TRY);
      if (!list.length) fail('no_key', 'not_authorised', 'no key stored for this display');
      const uid = this._uidFor();
      let lastErr = null;
      for (const keyHex of list) {
        try {
          const r = await this._authOnce(uid, keyHex);
          this._openRecordLayer(r.keys, r.timeoutS);
          this.key = keyHex; this.keyLegacy = r.keyLegacy;
          this.gatedWithoutSession = 0; this.feSeen = 0;
          if (this.store) this.store.promote(this.name, keyHex, { uid: S.bytesToHex(uid) });
          return { key: keyHex, keyLegacy: r.keyLegacy, timeoutS: r.timeoutS, rotationSuggested: !!st.rotationSuggested };
        } catch (e) {
          lastErr = e;
          // A wrong key answers AUTH_FAILED; try the next one. Anything else ends the attempt.
          if (!(e instanceof S.Sec2Error && e.err === S.SEC_ERR.AUTH_FAILED) && !(e && e.code === 'tag_mismatch')) break;
        }
      }
      if (lastErr instanceof Sec2SessionError && lastErr.code !== 'tag_mismatch') throw lastErr;
      if (lastErr instanceof S.Sec2Error && lastErr.err === S.SEC_ERR.BUSY) fail('busy', 'busy_retry', 'the display stayed busy');
      if (lastErr instanceof S.Sec2Error && lastErr.err === S.SEC_ERR.RATE_LIMITED) fail('rate_limited', 'not_authorised', 'too many attempts; wait and reconnect');
      fail('not_authorised', 'not_authorised', 'no stored key opened a session', { cause: lastErr });
    }
    async _authOnce(uid, keyHex) {
      const ac = new S.AuthClient({ uid, kDev: S.hexToBytes(keyHex), fragMax: this.fragMax });
      const helloBody = await ac.hello();
      const reply = await this._handshakeWithBusy(0x56, S.AUTH_SUB.HELLO, helloBody, uid);
      const finish = await ac.onHelloReply(reply);
      let fin;
      try { fin = await this._handshake(0x56, S.AUTH_SUB.FINISH, finish); } catch (e) {
        if (e instanceof S.Sec2Error && e.err === S.SEC_ERR.AUTH_FAILED) this.budget.note(uid);  // a counted event (§ 8.7)
        throw e;
      }
      try { return await ac.onFinishReply(fin); } catch (e) { throw new Sec2SessionError('tag_mismatch', 'not_authorised', e.message); }
    }
    _uidFor() {
      const rec = this.store && this.name ? this.store.get(this.name) : null;
      if (rec && rec.uid && /^[0-9a-f]{16}$/.test(rec.uid)) return S.hexToBytes(rec.uid);
      if (!this.status) fail('no_status', null, 'uid unknown');
      return this.status.uid;
    }
    _openRecordLayer(keys, timeoutS) {
      if (this.rl) this.rl.destroy();
      this.rl = new S.ClientRecordLayer({ kH2d: keys.kH2d, kD2h: keys.kD2h, sid: keys.sid, timeoutS, now: this.now });
    }
    get hasSession() { return !!(this.rl && !this.rl.closed); }
    /** The link went away: the session is gone (§ 9.7 rule 1). Keys are kept. */
    onDisconnect() { if (this.rl) this.rl.destroy(); this.rl = null; }

    // ---- claim ---------------------------------------------------------------------------
    /**
     * Claim the device (it must be in claim mode).
     * @param {object} ui
     * @param {function} ui.askCode     async ({display, hasPanel}) => typed string, or
     *                                  {blank:true} when the user says the screen shows nothing
     * @param {function} ui.acknowledge async (textKey) => boolean ('no_panel' / 'blank_panel')
     * @param {function} [ui.beforeOnlyKey] async ({kind, keyHex, persisted}) => boolean; called after
     *                                  the key is stored and before CONFIRM; return false to abort.
     *                                  Use it to offer a key download when persisted is false.
     */
    async claim(ui) {
      const st = await this.readStatus();
      if (!st) fail('no_status', null, 'no SEC_STATUS');
      if (st.claimed) fail('already_claimed', null, 'the display is already claimed');
      if (!st.claimMode) fail('not_in_claim_mode', 'not_in_claim_mode', 'the display is not in claim mode');
      if (!this.store || !this.store.durable()) fail('storage_not_durable', 'storage_not_durable', 'this browser cannot store the key');
      const cc = new S.ClaimClient({ uid: st.uid, fragMax: this.fragMax });
      let beginReply;
      try {
        beginReply = await this._handshakeWithBusy(0x55, S.CLAIM_SUB.BEGIN, await cc.begin(), st.uid);
      } catch (e) { throw this._claimError(e); }
      let info;
      try {
        const nonceBody = cc.onBeginReply(beginReply);
        info = await cc.onNonceReply(await this._handshake(0x55, S.CLAIM_SUB.NONCE, nonceBody));
      } catch (e) { await this._abortClaim(cc); throw this._claimError(e); }

      // The code step: typed by the user, compared by us. No panel / blank panel need an acknowledgement.
      let checked = false;
      if (info.hasPanel) {
        const typed = await ui.askCode({ display: info.display, hasPanel: true });
        if (typed && typed.blank) {
          if (!(await ui.acknowledge('blank_panel'))) { await this._abortClaim(cc); fail('cancelled', null, 'cancelled'); }
        } else if (!cc.codeMatches(typed)) {
          await this._abortClaim(cc); fail('code_mismatch', 'code_mismatch', 'the typed code does not match');
        } else checked = true;
      } else {
        if (this.store.displaySeen(this.name)) { await this._abortClaim(cc); fail('display_seen', 'display_seen', 'refused: this display had a screen before'); }
        if (!(await ui.acknowledge('no_panel'))) { await this._abortClaim(cc); fail('cancelled', null, 'cancelled'); }
      }

      // Store the key BEFORE it becomes the device's only key (§ 8.8).
      const keyHex = S.bytesToHex(cc.kNew);
      try { this.store.stage(this.name, keyHex, 'claim'); } catch (e) { await this._abortClaim(cc); throw this._storageError(e); }
      if (ui.beforeOnlyKey && !(await ui.beforeOnlyKey({ kind: 'claim', keyHex, persisted: await this.store.persisted() }))) {
        await this._abortClaim(cc); fail('cancelled', null, 'cancelled before CONFIRM');
      }
      let done;
      try {
        done = await cc.onConfirmReply(await this._handshake(0x55, S.CLAIM_SUB.CONFIRM, await cc.confirm()));
      } catch (e) {
        if (e instanceof S.Sec2Error && e.err === S.SEC_ERR.AUTH_FAILED) this.budget.note(st.uid);  // failed CONFIRM tag (§ 8.7)
        // CONFIRM was sent: the device may hold the key now. Keep it as a candidate.
        throw new Sec2SessionError('claim_unconfirmed', null, 'the claim was not confirmed; the new key is kept and tried next time', { cause: e });
      }
      this._openRecordLayer(done.keys, done.timeoutS);
      this.key = keyHex; this.keyLegacy = false;
      this.store.promote(this.name, keyHex, { uid: st.uidHex });
      if (checked) this.store.setDisplaySeen(this.name);
      return { key: keyHex, codeChecked: checked, timeoutS: done.timeoutS };
    }
    async _abortClaim(cc) {
      cc.abort();
      try { await this._handshake(0x55, S.CLAIM_SUB.ABORT, new Uint8Array(0), REPLY_TIMEOUT_MS); } catch (e) { /* best effort */ }
    }
    _claimError(e) {
      if (e instanceof S.Sec2Error) {
        if (e.err === S.SEC_ERR.NOT_IN_CLAIM_MODE) return new Sec2SessionError('not_in_claim_mode', 'not_in_claim_mode', e.message);
        if (e.err === S.SEC_ERR.ATTEMPTS_EXHAUSTED) return new Sec2SessionError('attempts_exhausted', 'claim_mode_ended', e.message);
        if (e.err === S.SEC_ERR.EXPIRED) return new Sec2SessionError('claim_mode_ended', 'claim_mode_ended', e.message);
        if (e.err === S.SEC_ERR.ALREADY_CLAIMED) return new Sec2SessionError('already_claimed', null, e.message);
        if (e.err === S.SEC_ERR.BUSY) return new Sec2SessionError('busy', 'busy_retry', e.message);
      }
      return e;
    }
    _storageError(e) {
      return e instanceof Sec2SessionError ? e : new Sec2SessionError('storage_not_durable', 'storage_not_durable', e.message);
    }
    /** Leave claim mode without claiming (CLAIM EXIT). */
    async exitClaimMode() { await this._handshake(0x55, S.CLAIM_SUB.EXIT, new Uint8Array(0)); }

    // ---- rotation / unclaim ----------------------------------------------------------------
    /** Should this session rotate now? A migrated 2.x key rotates unless the owner opted out. */
    rotationWanted() {
      if (!this.hasSession || !this.keyLegacy || !this.store) return false;
      return !(this.store.noRotateFor ? this.store.noRotateFor(this.name) : this.store.noRotate(this.name));
    }
    /**
     * Replace K_dev (§ 11). The new key is stored and read back before ROTATE_CONFIRM; the
     * device ends the session after its ACK and we authenticate again with the new key.
     */
    async rotate(ui = {}) {
      if (!this.hasSession) fail('no_session', 'not_authorised', 'rotation needs a session');
      if (!this.store || !this.store.durable()) fail('storage_not_durable', 'storage_not_durable', 'this browser cannot store the key');
      const r = await this.request(Uint8Array.of(0x00, 0x57, S.KEY_SUB.ROTATE));
      if (r[0] !== 0x00 || r.length !== 19 || r[2] !== S.KEY_SUB.ROTATE) fail('rotate_refused', null, 'ROTATE refused', { reply: r });
      const kNew = Uint8Array.from(r.subarray(3, 19));
      const keyHex = S.bytesToHex(kNew);
      try { this.store.stage(this.name, keyHex, 'rotate'); } catch (e) { throw this._storageError(e); }
      if (ui.beforeOnlyKey && !(await ui.beforeOnlyKey({ kind: 'rotate', keyHex, persisted: await this.store.persisted() }))) {
        fail('cancelled', null, 'cancelled before ROTATE_CONFIRM (the old key still works)');
      }
      const { tag } = await S.rotateTag(kNew, this._uidFor(), this.rl.sid);
      let ack;
      try { ack = await this.request(S.concat(Uint8Array.of(0x00, 0x57, S.KEY_SUB.ROTATE_CONFIRM), tag)); } catch (e) {
        throw new Sec2SessionError('rotation_unconfirmed', 'rotation_pending', 'no answer to ROTATE_CONFIRM; both keys are kept', { cause: e });
      }
      if (ack[0] !== 0x00) fail('rotate_refused', null, 'ROTATE_CONFIRM refused (0x' + (ack[3] || 0).toString(16) + '); the old key still works', { reply: ack });
      // Authenticated ACK: the device took the new key. It is preferred now, but the old key is
      // kept as a candidate until the new one has opened a session (authenticate() promotes it).
      this.store.demote(this.name, keyHex);
      this.onDisconnect();          // the device ends the session after the ACK
      this.status = null;
      return { key: keyHex };
    }
    /** UNCLAIM: the device erases its key and secrets. Keys are dropped only after the sealed ACK. */
    async unclaim() {
      if (!this.hasSession) fail('no_session', 'not_authorised', 'unclaim needs a session');
      const r = await this.request(S.concat(Uint8Array.of(0x00, 0x57, S.KEY_SUB.UNCLAIM), S.UNCLAIM_GUARD));
      if (r[0] !== 0x00) fail('unclaim_refused', null, 'UNCLAIM refused', { reply: r });
      if (this.store) this.store.unclaimed(this.name);
      this.onDisconnect();
      this.status = null;
      return true;
    }

    // ---- requests ----------------------------------------------------------------------------
    /** Payload bytes after [cmd_hi][cmd_lo] that fit one frame now. */
    payloadBudget() { return this.hasSession ? this.maxFrame - S.H2D_OVERHEAD : this.maxFrame - 2; }
    /** Config chunk sizes: [00][41][total:2][chunk] then [00][42][chunk]. */
    configChunkSizes() {
      const b = Math.min(200, this.payloadBudget());
      return { first: b - 2, next: b };
    }
    /**
     * Send one command and return its reply frame (plaintext view). Sealed when a session is up
     * and the opcode is gated. Oversize refusals, either form, throw at once ('frame_too_long').
     */
    async request(frame, { timeoutMs = REPLY_TIMEOUT_MS, idempotent = false, expectReply = true } = {}) {
      const f = S.u8(frame);
      const cmd = (f[0] << 8) | f[1], lo = f[1];
      if (S.isPlaintextOpcode(cmd)) {
        if (f.length > this.maxFrame) fail('frame_too_long', 'frame_too_long', 'frame of ' + f.length + ' B');
        const r = await this._plainRequest(f, timeoutMs);
        if (!r && expectReply) fail('timeout', null, 'no reply to 0x' + cmd.toString(16));
        return r;
      }
      if (!this.hasSession) {
        if (this.status && (this.status.claimed || this.status.locked)) {
          if (this.gatedWithoutSession >= MAX_GATED_WITHOUT_SESSION) fail('not_authorised', 'not_authorised', 'no session');
          this.gatedWithoutSession++;
        }
        if (f.length > this.maxFrame) fail('frame_too_long', 'frame_too_long', 'frame of ' + f.length + ' B');
        await this._send(f);
        if (!expectReply) return null;
        const r = await this._receive(isFrom(lo), timeoutMs);
        if (!r) fail(this.t.connected === false ? 'not_authorised' : 'timeout', this.t.connected === false ? 'not_authorised' : null, 'no reply');
        if (r.length === 3 && r[0] === 0x00 && r[2] === 0xfe) { this.feSeen++; fail('needs_session', 'not_authorised', 'the display needs a session (FE)'); }
        if (r.length === 3 && r[0] === 0xff && r[2] === 0xfe) fail('frame_too_long', 'frame_too_long', 'oversize refusal');
        if (r.length === 3 && r[0] === 0xff && r[2] === 0xfd) fail('claim_mode_refused', 'not_in_claim_mode', 'refused in claim mode');
        return r;
      }
      if (f.length - 2 + S.H2D_OVERHEAD > this.maxFrame) fail('frame_too_long', 'frame_too_long', 'sealed frame of ' + (f.length - 2 + S.H2D_OVERHEAD) + ' B');
      const sealed = await this.rl.seal(f);
      await this._send(sealed);
      if (!expectReply) return null;
      const los = new Set([lo]);
      for (;;) {
        const r = await this._receive(x => {
          const c = S.classifyInbound(x, { cmdLos: los });
          return c === 'sealed' || c === 'session_gone' && x[1] === lo || c === 'oversize';
        }, timeoutMs);
        if (!r) fail(this.t.connected === false ? 'disconnected' : 'timeout', null, 'no reply to 0x' + cmd.toString(16));
        const c = S.classifyInbound(r, { cmdLos: los });
        if (c === 'oversize') fail('frame_too_long', 'frame_too_long', 'oversize refusal (plaintext form)');
        if (c === 'session_gone') {
          this.onDisconnect();
          if (idempotent && this.store) { await this.authenticate(); return this.request(f, { timeoutMs, idempotent: false }); }
          fail('session_gone', 'not_authorised', 'the display ended the session');
        }
        const o = await this.rl.open(r);
        if (!o.ok) {
          if (o.close) { this.onDisconnect(); fail('integrity', null, 'three bad records: closing'); }
          continue;
        }
        const pt = o.plaintext;
        const ref = S.parseRefusal(pt);
        if (ref && ref.cmdLo === lo) {
          if (ref.code === S.REFUSAL.OVERSIZE) fail('frame_too_long', 'frame_too_long', 'oversize refusal (sealed)');
          if (ref.code === S.REFUSAL.CLAIM_MODE) fail('claim_mode_refused', 'not_in_claim_mode', 'refused in claim mode');
          fail('refused_' + ref.name.toLowerCase(), null, 'the display refused the record (' + ref.name + ')');
        }
        if (pt.length >= 2 && pt[1] === lo) return pt;
        // a sealed reply to something else (a late answer): keep waiting
      }
    }

    // ---- the filter for an existing command layer (ble-common.js) ----------------------------
    /**
     * Turn a plaintext command frame into what goes on the wire: sealed inside a session for a
     * gated opcode, as is otherwise. Size limits are enforced here, before anything is sent.
     */
    async sealOutgoing(frame) {
      const f = S.u8(frame);
      if (f.length < 2) return f;
      const cmd = (f[0] << 8) | f[1];
      if (S.isPlaintextOpcode(cmd) || !this.hasSession) {
        if (f.length > this.maxFrame) fail('frame_too_long', 'frame_too_long', 'frame of ' + f.length + ' B');
        if (!S.isPlaintextOpcode(cmd) && this.status && (this.status.claimed || this.status.locked)) {
          if (this.gatedWithoutSession >= MAX_GATED_WITHOUT_SESSION) fail('not_authorised', 'not_authorised', 'no session');
          this.gatedWithoutSession++;
        }
        this._inflight.add(f[1]);
        return f;
      }
      if (f.length - 2 + S.H2D_OVERHEAD > this.maxFrame) fail('frame_too_long', 'frame_too_long', 'sealed frame of ' + (f.length - 2 + S.H2D_OVERHEAD) + ' B');
      this._inflight.add(f[1]);
      return this.rl.seal(f);
    }
    /**
     * One notification in. Returns {deliver: plaintext frame} for the command layer,
     * {drop: true}, or {error: Sec2SessionError, fatal} (abort what is in flight at once).
     */
    async openIncoming(frame) {
      const b = S.u8(frame);
      const los = this._inflight;
      if (!this.hasSession) {
        if (b.length === 3 && b[0] === 0x00 && b[2] === 0xfe) {
          this.feSeen++;
          return { error: new Sec2SessionError('needs_session', 'not_authorised', 'the display needs a session (FE)'), fatal: false, frame: b };
        }
        if (b.length === 3 && b[0] === 0xff && b[2] === 0xfe) return { error: new Sec2SessionError('frame_too_long', 'frame_too_long', 'oversize refusal'), fatal: true };
        if (b.length >= 1 && b[0] === 0xe5) return { drop: true };  // a sealed frame with no session: never trust it
        return { deliver: b };
      }
      const c = S.classifyInbound(b, { cmdLos: los });
      if (c === 'oversize') return { error: new Sec2SessionError('frame_too_long', 'frame_too_long', 'oversize refusal (plaintext form)'), fatal: true };
      if (c === 'session_gone') {
        this.onDisconnect();
        return { error: new Sec2SessionError('session_gone', 'not_authorised', 'the display ended the session'), fatal: true };
      }
      if (c === 'plaintext' || c === 'sec_error') return { deliver: b };
      if (c !== 'sealed') return { drop: true };
      const o = await this.rl.open(b);
      if (!o.ok) {
        if (o.close) { this.onDisconnect(); return { error: new Sec2SessionError('integrity', null, 'three bad records'), fatal: true, close: true }; }
        return { drop: true };
      }
      const ref = S.parseRefusal(o.plaintext);
      if (ref) {
        if (ref.code === S.REFUSAL.OVERSIZE) return { error: new Sec2SessionError('frame_too_long', 'frame_too_long', 'oversize refusal (sealed)'), fatal: true };
        if (ref.code === S.REFUSAL.CLAIM_MODE) return { error: new Sec2SessionError('claim_mode_refused', 'not_in_claim_mode', 'refused in claim mode'), fatal: true };
        return { error: new Sec2SessionError('refused_' + ref.name.toLowerCase(), null, 'record refused (' + ref.name + ')'), fatal: true };
      }
      return { deliver: o.plaintext };
    }

    /** Full config read inside the session (or plaintext on an unclaimed device). */
    async readConfig({ timeoutMs = REPLY_TIMEOUT_MS } = {}) {
      const first = await this.request(Uint8Array.of(0x00, 0x40), { timeoutMs, idempotent: true });
      if (first[0] !== 0x00 || first.length < 6) fail('config_read_failed', null, 'config read refused');
      const total = first[4] | (first[5] << 8);
      const parts = [first.subarray(6)];
      let got = parts[0].length;
      while (got < total) {
        const r = await this._nextConfigChunk(timeoutMs);
        if (!r) fail('timeout', null, 'config read stalled at ' + got + '/' + total);
        parts.push(r.subarray(4)); got += r.length - 4;
      }
      return S.concat(...parts).subarray(0, total);
    }
    async _nextConfigChunk(timeoutMs) {
      for (;;) {
        const r = await this._receive(x => (this.hasSession ? x[0] === 0xe5 : isFrom(0x40)(x)), timeoutMs);
        if (!r) return null;
        if (!this.hasSession) return r;
        const o = await this.rl.open(r);
        if (o.ok && o.plaintext[1] === 0x40) return o.plaintext;
        if (!o.ok && o.close) { this.onDisconnect(); fail('integrity', null, 'three bad records'); }
      }
    }
    /**
     * Write a config. The client-side checks run first (secrets need a claimed device; a claimed
     * device takes only its own key or a zero key; the walk must end at the CRC).
     */
    async writeConfig(blob, { onProgress = null } = {}) {
      const b = S.u8(blob);
      const st = this.status;
      const chk = P.clientWriteCheck(b, { sec2: true, claimed: !!(st && st.claimed),
        kDev: this.key ? S.hexToBytes(this.key) : null, legacySecrets: !!(st && st.legacySecretsOpen) });
      if (!chk.ok) fail('refused_client_side', chk.textKey, 'not sent: ' + chk.textKey, { err: chk.err });
      const { first, next } = this.configChunkSizes();
      let r;
      if (b.length <= first) {
        r = await this.request(S.concat(Uint8Array.of(0x00, 0x41), b));
      } else {
        r = await this.request(S.concat(Uint8Array.of(0x00, 0x41), S.u16le(b.length), b.subarray(0, first)));
        let off = first;
        while (r[0] === 0x00 && off < b.length) {
          if (onProgress) onProgress(off, b.length);
          r = await this.request(S.concat(Uint8Array.of(0x00, 0x42), b.subarray(off, off + next)));
          off += next;
        }
      }
      if (r[0] !== 0x00) {
        const why = P.explainConfigNack(r) || { textKey: 'config_write_failed' };
        fail('config_nack', why.textKey, 'the display refused the config', { reply: r, busy: !!why.busy });
      }
      if (onProgress) onProgress(b.length, b.length);
      return true;
    }

    // ---- handshake plumbing ------------------------------------------------------------------
    /** BEGIN / HELLO: retry on BUSY with the spaced, budget-aware back-off (see HandshakeBudget). */
    async _handshakeWithBusy(cmdLo, sub, body, uid) {
      const b = this.budget;
      for (let i = 0; ; i++) {
        b.note(uid);
        try { return await this._handshake(cmdLo, sub, body); } catch (e) {
          const se = e instanceof S.Sec2Error ? e.err : null;
          if (se === S.SEC_ERR.RATE_LIMITED) b.forgetLast(uid);
          if (se !== S.SEC_ERR.BUSY || i >= BUSY_RETRIES) throw e;
          if (b.used(uid) + 1 > RATE_RING - BUSY_RETRY_RESERVE) {
            this.log('display busy; not retrying, ' + b.used(uid) + ' of ' + RATE_RING + ' handshake starts used in the last 60 s', 'info');
            throw e;
          }
          const delay = BUSY_BACKOFF_MS[i];
          this.log('display busy (display pass); retrying in ' + delay / 1000 + ' s', 'info');
          await this.sleep(delay);
        }
      }
    }
    async _handshake(cmdLo, sub, body, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
      for (const fr of S.fragment(cmdLo, sub, body, this.fragMax)) await this._send(fr);
      const len = S.BODY_LEN.d2h[cmdLo][sub];
      const ra = new S.Reassembler(cmdLo, sub, len, this.fragMax);
      for (;;) {
        const fr = await this._receive(isFrom(cmdLo), timeoutMs);
        if (!fr) fail(this.t.connected === false ? 'disconnected' : 'timeout', null, 'no handshake reply');
        const r = ra.push(fr);
        if (r.ignore) continue;
        if (r.secError) throw new S.Sec2Error(r.secError.err, r.secError.sub);
        if (r.error) fail('handshake_malformed', null, r.error);
        if (r.done) return r.body;
      }
    }
    async _plainRequest(frame, timeoutMs) {
      await this._send(frame);
      return this._receive(isFrom(frame[1]), timeoutMs);
    }
    /**
     * Did the device refuse us away? After FE_REFUSALS_CLOSE_LINK refusals the firmware closes the
     * link (BG22: 3 in a row), and the write error can arrive BEFORE the disconnect event (seen
     * with py-opendisplay on hardware, about 44 ms early). So any link error after 3 refusals
     * means "not authorised" even while the link still looks up; with fewer refusals the
     * disconnect must already be visible.
     */
    refusedAway() { return this.feSeen >= FE_REFUSALS_CLOSE_LINK || (this.feSeen > 0 && this.t.connected === false); }
    notAuthorisedError(cause) {
      return new Sec2SessionError('not_authorised', 'not_authorised', 'the display closed the link after refusing commands that need a key', { cause });
    }
    async _send(frame) {
      try { await this.t.send(frame); } catch (e) {
        const away = this.refusedAway();
        this.onDisconnect();
        if (away) throw this.notAuthorisedError(e);
        throw new Sec2SessionError('disconnected', null, 'link lost', { cause: e });
      }
    }
    async _receive(match, timeoutMs) { return this.t.receive(match, timeoutMs); }
  }

  /** "Secrets need a key": refuse a config with WiFi/FindMy secrets for an unclaimed SEC2 device before sending. */
  function secretsNeedKey(blob, { sec2, claimed }) {
    const c = P.clientWriteCheck(S.u8(blob), { sec2, claimed });
    return !c.ok && c.textKey === 'secrets_need_key';
  }

  return { FE_REFUSALS_CLOSE_LINK, HandshakeBudget, HANDSHAKE_BUDGET, BUSY_BACKOFF_MS, RATE_RING, RATE_WINDOW_MS, BUSY_RETRY_RESERVE, Sec2Session, Sec2SessionError, secretsNeedKey, frameLimit, DEFAULT_MAX_FRAME, MAX_GATED_WITHOUT_SESSION, BUSY_RETRIES };
});
