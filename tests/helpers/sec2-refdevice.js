// A small SEC2 *device* for the website's tests, written from SECURITY_V2.md (revision 4): the
// fragment reassembly any-split rules (§ 3.3), claim (§ 8), auth (§ 9), the device receive rules
// with the 256-entry window (§ 9.5), FE gating and the abuse limit (§ 6 rule 5), the oversize
// refusal (§ 3.4), SEC_KEY rotation / unclaim (§ 11) and the config-write rules (§ 10.3 / § 10.4,
// via the website's own client-side policy module, which the vectors V10 check independently).
// It is a test double, not firmware: no timers, no storage faults, no claim-mode reboots.
'use strict';
const S = require('../../httpdocs/js/od-sec2.js');
const P = require('../../httpdocs/js/od-sec2-policy.js');

const NOACK = new Set([0x0081]);
const E = S.SEC_ERR;

class DeviceReassembler {
  constructor() { this.reset(); }
  reset() { this.cmdLo = null; this.sub = null; this.parts = []; this.got = 0; this.next = 0; }
  // -> { body } | { err } | null (need more)
  push(frame, bodyLenOf) {
    const cmdLo = frame[1];
    if (frame.length < 4) { this.reset(); return { err: E.MALFORMED, sub: frame.length > 2 ? frame[2] : 0 }; }
    const sub = frame[2], idx = frame[3] & 0x7f, last = !!(frame[3] & 0x80);
    const data = frame.subarray(4);
    if (this.next === 0) {
      const len = bodyLenOf(cmdLo, sub);
      if (len == null) { this.reset(); return { err: E.MALFORMED, sub }; }
      this.cmdLo = cmdLo; this.sub = sub; this.len = len;
    }
    if (cmdLo !== this.cmdLo || sub !== this.sub || idx !== this.next) { this.reset(); return { err: E.MALFORMED, sub }; }
    if (!last && data.length === 0) { this.reset(); return { err: E.MALFORMED, sub }; }
    if (!last && idx === 127) { this.reset(); return { err: E.MALFORMED, sub }; }
    if (this.got + data.length > this.len) { this.reset(); return { err: E.MALFORMED, sub }; }
    this.parts.push(Uint8Array.from(data));
    this.got += data.length;
    this.next++;
    if (!last) return null;
    if (this.got !== this.len) { this.reset(); return { err: E.MALFORMED, sub }; }
    const body = S.concat(...this.parts);
    this.reset();
    return { body, sub };
  }
}

class RefDevice {
  constructor({ uid, dflags = 1, claimMode = null, kDev = null, origin = 'CLAIMED', timeoutS = 3600, rng = {}, maxFrame = 244,
    abuseLimit = 3, config = null, legacySecrets = false, fw = [3, 0, 0], panel = true } = {}) {
    this.uid = S.u8(uid || new Uint8Array(8));
    this.baseDflags = dflags;
    this.claimMode = claimMode; // null | 'gesture' | 'fresh'
    this.kDev = kDev ? S.u8(kDev) : null;
    this.origin = kDev ? origin : null;
    this.timeoutS = timeoutS;
    this.rng = rng;
    this.maxFrame = maxFrame;
    this.abuseLimit = abuseLimit;
    this.legacySecrets = legacySecrets;
    this.fw = fw;
    this.panel = panel;
    this.config = config ? S.u8(config) : null;
    this.reasm = new DeviceReassembler();
    this.session = null; this.strikes = 0; this.feRun = 0; this.closed = false;
    this.pending = null; this.renders = 0; this.configLocked = claimMode === 'gesture';
    this.log = [];
    this.handlers = {}; // tests may override per opcode: (payload) -> plaintext reply frame or null
  }
  static async withSession(kH2d, kD2h) {
    const d = new RefDevice({ kDev: new Uint8Array(16).fill(7) });
    d.session = { kH2d: S.u8(kH2d), kD2h: S.u8(kD2h), rxLast: 0, seen: new Set(), txCtr: 0, sid: new Uint8Array(16) };
    d.handlers[0x0040] = () => null; // the vectors only check acceptance; no reply body needed
    return d;
  }
  static async afterNonce(vec) {
    const I = vec.inputs;
    const d = new RefDevice({ uid: S.hexToBytes(I.uid), dflags: parseInt(I.dflags, 16), claimMode: I.claim_mode,
      rng: { keyPair: await S.keyPairFromScalar(S.hexToBytes(I.dd)), nd: S.hexToBytes(I.Nd), kNew: S.hexToBytes(I.K_new) } });
    for (const f of vec.messages.BEGIN.h2d.concat(vec.messages.NONCE.h2d)) await d.receive(S.hexToBytes(f));
    return d;
  }
  static async afterHello(vec) {
    const I = vec.inputs;
    const d = new RefDevice({ uid: S.hexToBytes(I.uid), dflags: parseInt(I.dflags, 16), kDev: S.hexToBytes(I.k_dev), origin: I.origin,
      rng: { keyPair: await S.keyPairFromScalar(S.hexToBytes(I.dd)), nd: S.hexToBytes(I.Nd) } });
    for (const f of vec.messages.HELLO.h2d) await d.receive(S.hexToBytes(f));
    return d;
  }

