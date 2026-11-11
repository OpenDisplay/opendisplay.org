/*
 * OpenDisplay Secure Session v2 ("SEC2"): primitives, key schedule, handshake messages and the
 * record layer, for the browser and for node (node --test uses node's WebCrypto).
 *
 * Normative source: Firmware_Unified docs/SECURITY_V2.md (revision 4). Written from the spec
 * text; it is the third implementation next to the firmware (od_sec2.c) and py-opendisplay
 * (src/opendisplay/sec2/). Acceptance test: tests/od-sec2.test.js reproduces every vector of
 * py-opendisplay's tests/fixtures/sec2_vectors.json (copied to tests/fixtures/).
 *
 * WebCrypto has neither AES-CMAC nor AES-CCM. Both are built here from AES itself:
 *   - one AES block      = AES-CBC encryption of that block under a zero IV (first 16 bytes);
 *   - CMAC / CBC-MAC     = AES-CBC over the whole (prepared) message, last block;
 *   - CCM keystream      = AES-CTR with the RFC 3610 counter block A_1 and a 16-bit counter.
 * P-256 key generation and ECDH are WebCrypto's. The point check of § 2 is done here, with
 * BigInt, before any ECDH call (WebCrypto's own import check is a second line, not relied on).
 *
 * Nothing in this file touches Bluetooth or the page. od-sec2-session.js drives it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpenDisplaySec2 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- environment ----------------------------------------------------------------------
  function cryptoObj() {
    const c = (typeof globalThis !== 'undefined' && globalThis.crypto) ? globalThis.crypto : null;
    if (!c || !c.subtle) throw new Error('WebCrypto is not available (needs a secure context: https or localhost)');
    return c;
  }
  function subtle() { return cryptoObj().subtle; }
  function randomBytes(n) {
    const out = new Uint8Array(n);
    cryptoObj().getRandomValues(out);
    return out;
  }

  // ---- bytes -----------------------------------------------------------------------------
  function u8(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (Array.isArray(x)) return Uint8Array.from(x);
    if (typeof x === 'string') return hexToBytes(x);
    throw new TypeError('expected bytes');
  }
  function hexToBytes(hex) {
    const s = String(hex || '').replace(/\s+/g, '');
    if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error('invalid hex');
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }
  function bytesToHex(b) {
    return Array.from(u8(b), x => x.toString(16).padStart(2, '0')).join('');
  }
  function concat(...parts) {
    let n = 0;
    const arr = parts.map(p => (typeof p === 'number' ? Uint8Array.of(p) : u8(p)));
    for (const p of arr) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of arr) { out.set(p, o); o += p.length; }
    return out;
  }
  function ascii(s) { return Uint8Array.from(String(s), c => c.charCodeAt(0)); }
  function u16le(v) { return Uint8Array.of(v & 0xff, (v >>> 8) & 0xff); }
  function u32le(v) { return Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); }
  function readU16le(b, o) { return b[o] | (b[o + 1] << 8); }
  function readU32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function equal(a, b) {
    a = u8(a); b = u8(b);
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  /** Constant-time comparison of equal-length byte strings (§ 2 ct_equal). */
  function ctEqual(a, b) {
    a = u8(a); b = u8(b);
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }
  function xor(a, b) {
    const out = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
    return out;
  }
  function wipe(b) { if (b instanceof Uint8Array) b.fill(0); }
  const ZERO16 = new Uint8Array(16);

  // ---- AES via WebCrypto ------------------------------------------------------------------
  async function importAes(key, alg) {
    const k = u8(key);
    if (k.length !== 16) throw new Error('AES-128 key must be 16 bytes');
    return subtle().importKey('raw', k, { name: alg }, false, ['encrypt', 'decrypt']);
  }
  /** AES-CBC over `data` (a multiple of 16 bytes) with a zero IV; the padding block is cut off. */
  async function cbcZeroIv(key, data) {
    const k = await importAes(key, 'AES-CBC');
    const out = new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv: ZERO16 }, k, data));
    return out.subarray(0, data.length);
  }
  /** One AES-128 block encryption. */
  async function aesBlock(key, block) {
    const b = u8(block);
    if (b.length !== 16) throw new Error('AES block must be 16 bytes');
    return Uint8Array.from(await cbcZeroIv(key, b));
  }

  // ---- AES-CMAC (RFC 4493 / SP 800-38B) ---------------------------------------------------
  function dbl(l) {
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = ((l[i] << 1) | (i < 15 ? (l[i + 1] >>> 7) : 0)) & 0xff;
    if (l[0] & 0x80) out[15] ^= 0x87;
    return out;
  }
  async function cmac(key, message) {
    const m = u8(message);
    const L = await aesBlock(key, ZERO16);
    const k1 = dbl(L);
    const k2 = dbl(k1);
    const n = Math.max(1, Math.ceil(m.length / 16));
    const complete = m.length > 0 && m.length % 16 === 0;
    const buf = new Uint8Array(n * 16);
    buf.set(m);
    if (!complete) buf[m.length] = 0x80;
    const last = buf.subarray((n - 1) * 16);
    last.set(xor(last, complete ? k1 : k2));
    const c = await cbcZeroIv(key, buf);
    const tag = Uint8Array.from(c.subarray((n - 1) * 16, n * 16));
    wipe(L); wipe(k1); wipe(k2);
    return tag;
  }

  // ---- AES-CCM, 13-byte nonce (L = 2), 12-byte tag (M = 12) -------------------------------
  const CCM_TAG = 12;
  const CCM_NONCE = 13;
  function ccmMacInput(nonce, aad, pt) {
    const flags = (aad.length ? 0x40 : 0) | (((CCM_TAG - 2) / 2) << 3) | (2 - 1);
    const b0 = concat(flags, nonce, Uint8Array.of((pt.length >>> 8) & 0xff, pt.length & 0xff));
    const parts = [b0];
    if (aad.length) {
      if (aad.length >= 0xff00) throw new Error('AAD too long');
      const a = concat(Uint8Array.of((aad.length >>> 8) & 0xff, aad.length & 0xff), aad);
      parts.push(a, new Uint8Array((16 - (a.length % 16)) % 16));
    }
    if (pt.length) parts.push(pt, new Uint8Array((16 - (pt.length % 16)) % 16));
    return concat(...parts);
  }
  function ccmCounter(nonce, i) {
    return concat(0x01, nonce, Uint8Array.of((i >>> 8) & 0xff, i & 0xff));
  }
  async function ccmKeystreamXor(key, nonce, data) {
    if (!data.length) return new Uint8Array(0);
    const k = await importAes(key, 'AES-CTR');
    return new Uint8Array(await subtle().encrypt({ name: 'AES-CTR', counter: ccmCounter(nonce, 1), length: 16 }, k, data));
  }
  function checkCcmArgs(nonce, pt) {
    if (nonce.length !== CCM_NONCE) throw new Error('CCM nonce must be 13 bytes');
    if (pt.length > 0xffff) throw new Error('CCM payload too long for L = 2');
  }
  /** CCM(k, n, a, p) = c || t (§ 2). */
  async function ccmEncrypt(key, nonce, aad, plaintext) {
    const n = u8(nonce), a = u8(aad || []), p = u8(plaintext || []);
    checkCcmArgs(n, p);
    const mac = await cbcZeroIv(key, ccmMacInput(n, a, p));
    const t = mac.subarray(mac.length - 16, mac.length - 16 + CCM_TAG);
    const s0 = await aesBlock(key, ccmCounter(n, 0));
    const c = await ccmKeystreamXor(key, n, p);
    return concat(c, xor(t, s0.subarray(0, CCM_TAG)));
  }
  /** Decrypt-and-verify; returns the plaintext, or null on any failure (tag, length). */
  async function ccmDecrypt(key, nonce, aad, ctTag) {
    const n = u8(nonce), a = u8(aad || []), ct = u8(ctTag || []);
    if (ct.length < CCM_TAG) return null;
    const c = ct.subarray(0, ct.length - CCM_TAG);
    const u = ct.subarray(ct.length - CCM_TAG);
    checkCcmArgs(n, c);
    const p = await ccmKeystreamXor(key, n, c);
    const mac = await cbcZeroIv(key, ccmMacInput(n, a, p));
    const t = mac.subarray(mac.length - 16, mac.length - 16 + CCM_TAG);
    const s0 = await aesBlock(key, ccmCounter(n, 0));
    if (!ctEqual(xor(t, s0.subarray(0, CCM_TAG)), u)) { wipe(p); return null; }
    return p;
  }

  // ---- P-256 ------------------------------------------------------------------------------
  const P256_P = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
  const P256_B = BigInt('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b');
  function bigFrom(b) { return BigInt('0x' + (bytesToHex(b) || '0')); }
  /**
   * § 2 point validation, before any vendor ECC call: X < p, Y < p, Y^2 = X^3 - 3X + b (mod p).
   * `q` is the 64-byte wire form X || Y. (0, 0) and the identity fail the equation.
   */
  function isValidPoint(q) {
    const b = u8(q);
    if (b.length !== 64) return false;
    const x = bigFrom(b.subarray(0, 32));
    const y = bigFrom(b.subarray(32));
    if (x >= P256_P || y >= P256_P) return false;
    const p = P256_P;
    const lhs = (y * y) % p;
    const rhs = (((x * x) % p) * x - 3n * x + P256_B) % p;
    return lhs === ((rhs % p) + p) % p;
  }
  async function exportPoint(publicKey) {
    const raw = new Uint8Array(await subtle().exportKey('raw', publicKey));
    if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('unexpected public key encoding');
    return raw.subarray(1);
  }
  /** Fresh ephemeral key pair: { privateKey: CryptoKey, Q: 64-byte X || Y }. */
  async function generateKeyPair() {
    const kp = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    return { privateKey: kp.privateKey, Q: Uint8Array.from(await exportPoint(kp.publicKey)) };
  }
  // PKCS#8 wrapper of a bare P-256 private scalar (no public key; the importer computes it).
  const PKCS8_P256_PREFIX = hexToBytes('3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420');
  function b64urlToBytes(s) {
    const b = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const bin = (typeof atob === 'function') ? atob(b + '==='.slice((b.length + 3) % 4)) : Buffer.from(b, 'base64').toString('binary');
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }
  /** TEST SEAM: a key pair from a fixed private scalar (the vectors' dc / dd). */
  async function keyPairFromScalar(d) {
    const scalar = u8(d);
    if (scalar.length !== 32) throw new Error('scalar must be 32 bytes');
    const k = await subtle().importKey('pkcs8', concat(PKCS8_P256_PREFIX, scalar), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const jwk = await subtle().exportKey('jwk', k);
    const Q = concat(b64urlToBytes(jwk.x), b64urlToBytes(jwk.y));
    return { privateKey: k, Q };
  }
  class Sec2PointError extends Error {
    constructor(msg) { super(msg || 'peer public key failed validation (BAD_POINT)'); this.name = 'Sec2PointError'; }
  }
  /** Z = x-coordinate of d·Q (32 bytes). Validates Q first (§ 2). */
  async function ecdh(privateKey, peerQ) {
    const q = u8(peerQ);
    if (!isValidPoint(q)) throw new Sec2PointError();
    const pub = await subtle().importKey('raw', concat(0x04, q), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: pub }, privateKey, 256));
  }

  // ---- KDF, extract, labels (§ 2.1 - § 2.3) ------------------------------------------------
  // Label -> the Context lengths it may take. A wrong length is a programming error, refused.
  const LABELS = Object.freeze({
    'OD2/k-ext': [8], 'OD2/k-conf': [8], 'OD2/k-lan': [8], 'OD2/v1-compat': [8],
    'OD2/wrap': [179], 'OD2/h2d': [179, 178], 'OD2/d2h': [179, 178], 'OD2/sid': [179, 178],
    'OD2/claim-c': [179], 'OD2/claim-d': [179], 'OD2/auth-c': [178], 'OD2/auth-d': [178],
    'OD2/rotate-c': [24]
  });
  function kdfInput(label, context) {
    const ctx = u8(context);
    const allowed = LABELS[label];
    if (!allowed) throw new Error('unknown KDF label ' + label);
    if (!allowed.includes(ctx.length)) throw new Error(`KDF ${label}: context of ${ctx.length} bytes, want ${allowed.join(' or ')}`);
    return concat(0x01, ascii(label), 0x00, ctx, Uint8Array.of(0x00, 0x80));
  }
  /** KDF(K_in, Label, Context) = CMAC(K_in, 0x01 || Label || 0x00 || Context || 0x00 0x80). */
  async function kdf(kIn, label, context) { return cmac(kIn, kdfInput(label, context)); }
  /** PRK = CMAC(salt, Z). */
  async function extract(salt, z) { return cmac(salt, z); }

  /** § 2.2: K_ext, K_conf, K_lan, K_v1 (derived). */
  async function keyHierarchy(kDev, uid) {
    const u = u8(uid);
    if (u.length !== 8) throw new Error('uid must be 8 bytes');
    return {
      kExt: await kdf(kDev, 'OD2/k-ext', u),
      kConf: await kdf(kDev, 'OD2/k-conf', u),
      kLan: await kdf(kDev, 'OD2/k-lan', u),
      kV1: await kdf(kDev, 'OD2/v1-compat', u)
    };
  }
  /** § 10.2: the 0x27 key at rest. K_dev itself while LEGACY and never rotated, else derived. */
  async function kV1AtRest(kDev, uid, legacyUnrotated) {
    return legacyUnrotated ? Uint8Array.from(u8(kDev)) : kdf(kDev, 'OD2/v1-compat', uid);
  }

  // ---- commitment, code, transcripts (§ 2.3, § 8.4) ---------------------------------------
  async function commitment(nd, uid, qd, qc) { return cmac(nd, concat(ascii('OD2/commit'), uid, qd, qc)); }
  async function codeRaw(nc, uid, qc, qd, nd) { return cmac(nc, concat(ascii('OD2/code'), uid, qc, qd, nd)); }
  /** code = (u32 big-endian of code_raw[12..15]) mod 1 000 000, six digits zero-padded. */
  function codeFromRaw(raw) {
    const r = u8(raw);
    const v = ((r[12] << 24) | (r[13] << 16) | (r[14] << 8) | r[15]) >>> 0;
    return String(v % 1000000).padStart(6, '0');
  }
  function formatCode(code) { const c = String(code); return c.slice(0, 3) + ' ' + c.slice(3); }
  /**
   * What the user typed -> six digits, or null. Spaces, dashes and dots between digits are
   * allowed ("508 279", "508-279"); anything else (letters, a seventh digit) is refused, so a
   * typo is never silently "corrected".
   */
  function normalizeTypedCode(text) {
    const s = String(text == null ? '' : text).trim().replace(/[\s \-.]/g, '');
    return /^[0-9]{6}$/.test(s) ? s : null;
  }
  function claimTranscript(dflags, uid, qc, qd, nc, nd) {
    const t = concat(ascii('OD2/claim'), 0x02, dflags & 0xff, uid, qc, qd, nc, nd);
    if (t.length !== 179) throw new Error('Tc must be 179 bytes');
    return t;
  }
  function authTranscript(dflags, uid, qc, qd, nc, nd) {
    const t = concat(ascii('OD2/auth'), 0x02, dflags & 0xff, uid, qc, qd, nc, nd);
    if (t.length !== 178) throw new Error('Ta must be 178 bytes');
    return t;
  }
  /** W's AAD: "OD2/wrap" || uid; W's nonce: 13 zero bytes (single-use k_wrap, § 8.2). */
  function wrapAad(uid) { return concat(ascii('OD2/wrap'), uid); }
  const WRAP_NONCE = new Uint8Array(13);

  // ---- wire constants (§ 3) ---------------------------------------------------------------
  const OP = Object.freeze({ STATUS: 0x0054, CLAIM: 0x0055, AUTH: 0x0056, KEY: 0x0057, AUTHENTICATE_V1: 0x0050 });
  const CLAIM_SUB = Object.freeze({ BEGIN: 0x01, NONCE: 0x02, CONFIRM: 0x03, ABORT: 0x04, EXIT: 0x05 });
  const AUTH_SUB = Object.freeze({ HELLO: 0x01, FINISH: 0x02 });
  const KEY_SUB = Object.freeze({ ROTATE: 0x01, ROTATE_CONFIRM: 0x02, UNCLAIM: 0x03 });
  const UNCLAIM_GUARD = Uint8Array.of(0xa5, 0x5a);
  const VERSION = 0x02;
  const BODY_LEN = Object.freeze({
    h2d: { 0x55: { 1: 66, 2: 16, 3: 16, 4: 0, 5: 0 }, 0x56: { 1: 82, 2: 16 } },
    d2h: { 0x55: { 1: 81, 2: 44, 3: 18, 4: 0, 5: 0 }, 0x56: { 1: 81, 2: 18 } }
  });
  const SEC_ERR = Object.freeze({
    MALFORMED: 0x01, BAD_STATE: 0x02, RATE_LIMITED: 0x03, NOT_IN_CLAIM_MODE: 0x04, ALREADY_CLAIMED: 0x05,
    NOT_CLAIMED: 0x06, AUTH_FAILED: 0x07, EXPIRED: 0x08, BAD_POINT: 0x09, CRYPTO_ERROR: 0x0a,
    STORAGE_ERROR: 0x0b, BUSY: 0x0c, ATTEMPTS_EXHAUSTED: 0x0d, LOCKED: 0x0e, WRONG_TRANSPORT: 0x0f
  });
  const SEC_ERR_NAME = Object.freeze(Object.fromEntries(Object.entries(SEC_ERR).map(([k, v]) => [v, k])));
  // Sealed NACK codes inside a D->H record (§ 9.5) and the dispatcher refusals (§ 3.4).
  const REFUSAL = Object.freeze({ ENGINE_FAULT: 0x00, RECORD: 0xf1, REPLAY: 0xf2, INTEGRITY: 0xf3, CLAIM_MODE: 0xfd, OVERSIZE: 0xfe });
  // § 6 rule 1: always plaintext, never sealed, even inside a session.
  const PLAINTEXT_SET = Object.freeze([0x0043, 0x0044, 0x0046, 0x0050, 0x0054, 0x0055, 0x0056]);
  function isPlaintextOpcode(cmd) { return PLAINTEXT_SET.includes(cmd & 0xffff); }
  const FRAG_MAX_MIN = 20;
  const FRAG_MAX_MAX = 244;
  const FRAG_LAST = 0x80;

  // ---- SEC_STATUS (§ 5.1) -----------------------------------------------------------------
  const STATE = Object.freeze({ UNCLAIMED: 0, CLAIM_PENDING: 1, CLAIMED: 2, LOCKED: 3 });
  const STATE_NAME = ['UNCLAIMED', 'CLAIM_PENDING', 'CLAIMED', 'LOCKED'];
  const STATUS_FLAG = Object.freeze({
    CLAIM_MODE: 0x01, SESSION_ACTIVE: 0x02, RESET_PENDING: 0x04, LEGACY_SECRETS_OPEN: 0x08,
    ROTATION_SUGGESTED: 0x10, CLAIM_MODE_FRESH: 0x20, CONFIG_LOCKED: 0x40
  });
  const DFLAG = Object.freeze({ HAS_PANEL: 0x01, HAS_RESET_PIN: 0x02, KEY_LEGACY: 0x04, CLAIM_MODE_FRESH: 0x08 });
  /** Parse [00][54][19 B body]; null when it is not a SEC_STATUS reply. Unauthenticated: advisory. */
  function parseSecStatus(frame) {
    const b = u8(frame);
    if (b.length < 19 || b[0] !== 0x00 || b[1] !== 0x54) return null;
    const flags = b[4];
    const dflags = b[17];
    return {
      secVer: b[2], state: b[3], stateName: STATE_NAME[b[3]] || ('state ' + b[3]), flags,
      windowS: readU16le(b, 5), uid: Uint8Array.from(b.subarray(7, 15)), uidHex: bytesToHex(b.subarray(7, 15)),
      timeoutS: readU16le(b, 15), dflags, rendersLeft: b[18],
      claimMode: !!(flags & STATUS_FLAG.CLAIM_MODE), sessionActive: !!(flags & STATUS_FLAG.SESSION_ACTIVE),
      legacySecretsOpen: !!(flags & STATUS_FLAG.LEGACY_SECRETS_OPEN), rotationSuggested: !!(flags & STATUS_FLAG.ROTATION_SUGGESTED),
      claimModeFresh: !!(flags & STATUS_FLAG.CLAIM_MODE_FRESH), configLocked: !!(flags & STATUS_FLAG.CONFIG_LOCKED),
      hasPanel: !!(dflags & DFLAG.HAS_PANEL), hasResetPin: !!(dflags & DFLAG.HAS_RESET_PIN), keyLegacy: !!(dflags & DFLAG.KEY_LEGACY),
      claimed: b[3] === STATE.CLAIMED, locked: b[3] === STATE.LOCKED, unclaimed: b[3] === STATE.UNCLAIMED || b[3] === STATE.CLAIM_PENDING
    };
  }
  /** A 4-byte [FF][cmd_lo][sub][err] for opcodes 0x54..0x57, else null. */
  function parseSecError(frame) {
    const b = u8(frame);
    if (b.length !== 4 || b[0] !== 0xff || b[1] < 0x54 || b[1] > 0x57) return null;
    return { cmdLo: b[1], sub: b[2], err: b[3], name: SEC_ERR_NAME[b[3]] || ('0x' + b[3].toString(16)) };
  }
  class Sec2Error extends Error {
    constructor(err, sub, message) {
      super(message || ('SEC2 error ' + (SEC_ERR_NAME[err] || err)));
      this.name = 'Sec2Error';
      this.err = err;
      this.code = SEC_ERR_NAME[err] || String(err);
      this.sub = sub;
    }
  }

  // ---- handshake fragmentation (§ 3.3) ----------------------------------------------------
  function checkFragMax(fragMax) {
    if (!Number.isInteger(fragMax) || fragMax < FRAG_MAX_MIN || fragMax > FRAG_MAX_MAX) throw new Error('frag_max must be 20..244');
  }
  /**
   * The deterministic split: every non-LAST fragment carries frag_max - 4 bytes, the LAST one
   * 1..frag_max - 4; an empty body is one empty LAST fragment. Used for both directions.
   */
  function fragment(cmdLo, sub, body, fragMax) {
    checkFragMax(fragMax);
    const b = u8(body || []);
    const chunk = fragMax - 4;
    if (!b.length) return [Uint8Array.of(0x00, cmdLo, sub, FRAG_LAST)];
    const n = Math.ceil(b.length / chunk);
    if (n > 127) throw new Error('body too long to fragment');
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(concat(Uint8Array.of(0x00, cmdLo, sub, i | (i === n - 1 ? FRAG_LAST : 0)), b.subarray(i * chunk, Math.min(b.length, (i + 1) * chunk))));
    }
    return out;
  }
  /**
   * Client-side reassembly of one D->H handshake message. Strict (§ 3.3: "a client MAY reject
   * any other split"): fragments must follow the deterministic split for the frag_max this client
   * declared, in order, with the expected sub, to exactly the fixed body length.
   * push(frame) -> { done:false } | { done:true, body } | { error, secError? }.
   */
  class Reassembler {
    constructor(cmdLo, sub, bodyLen, fragMax) {
      checkFragMax(fragMax);
      this.cmdLo = cmdLo; this.sub = sub; this.bodyLen = bodyLen; this.chunk = fragMax - 4;
      this.parts = []; this.got = 0; this.next = 0; this.finished = false;
    }
    push(frame) {
      const b = u8(frame);
      if (this.finished) return { error: 'message already complete' };
      const se = parseSecError(b);
      if (se && se.cmdLo === this.cmdLo) { this.finished = true; return { error: 'device error ' + se.name, secError: se }; }
      if (b.length < 4 || b[0] !== 0x00 || b[1] !== this.cmdLo) return { ignore: true };
      if (b[2] !== this.sub) return { error: `fragment for sub ${b[2]}, expected ${this.sub}` };
      const idx = b[3] & 0x7f, last = !!(b[3] & FRAG_LAST);
      const data = b.subarray(4);
      if (idx !== this.next) return this._fail('fragment index ' + idx + ', expected ' + this.next);
      const remaining = this.bodyLen - this.got;
      if (!last) {
        if (data.length !== this.chunk || data.length >= remaining) return this._fail('non-deterministic split (non-LAST fragment of ' + data.length + ' bytes)');
      } else if (this.bodyLen === 0 ? data.length !== 0 : (data.length !== remaining || data.length < 1 || data.length > this.chunk)) {
        return this._fail('LAST fragment of ' + data.length + ' bytes, expected ' + remaining);
      }
      this.parts.push(Uint8Array.from(data));
      this.got += data.length;
      this.next++;
      if (last) { this.finished = true; return { done: true, body: concat(...this.parts) }; }
      return { done: false };
    }
    _fail(msg) { this.finished = true; return { error: msg }; }
  }

  // ---- claim and auth, client side (§ 8, § 9) ---------------------------------------------
  /**
   * Client half of SEC_CLAIM. Pure state; the caller moves the bytes. Order:
   *   begin() -> body of BEGIN;  onBeginReply(body) -> body of NONCE;
   *   onNonceReply(body) -> { code, display } (the client's code; ask the user to TYPE it)
   *   confirm() -> body of CONFIRM (only after the key is durably stored, § 8.8)
   *   onConfirmReply(body) -> { kNew, timeoutS, keys: {kH2d, kD2h, sid} }.
   * Any check that fails throws; the caller sends ABORT and keeps nothing.
   */
  class ClaimClient {
    constructor({ uid, fragMax = FRAG_MAX_MIN, keyPair = null, nc = null } = {}) {
      this.uid = u8(uid);
      if (this.uid.length !== 8) throw new Error('uid must be 8 bytes');
      checkFragMax(fragMax);
      this.fragMax = fragMax;
      this._kp = keyPair; this._nc = nc ? u8(nc) : null;
      this.state = 'init';
    }
    async begin() {
      if (this.state !== 'init') throw new Error('BEGIN already sent');
      if (!this._kp) this._kp = await generateKeyPair();
      this.qc = this._kp.Q;
      this.state = 'begun';
      return concat(VERSION, this.fragMax, this.qc);
    }
    onBeginReply(body) {
      const b = u8(body);
      if (this.state !== 'begun' || b.length !== 81) throw new Error('unexpected BEGIN reply');
      this.dflags = b[0]; this.qd = Uint8Array.from(b.subarray(1, 65)); this.cd = Uint8Array.from(b.subarray(65, 81));
      if (!isValidPoint(this.qd)) throw new Sec2PointError('the display sent an invalid public key');
      this.nc = this._nc || randomBytes(16);
      this.state = 'nonce';
      return Uint8Array.from(this.nc);
    }
    async onNonceReply(body) {
      const b = u8(body);
      if (this.state !== 'nonce' || b.length !== 44) throw new Error('unexpected NONCE reply');
      const nd = Uint8Array.from(b.subarray(0, 16));
      const w = b.subarray(16, 44);
      if (!ctEqual(this.cd, await commitment(nd, this.uid, this.qd, this.qc))) { this.state = 'failed'; throw new Error('commitment mismatch: someone may be interfering'); }
      const z = await ecdh(this._kp.privateKey, this.qd);
      this._kp = null;
      this.nd = nd;
      this.tc = claimTranscript(this.dflags, this.uid, this.qc, this.qd, this.nc, nd);
      const prk = await extract(ZERO16, z);
      wipe(z);
      const kWrap = await kdf(prk, 'OD2/wrap', this.tc);
      const kNew = await ccmDecrypt(kWrap, WRAP_NONCE, wrapAad(this.uid), w);
      wipe(kWrap);
      if (!kNew || kNew.length !== 16) { wipe(prk); this.state = 'failed'; throw new Error('could not unwrap the key: someone may be interfering'); }
      this._prk = prk;
      this.kNew = kNew;
      this.code = codeFromRaw(await codeRaw(this.nc, this.uid, this.qc, this.qd, nd));
      this.state = 'code';
      return { code: this.code, display: formatCode(this.code), hasPanel: !!(this.dflags & DFLAG.HAS_PANEL), dflags: this.dflags };
    }
    /** Compare what the user typed with the client's own code (constant time not needed, § 8.4). */
    codeMatches(typed) { const c = normalizeTypedCode(typed); return c !== null && c === this.code; }
    async confirm() {
      if (this.state !== 'code') throw new Error('CONFIRM before the code step');
      this.kConf = await kdf(this.kNew, 'OD2/k-conf', this.uid);
      this.state = 'confirming';
      return kdf(this.kConf, 'OD2/claim-c', this.tc);
    }
    async onConfirmReply(body) {
      const b = u8(body);
      if (this.state !== 'confirming' || b.length !== 18) throw new Error('unexpected CONFIRM reply');
      const exp = await kdf(this.kConf, 'OD2/claim-d', this.tc);
      if (!ctEqual(exp, b.subarray(0, 16))) { this.state = 'unconfirmed'; throw new Error('the display did not confirm the claim (tag_d mismatch); keeping the key as a candidate'); }
      const keys = await sessionKeys(this._prk, this.tc);
      wipe(this._prk); this._prk = null;
      this.state = 'done';
      return { kNew: this.kNew, timeoutS: readU16le(b, 16), keys };
    }
    abort() { wipe(this._prk); this._prk = null; this._kp = null; this.state = 'aborted'; }
  }
  async function sessionKeys(prk, transcript) {
    return { kH2d: await kdf(prk, 'OD2/h2d', transcript), kD2h: await kdf(prk, 'OD2/d2h', transcript), sid: await kdf(prk, 'OD2/sid', transcript) };
  }
  /**
   * Client half of SEC_AUTH: hello() -> HELLO body; onHelloReply(body) -> FINISH body;
   * onFinishReply(body) -> { timeoutS, keys }. uid is the STORED uid for this key (§ 9.3).
   */
  class AuthClient {
    constructor({ uid, kDev, fragMax = FRAG_MAX_MIN, keyPair = null, nc = null } = {}) {
      this.uid = u8(uid); this.kDev = u8(kDev);
      if (this.uid.length !== 8 || this.kDev.length !== 16) throw new Error('uid 8 bytes, key 16 bytes');
      checkFragMax(fragMax);
      this.fragMax = fragMax; this._kp = keyPair; this._nc = nc ? u8(nc) : null; this.state = 'init';
    }
    async hello() {
      if (this.state !== 'init') throw new Error('HELLO already sent');
      if (!this._kp) this._kp = await generateKeyPair();
      this.qc = this._kp.Q;
      this.nc = this._nc || randomBytes(16);
      this.state = 'hello';
      return concat(VERSION, this.fragMax, this.qc, this.nc);
    }
    async onHelloReply(body) {
      const b = u8(body);
      if (this.state !== 'hello' || b.length !== 81) throw new Error('unexpected HELLO reply');
      this.dflags = b[0]; this.qd = Uint8Array.from(b.subarray(1, 65)); this.nd = Uint8Array.from(b.subarray(65, 81));
      const z = await ecdh(this._kp.privateKey, this.qd);
      this._kp = null;
      this.ta = authTranscript(this.dflags, this.uid, this.qc, this.qd, this.nc, this.nd);
      const kExt = await kdf(this.kDev, 'OD2/k-ext', this.uid);
      this._prk = await extract(kExt, z);
      wipe(kExt); wipe(z);
      this.state = 'finish';
      return kdf(this._prk, 'OD2/auth-c', this.ta);
    }
    async onFinishReply(body) {
      const b = u8(body);
      if (this.state !== 'finish' || b.length !== 18) throw new Error('unexpected FINISH reply');
      const exp = await kdf(this._prk, 'OD2/auth-d', this.ta);
      if (!ctEqual(exp, b.subarray(0, 16))) { this.state = 'failed'; throw new Error('the display failed mutual authentication (wrong device or an attacker)'); }
      const keys = await sessionKeys(this._prk, this.ta);
      wipe(this._prk); this._prk = null;
      this.state = 'done';
      return { timeoutS: readU16le(b, 16), keys, dflags: this.dflags, keyLegacy: !!(this.dflags & DFLAG.KEY_LEGACY) };
    }
  }
  /** § 11: tag = KDF(K_conf_new, "OD2/rotate-c", uid || sid), K_conf_new = KDF(K_new, "OD2/k-conf", uid). */
  async function rotateTag(kNew, uid, sid) {
    const kConfNew = await kdf(kNew, 'OD2/k-conf', uid);
    const tag = await kdf(kConfNew, 'OD2/rotate-c', concat(uid, sid));
    return { kConfNew, tag };
  }

  // ---- sealed records (§ 9.4, § 9.5) ------------------------------------------------------
  const CTR_MAX = 0xfffffffe;
  const DIR_H = 0x48, DIR_D = 0x44;
  const SEALED_D2H = 0xe5;
  const H2D_OVERHEAD = 2 + 4 + CCM_TAG; // the whole sealed frame minus the payload
  const D2H_OVERHEAD = 1 + 4 + CCM_TAG; // the sealed frame minus the plaintext response frame
  function recordNonce(dir, ctr) { return concat(dir, u32le(ctr), new Uint8Array(8)); }
  /** Seal one H->D frame. */
  async function sealH2d(kH2d, cmd, ctr, payload) {
    const hi = (cmd >>> 8) & 0xff, lo = cmd & 0xff;
    const body = await ccmEncrypt(kH2d, recordNonce(DIR_H, ctr), Uint8Array.of(VERSION, hi, lo), u8(payload || []));
    return concat(Uint8Array.of(hi, lo), u32le(ctr), body);
  }
  /** Seal one D->H frame (the device side; used by tests and the reference device). */
  async function sealD2h(kD2h, ctr, plaintextFrame) {
    const body = await ccmEncrypt(kD2h, recordNonce(DIR_D, ctr), Uint8Array.of(VERSION, SEALED_D2H), u8(plaintextFrame));
    return concat(SEALED_D2H, u32le(ctr), body);
  }
  /** Open one H->D frame (device side, for the reference device): plaintext payload or null. */
  async function openH2d(kH2d, frame) {
    const b = u8(frame);
    if (b.length < H2D_OVERHEAD) return null;
    return ccmDecrypt(kH2d, recordNonce(DIR_H, readU32le(b, 2)), Uint8Array.of(VERSION, b[0], b[1]), b.subarray(6));
  }
  /** Largest payload of a sealed H->D frame that fits `maxFrame` bytes. */
  function sealedPayloadBudget(maxFrame) { return Math.max(0, maxFrame - H2D_OVERHEAD); }

  /**
   * The client end of one session: counters, keys and the § 9.5 client receive rules.
   * One object per connection; drop it on any disconnect (§ 9.7 rule 1).
   */
  class ClientRecordLayer {
    constructor({ kH2d, kD2h, sid = null, timeoutS = 3600, now = Date.now }) {
      this.kH2d = u8(kH2d); this.kD2h = u8(kD2h); this.sid = sid ? u8(sid) : null;
      this.txCtr = 0; this.rxLast = 0; this.failures = 0;
      this.timeoutS = timeoutS || 3600;
      this._now = now;
      this.openedAt = now();
      this.closed = false;
    }
    /** True once 90 % of the session lifetime has passed (§ 9.7 rule 5). */
    renewalDue() { return (this._now() - this.openedAt) >= this.timeoutS * 900; }
    expired() { return (this._now() - this.openedAt) >= this.timeoutS * 1000; }
    /** Seal [cmd_hi][cmd_lo][payload]; the caller checks the size against its frame limit. */
    async seal(frame) {
      if (this.closed) throw new Error('SEC2 session closed');
      const b = u8(frame);
      if (b.length < 2) throw new Error('command too short');
      const cmd = (b[0] << 8) | b[1];
      if (isPlaintextOpcode(cmd)) throw new Error('opcode 0x' + cmd.toString(16) + ' is in the plaintext set and must not be sealed');
      if (this.txCtr >= CTR_MAX) { this.closed = true; throw new Error('SEC2 counter exhausted; a new handshake is needed'); }
      this.txCtr += 1;
      return sealH2d(this.kH2d, cmd, this.txCtr, b.subarray(2));
    }
    /**
     * Open a sealed D->H frame. Returns { ok:true, plaintext } or { ok:false, reason, close }.
     * close = true after the third failure: the caller disconnects (§ 9.5 client rule 1).
     */
    async open(frame) {
      const b = u8(frame);
      if (b.length < D2H_OVERHEAD || b[0] !== SEALED_D2H) return { ok: false, reason: 'not a sealed frame', close: false };
      const ctr = readU32le(b, 1);
      if (ctr === 0 || ctr === 0xffffffff || ctr <= this.rxLast) return { ok: false, reason: 'counter ' + ctr + ' not above ' + this.rxLast, close: false };
      const pt = await ccmDecrypt(this.kD2h, recordNonce(DIR_D, ctr), Uint8Array.of(VERSION, SEALED_D2H), b.subarray(5));
      if (!pt) {
        this.failures += 1;
        return { ok: false, reason: 'bad tag', close: this.failures >= 3 };
      }
      this.rxLast = ctr;
      return { ok: true, plaintext: pt, ctr };
    }
    destroy() { wipe(this.kH2d); wipe(this.kD2h); wipe(this.sid); this.closed = true; }
  }

  /**
   * § 9.5 client receive rules, for a frame that arrived while a session is live.
   * `sent` describes what this client has sent and still awaits: { cmdLos:Set<number> }.
   * Returns one of:
   *   'sealed'            open it with ClientRecordLayer.open
   *   'session_gone'      [00][cmd_lo][FE]: drop the session, HELLO, retry once if idempotent
   *   'oversize'          plaintext [FF][cmd_lo][FE] for a command this client sent (§ 3.4:
   *                       accept in both forms; unauthenticated, so error only)
   *   'sec_error'         4-byte SEC error to a SEC opcode this client sent (advisory)
   *   'plaintext'         a reply to a plaintext-set opcode this client sent
   *   'discard'           anything else
   */
  function classifyInbound(frame, sent) {
    const b = u8(frame);
    const los = (sent && sent.cmdLos) || new Set();
    if (b.length >= D2H_OVERHEAD && b[0] === SEALED_D2H) return 'sealed';
    if (b.length === 3 && b[0] === 0x00 && b[2] === 0xfe) return 'session_gone';
    if (b.length === 3 && b[0] === 0xff && b[2] === 0xfe && los.has(b[1])) return 'oversize';
    if (b.length === 4 && b[0] === 0xff && b[1] >= 0x54 && b[1] <= 0x57 && los.has(b[1])) return 'sec_error';
    if (b.length >= 2 && (b[0] === 0x00 || b[0] === 0xff) && isPlaintextOpcode(b[1]) && los.has(b[1])) return 'plaintext';
    return 'discard';
  }
  /** A decrypted (or plaintext) response [FF][cmd_lo][code] that is a dispatcher refusal, or null. */
  function parseRefusal(plain) {
    const b = u8(plain);
    if (b.length !== 3 || b[0] !== 0xff) return null;
    const names = { 0x00: 'ENGINE_FAULT', 0xf1: 'RECORD', 0xf2: 'REPLAY', 0xf3: 'INTEGRITY', 0xfd: 'CLAIM_MODE', 0xfe: 'OVERSIZE' };
    return names[b[2]] ? { cmdLo: b[1], code: b[2], name: names[b[2]] } : null;
  }

  return {
    // bytes
    hexToBytes, bytesToHex, concat, ascii, u8, equal, ctEqual, randomBytes, readU16le, readU32le, u16le, u32le, wipe,
    // primitives
    aesBlock, cmac, ccmEncrypt, ccmDecrypt, isValidPoint, generateKeyPair, keyPairFromScalar, ecdh, Sec2PointError,
    // key schedule
    LABELS, kdfInput, kdf, extract, keyHierarchy, kV1AtRest, commitment, codeRaw, codeFromRaw, formatCode,
    normalizeTypedCode, claimTranscript, authTranscript, wrapAad, WRAP_NONCE, sessionKeys, rotateTag,
    // wire
    OP, CLAIM_SUB, AUTH_SUB, KEY_SUB, UNCLAIM_GUARD, VERSION, BODY_LEN, SEC_ERR, SEC_ERR_NAME, REFUSAL,
    PLAINTEXT_SET, isPlaintextOpcode, FRAG_MAX_MIN, FRAG_MAX_MAX, STATE, STATE_NAME, STATUS_FLAG, DFLAG,
    parseSecStatus, parseSecError, Sec2Error, fragment, Reassembler,
    ClaimClient, AuthClient,
    // records
    CTR_MAX, H2D_OVERHEAD, D2H_OVERHEAD, recordNonce, sealH2d, sealD2h, openH2d, sealedPayloadBudget,
    ClientRecordLayer, classifyInbound, parseRefusal
  };
});