  get claimed() { return !!this.kDev; }
  dflags() {
    let f = this.baseDflags & ~(S.DFLAG.KEY_LEGACY | S.DFLAG.CLAIM_MODE_FRESH);
    if (this.claimMode === 'fresh') f |= S.DFLAG.CLAIM_MODE_FRESH;
    return f;
  }
  authDflags() {
    let f = this.baseDflags & ~(S.DFLAG.KEY_LEGACY | S.DFLAG.CLAIM_MODE_FRESH);
    if (this.origin === 'LEGACY') f |= S.DFLAG.KEY_LEGACY;
    return f;
  }
  async _keyPair() {
    if (this.rng.keyPair) { const kp = this.rng.keyPair; this.rng.keyPair = null; return kp; }
    return S.generateKeyPair();
  }
  _rand(name) {
    if (this.rng[name]) { const v = this.rng[name]; this.rng[name] = null; return v; }
    return S.randomBytes(16);
  }
  status() {
    const st = this.claimed ? 2 : 0;
    let flags = 0;
    if (this.claimMode) flags |= S.STATUS_FLAG.CLAIM_MODE;
    if (this.session) flags |= S.STATUS_FLAG.SESSION_ACTIVE;
    if (this.legacySecrets && !this.claimed) flags |= S.STATUS_FLAG.LEGACY_SECRETS_OPEN;
    if (this.origin === 'LEGACY') flags |= S.STATUS_FLAG.ROTATION_SUGGESTED;
    if (this.claimMode === 'fresh') flags |= S.STATUS_FLAG.CLAIM_MODE_FRESH;
    if (this.configLocked && this.claimMode) flags |= S.STATUS_FLAG.CONFIG_LOCKED;
    const df = this.claimed ? this.authDflags() : this.dflags();
    return S.concat(Uint8Array.of(0x00, 0x54, 0x02, st, flags), S.u16le(this.claimMode ? 599 : 0), this.uid,
      S.u16le(this.timeoutS), Uint8Array.of(df, this.claimMode ? 3 - this.renders : 0));
  }
  ident() {
    let fl = 0x01 | 0x08;
    if (this.claimed) fl |= 0x10;
    if (this.claimMode) fl |= 0x20;
    if (this.legacySecrets && !this.claimed) fl |= 0x40;
    return Uint8Array.of(0x00, 0x46, 0x04, 0x03, 0x00, fl, 0x30, 0x0c, 0x80, 0x00, 0x00);
  }
  _err(cmdLo, sub, err) { return [Uint8Array.of(0xff, cmdLo, sub, err)]; }
  _frag(cmdLo, sub, body) { return S.fragment(cmdLo, sub, body, this.fragMax || 20); }

  /** One host frame in; the device's reply frames out (possibly none). */
  async receive(frame) {
    const f = S.u8(frame);
    if (this.closed) return [];
    if (f.length < 2) return [];
    const cmd = (f[0] << 8) | f[1];
    this.log.push(cmd);
    const gated = !S.isPlaintextOpcode(cmd);
    if (f.length > this.maxFrame) {
      const refusal = Uint8Array.of(0xff, f[1], 0xfe);
      return [this.session && gated ? await this._seal(refusal) : refusal];
    }
    if (!gated) return this._plaintext(cmd, f);
    if (this.claimed && !this.session) {
      this.feRun++;
      if (this.feRun >= this.abuseLimit) { this.closed = true; return []; }
      return [Uint8Array.of(0x00, f[1], 0xfe)];
    }
    if (!this.session) {
      if (this.claimMode && !(this._configWriteAllowedInClaimMode(cmd))) return [Uint8Array.of(0xff, f[1], 0xfd)];
      const reply = await this._execute(cmd, f.subarray(2));
      return reply ? [reply] : [];
    }
    // § 9.5 device rules 3-6
    const noack = NOACK.has(cmd);
    if (f.length < S.H2D_OVERHEAD) return noack ? [] : [await this._seal(Uint8Array.of(0xff, f[1], 0xf1))];
    const ctr = S.readU32le(f, 2);
    const s = this.session;
    const fresh = ctr !== 0 && ctr !== 0xffffffff && (ctr > s.rxLast || (s.rxLast - ctr < 256 && !s.seen.has(ctr)));
    if (!fresh) return noack ? [] : [await this._seal(Uint8Array.of(0xff, f[1], 0xf2))];
    const pt = await S.openH2d(s.kH2d, f);
    if (!pt) {
      this.strikes++;
      const out = noack ? [] : [await this._seal(Uint8Array.of(0xff, f[1], 0xf3))];
      if (this.strikes >= 3) this.session = null;
      return out;
    }
    s.seen.add(ctr);
    if (ctr > s.rxLast) s.rxLast = ctr;
    this.feRun = 0;
    if (this.claimMode && !this._configWriteAllowedInClaimMode(cmd, true)) return [await this._seal(Uint8Array.of(0xff, f[1], 0xfd))];
    const reply = await this._execute(cmd, pt);
    return reply ? [await this._seal(reply)] : [];
  }
  _configWriteAllowedInClaimMode(cmd, sessionAfterClaim = false) {
    if (![0x0041, 0x0042, 0x0045, 0x0040, 0x000f].includes(cmd)) return false;
    if (cmd === 0x0040 || cmd === 0x000f) return true;
    if (sessionAfterClaim) return true; // § 6: the claiming session may write the config
    return this.claimMode === 'fresh' && !this.configLocked;
  }
  async _seal(plain) {
    const s = this.session;
    s.txCtr++;
    return S.sealD2h(s.kD2h, s.txCtr, plain);
  }
  async openOwnReply(frame) {
    const rl = new S.ClientRecordLayer({ kH2d: this.session ? this.session.kH2d : new Uint8Array(16), kD2h: (this.session || this._lastSession).kD2h });
    return rl.open(frame);
  }
  disconnect() {
    this.session = null; this.pending = null; this.reasm.reset(); this.feRun = 0; this.closed = false; this.strikes = 0;
    if (this.claimMode && this.claimed) this.claimMode = null; // END(CLAIMED) on disconnect, then reboot
  }

  async _plaintext(cmd, f) {
    switch (cmd) {
      case 0x0054: return [this.status()];
      case 0x0046: return [this.ident()];
      case 0x0043: return [Uint8Array.of(0x00, 0x43, this.fw[0], this.fw[1], this.fw[2], 0x00)];
      case 0x0044: return [S.concat(Uint8Array.of(0x00, 0x44), new Uint8Array(16))];
      case 0x0050: return [Uint8Array.of(0x00, 0x50, this.claimed ? 0x05 : 0x03)];
      case 0x0055: case 0x0056: {
        const lens = S.BODY_LEN.h2d;
        const r = this.reasm.push(f, (lo, sub) => (lens[lo] ? lens[lo][sub] : undefined));
        if (!r) return [];
        if (r.err) { this.pending = null; return this._err(f[1], r.sub, r.err); }
        return cmd === 0x0055 ? this._claim(r.sub, r.body) : this._auth(r.sub, r.body);
      }
      default: return [];
    }
  }

  async _claim(sub, body) {
    if (this.claimed && sub !== S.CLAIM_SUB.EXIT) return this._err(0x55, sub, E.ALREADY_CLAIMED);
    if (!this.claimMode) return this._err(0x55, sub, this.claimed ? E.ALREADY_CLAIMED : E.NOT_IN_CLAIM_MODE);
    switch (sub) {
      case S.CLAIM_SUB.BEGIN: {
        if (this.renders >= 3) { this.claimMode = null; return this._err(0x55, sub, E.ATTEMPTS_EXHAUSTED); }
        if (body[0] !== 0x02 || body[1] < 20 || body[1] > 244) return this._err(0x55, sub, E.MALFORMED);
        const qc = body.subarray(2, 66);
        if (!S.isValidPoint(qc)) return this._err(0x55, sub, E.BAD_POINT);
        this.fragMax = body[1];
        const kp = await this._keyPair();
        const nd = this._rand('nd'), kNew = this._rand('kNew');
        const cd = await S.commitment(nd, this.uid, kp.Q, qc);
        const df = this.dflags();
        this.pending = { step: 'begun', qc: Uint8Array.from(qc), kp, nd, kNew, dflags: df };
        return this._frag(0x55, sub, S.concat(df, kp.Q, cd));
      }
      case S.CLAIM_SUB.NONCE: {
        const p = this.pending;
        if (!p || p.step !== 'begun') { this.pending = null; return this._err(0x55, sub, E.BAD_STATE); }
        const z = await S.ecdh(p.kp.privateKey, p.qc);
        const tc = S.claimTranscript(p.dflags, this.uid, p.qc, p.kp.Q, body, p.nd);
        const prk = await S.extract(new Uint8Array(16), z);
        const kWrap = await S.kdf(prk, 'OD2/wrap', tc);
        const w = await S.ccmEncrypt(kWrap, S.WRAP_NONCE, S.wrapAad(this.uid), p.kNew);
        this.renders++;
        this.configLocked = true;
        this.lastCode = S.codeFromRaw(await S.codeRaw(body, this.uid, p.qc, p.kp.Q, p.nd));
        Object.assign(p, { step: 'nonce', tc, prk, nc: Uint8Array.from(body) });
        return this._frag(0x55, sub, S.concat(p.nd, w));
      }
      case S.CLAIM_SUB.CONFIRM: {
        const p = this.pending;
        if (!p || p.step !== 'nonce') { this.pending = null; return this._err(0x55, sub, E.BAD_STATE); }
        const kConf = await S.kdf(p.kNew, 'OD2/k-conf', this.uid);
        if (!S.ctEqual(body, await S.kdf(kConf, 'OD2/claim-c', p.tc))) { this.pending = null; return this._err(0x55, sub, E.AUTH_FAILED); }
        this.kDev = p.kNew; this.origin = 'CLAIMED';
        const tagD = await S.kdf(kConf, 'OD2/claim-d', p.tc);
        const keys = await S.sessionKeys(p.prk, p.tc);
        this.session = { kH2d: keys.kH2d, kD2h: keys.kD2h, sid: keys.sid, rxLast: 0, seen: new Set(), txCtr: 0 };
        this.pending = null;
        return this._frag(0x55, sub, S.concat(tagD, S.u16le(this.timeoutS)));
      }
      case S.CLAIM_SUB.ABORT: this.pending = null; return this._frag(0x55, sub, new Uint8Array(0));
      case S.CLAIM_SUB.EXIT: this.pending = null; this.claimMode = null; this.exited = true; return this._frag(0x55, sub, new Uint8Array(0));
      default: return this._err(0x55, sub, E.MALFORMED);
    }
  }

  async _auth(sub, body) {
    if (!this.claimed) return this._err(0x56, sub, E.NOT_CLAIMED);
    if (sub === S.AUTH_SUB.HELLO) {
      if (this.busy) { return this._err(0x56, sub, E.BUSY); }
      if (body[0] !== 0x02 || body[1] < 20 || body[1] > 244) return this._err(0x56, sub, E.MALFORMED);
      const qc = body.subarray(2, 66), nc = body.subarray(66, 82);
      this.session = null;
      if (!S.isValidPoint(qc)) return this._err(0x56, sub, E.BAD_POINT);
      this.fragMax = body[1];
      const kp = await this._keyPair();
      const nd = this._rand('nd');
      const z = await S.ecdh(kp.privateKey, qc);
      const df = this.authDflags();
      const ta = S.authTranscript(df, this.uid, qc, kp.Q, nc, nd);
      const kExt = await S.kdf(this.kDev, 'OD2/k-ext', this.uid);
      const prk = await S.extract(kExt, z);
      this.pending = { step: 'hello', expC: await S.kdf(prk, 'OD2/auth-c', ta), tagD: await S.kdf(prk, 'OD2/auth-d', ta), keys: await S.sessionKeys(prk, ta) };
      return this._frag(0x56, sub, S.concat(df, kp.Q, nd));
    }
    if (sub === S.AUTH_SUB.FINISH) {
      const p = this.pending;
      if (!p || p.step !== 'hello') return this._err(0x56, sub, E.BAD_STATE);
      this.pending = null;
      if (!S.ctEqual(body, p.expC)) return this._err(0x56, sub, E.AUTH_FAILED);
      this.session = { kH2d: p.keys.kH2d, kD2h: p.keys.kD2h, sid: p.keys.sid, rxLast: 0, seen: new Set(), txCtr: 0 };
      this.feRun = 0; this.strikes = 0;
      return this._frag(0x56, sub, S.concat(p.tagD, S.u16le(this.timeoutS)));
    }
    return this._err(0x56, sub, E.MALFORMED);
  }

  async _execute(cmd, payload) {
    if (this.handlers[cmd]) return this.handlers[cmd](payload);
    const lo = cmd & 0xff;
    switch (cmd) {
      case 0x0040: {
        if (!this.config) return Uint8Array.of(0xff, 0x40, 0x00);
        const view = this.claimed ? P.deviceReadView(this.config, { kDev: this.kDev }) : this.config;
        return S.concat(Uint8Array.of(0x00, 0x40, 0x00, 0x00), S.u16le(view.length), view);
      }
      case 0x0041: {
        const v = P.deviceWriteVerdict(payload, { claimed: this.claimed, kDev: this.kDev, legacySecrets: this.legacySecrets, storedConfig: this.config });
        if (!v.accept) return Uint8Array.of(0xff, 0x41, v.err, 0x00);
        this.config = this.claimed ? Uint8Array.from(payload) : P.deviceStoreUnclaimed(payload);
        this.writes = (this.writes || 0) + 1;
        return Uint8Array.of(0x00, 0x41);
      }
      case 0x0057: return this._secKey(payload);
      default: return Uint8Array.of(0x00, lo);
    }
  }
  async _secKey(pt) {
    const sub = pt[0];
    if (sub === S.KEY_SUB.ROTATE) {
      this.pendingRotate = this._rand('kNew');
      return S.concat(Uint8Array.of(0x00, 0x57, sub), this.pendingRotate);
    }
    if (sub === S.KEY_SUB.ROTATE_CONFIRM) {
      const kNew = this.pendingRotate;
      this.pendingRotate = null;
      if (!kNew) return Uint8Array.of(0xff, 0x57, sub, E.BAD_STATE);
      const { tag } = await S.rotateTag(kNew, this.uid, this.session.sid);
      if (!S.ctEqual(tag, pt.subarray(1, 17))) return Uint8Array.of(0xff, 0x57, sub, E.AUTH_FAILED);
      if (this.failRotatePersist) return Uint8Array.of(0xff, 0x57, sub, E.STORAGE_ERROR);
      this.kDev = kNew; this.origin = 'CLAIMED';
      this._teardownAfterReply = true;
      return Uint8Array.of(0x00, 0x57, sub);
    }
    if (sub === S.KEY_SUB.UNCLAIM) {
      if (pt[1] !== 0xa5 || pt[2] !== 0x5a) return Uint8Array.of(0xff, 0x57, sub, E.MALFORMED);
      this.kDev = null; this.origin = null;
      this._teardownAfterReply = true;
      return Uint8Array.of(0x00, 0x57, sub);
    }
    return Uint8Array.of(0xff, 0x57, sub || 0, E.MALFORMED);
  }
}

/**
 * A transport for od-sec2-session.js on top of a RefDevice: send() delivers the frame, the
 * device's replies queue up as notifications, receive(match, timeoutMs) pops the next match.
 */
class RefTransport {
  constructor(device, { dropReplies = 0, tamper = null } = {}) {
    this.device = device; this.queue = []; this.sent = []; this.waiters = []; this.connected = true;
    this.dropReplies = dropReplies; this.tamper = tamper;
  }
  async send(frame) {
    if (!this.connected || this.device.closed) { this.connected = false; throw new Error('disconnected'); }
    this.sent.push(Uint8Array.from(frame));
    const replies = await this.device.receive(frame);
    if (this.device._teardownAfterReply) {
      this.device._teardownAfterReply = false;
      this.device._lastSession = this.device.session;
      this.device.session = null;
    }
    for (let r of replies) {
      if (this.dropReplies > 0) { this.dropReplies--; continue; }
      if (this.tamper) r = this.tamper(r) || r;
      this.queue.push(r);
    }
    if (this.device.closed) this.connected = false;
  }
  async receive(match, timeoutMs) {
    for (;;) {
      const i = this.queue.findIndex(match);
      if (i >= 0) return this.queue.splice(i, 1)[0];
      // Nothing else can arrive in this synchronous double: silence is a timeout.
      return null;
    }
  }
  drain() { const q = this.queue; this.queue = []; return q; }
}

module.exports = { RefDevice, RefTransport, DeviceReassembler };
