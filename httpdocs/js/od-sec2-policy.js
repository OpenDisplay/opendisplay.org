/*
 * SEC2 config rules (SECURITY_V2.md § 10.2 - § 10.6, § 7.10.1), as pure functions over config
 * blobs in the CONFIG_WRITE wire form [hdr:2][version:1][packets...][crc16:2].
 *
 * The client uses:
 *   clientWriteCheck()   refuse a write before sending it: secrets to an unclaimed device
 *                        ("claim this device first"), a foreign 0x27 key on a claimed device,
 *                        a blob whose walk does not end at its CRC;
 *   leavesNoRecovery()   the § 7.10.1 warning (claimed, five-cycle reset off, no reset pin);
 *   showKeyRequested()   the SHOW_KEY_ON_SCREEN flag (restored in spec revision 5);
 *   explainConfigNack()  0x10 / 0x11 / BUSY ... -> a text key of od-texts.js.
 * The reference device of the tests uses deviceWriteVerdict() / deviceStoreAfterWrite() /
 * deviceReadView(), which the vectors V10 / V11 check byte for byte.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./od-sec2.js'));
  else root.OpenDisplaySec2Policy = factory(root.OpenDisplaySec2);
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  const PKT_WIFI = 0x26, PKT_SECURITY = 0x27, PKT_FINDMY = 0x2D;
  const SEC27_SIZE = 64;
  const SEC27 = Object.freeze({ ENABLED: 0, KEY: 1, TIMEOUT: 17, FLAGS: 19, RESET_PIN: 20, MARKER: 21 });
  const SEC27_MARKER_SEC2 = 0x02;
  const SEC_FLAG = Object.freeze({
    REWRITE_ALLOWED: 0x01,        // reserved on 3.0, written 0
    SHOW_KEY_ON_SCREEN: 0x02,     // reserved in rev 4; restored by rev 5 (the display draws its key)
    RESET_PIN_ENABLED: 0x04,
    RESET_PIN_POLARITY: 0x08,
    RESET_PIN_PULLUP: 0x10,
    RESET_PIN_PULLDOWN: 0x20,
    NO_RESET_PATTERN: 0x40        // provisional (§ 7.10.1, PROTOCOL_CHANGES_3.0 row 20)
  });
  const RESET_PIN_FLAGS = 0x3c;
  const ERR = Object.freeze({ WRITE_FAILED: 0x00, WRITE_BUSY: 0x01, SECRET_NEEDS_CLAIM: 0x10, KEY_MISMATCH: 0x11 });

  // Fixed body sizes of the legacy-range packets (ids < 0x80), incl. the burned 0x2E-0x31 drafts.
  const LEGACY_SIZES = Object.freeze({
    0x01: 22, 0x02: 22, 0x04: 30, 0x20: 46, 0x21: 22, 0x23: 30, 0x24: 30, 0x25: 30, 0x26: 160, 0x27: 64,
    0x28: 32, 0x29: 32, 0x2A: 32, 0x2B: 32, 0x2C: 32, 0x2D: 128, 0x2E: 157, 0x2F: 541, 0x30: 116, 0x31: 36
  });
  // (packet -> [offset, length] of each secret field), the closed list of § 10.4. 0x27 apart.
  const SECRET_FIELDS = Object.freeze({
    [PKT_WIFI]: [[32, 32]],                      // password[32]
    [PKT_FINDMY]: [[8, 32], [40, 28], [76, 20]]  // eik[32], net_a_adv_key[28], advertisement_key[20]
  });

  function crc16ccitt(buf) {
    let crc = 0xffff;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i] << 8;
      for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xffff) : ((crc << 1) & 0xffff);
    }
    return crc;
  }
  /** The outer CRC: over everything but the CRC, with the two length bytes zeroed. */
  function outerCrc(blob) {
    const b = Uint8Array.from(blob.subarray(0, blob.length - 2));
    b[0] = 0; b[1] = 0;
    return crc16ccitt(b);
  }
  function crcOk(blob) { return blob.length >= 5 && S.readU16le(blob, blob.length - 2) === outerCrc(blob); }

  /**
   * The loader's walk (§ 10.4 "one walk"): { ok, packets: [{number, type, body, offset}], error }.
   * ok only when the walk ends exactly at the CRC. An unknown legacy id cannot be stepped over.
   */
  function walk(blob) {
    const b = S.u8(blob);
    if (b.length < 5) return { ok: false, packets: [], error: 'config blob shorter than its wrapper' };
    const end = b.length - 2;
    const packets = [];
    let pos = 3;
    while (pos < end) {
      if (pos + 2 > end) return { ok: false, packets, error: 'dangling byte before the CRC' };
      const number = b[pos], type = b[pos + 1];
      pos += 2;
      let size;
      if (type >= 0x80) {
        if (pos + 2 > end) return { ok: false, packets, error: 'truncated length field' };
        size = S.readU16le(b, pos);
        pos += 2;
      } else {
        size = LEGACY_SIZES[type];
        if (size == null) return { ok: false, packets, error: 'unknown legacy packet 0x' + type.toString(16) + ' cannot be stepped over' };
      }
      if (pos + size > end) return { ok: false, packets, error: 'packet 0x' + type.toString(16) + ' runs past the end' };
      packets.push({ number, type, body: Uint8Array.from(b.subarray(pos, pos + size)), offset: pos });
      pos += size;
    }
    return { ok: true, packets, error: '' };
  }
  /** Re-emit packets with a fresh CRC. */
  function buildBlob(packets, { version = 1, header = Uint8Array.of(0, 0) } = {}) {
    const parts = [header, Uint8Array.of(version)];
    for (const p of packets) {
      parts.push(Uint8Array.of(p.number, p.type));
      if (p.type >= 0x80) parts.push(S.u16le(p.body.length));
      parts.push(p.body);
    }
    const body = S.concat(...parts);
    const out = S.concat(body, new Uint8Array(2));
    const crc = outerCrc(out);
    out[out.length - 2] = crc & 0xff; out[out.length - 1] = crc >>> 8;
    return out;
  }

  // ---- 0x27 ------------------------------------------------------------------------------
  function parseSec27(body) {
    const b = S.u8(body);
    if (b.length < SEC27_SIZE) return null;
    return {
      enabled: b[SEC27.ENABLED], key: Uint8Array.from(b.subarray(1, 17)), timeoutS: S.readU16le(b, SEC27.TIMEOUT),
      flags: b[SEC27.FLAGS], resetPin: b[SEC27.RESET_PIN], marker: b[SEC27.MARKER],
      resetPinEnabled: !!(b[SEC27.FLAGS] & SEC_FLAG.RESET_PIN_ENABLED),
      noResetPattern: !!(b[SEC27.FLAGS] & SEC_FLAG.NO_RESET_PATTERN),
      showKeyOnScreen: !!(b[SEC27.FLAGS] & SEC_FLAG.SHOW_KEY_ON_SCREEN)
    };
  }
  function isZero(b) { for (let i = 0; i < b.length; i++) if (b[i]) return false; return true; }
  function secretBytes(p) {
    const fields = SECRET_FIELDS[p.type];
    if (!fields) return null;
    return S.concat(...fields.map(([o, n]) => p.body.subarray(o, o + n)));
  }
  /**
   * Where a blob carries secrets (§ 10.4): every 0x26 / 0x2D instance with a non-zero secret
   * field, and every 0x27 with encryption_enabled != 0 or a non-zero key.
   */
  function scanSecrets(blob) {
    const w = walk(blob);
    const res = { walkOk: w.ok, error: w.error, wifi: 0, findmy: 0, sec27: [], secretPackets: [], hasSecret: false, packets: w.packets };
    for (const p of w.packets) {
      if (p.type === PKT_WIFI || p.type === PKT_FINDMY) {
        const s = secretBytes(p);
        if (!isZero(s)) {
          res.secretPackets.push({ type: p.type, secret: s });
          if (p.type === PKT_WIFI) res.wifi++; else res.findmy++;
        }
      } else if (p.type === PKT_SECURITY) {
        const s27 = parseSec27(p.body);
        if (s27) res.sec27.push(s27);
      }
    }
    res.sec27HasSecret = res.sec27.some(s => s.enabled !== 0 || !isZero(s.key));
    res.hasSecret = res.secretPackets.length > 0 || res.sec27HasSecret;
    return res;
  }
  /**
   * The device's verdict on a CONFIG_WRITE blob (§ 10.3, § 10.4):
   *   { accept: true } | { accept: false, err: 0x00 | 0x10 | 0x11, reason }.
   * opts: { claimed, kDev, legacySecrets, storedConfig } (storedConfig: for the LEGACY_SECRETS
   * identical-secret exception, § 10.4).
   */
  function deviceWriteVerdict(blob, opts = {}) {
    const sc = scanSecrets(blob);
    if (!sc.walkOk) return { accept: false, err: ERR.WRITE_FAILED, reason: sc.error };
    if (opts.claimed) {
      const kDev = opts.kDev ? S.u8(opts.kDev) : null;
      for (const s of sc.sec27) {
        if (!isZero(s.key) && !(kDev && S.equal(s.key, kDev))) return { accept: false, err: ERR.KEY_MISMATCH, reason: 'the 0x27 key field is neither zero nor the device key' };
      }
      return { accept: true };
    }
    if (sc.sec27HasSecret) return { accept: false, err: ERR.SECRET_NEEDS_CLAIM, reason: 'a key in 0x27 on an unclaimed device' };
    if (!sc.secretPackets.length) return { accept: true };
    if (opts.legacySecrets && opts.storedConfig) {
      const stored = scanSecrets(opts.storedConfig).secretPackets;
      const allKnown = sc.secretPackets.every(n => stored.some(o => o.type === n.type && S.equal(o.secret, n.secret)));
      if (allKnown) return { accept: true };
    } else if (opts.legacySecrets && opts.storedSecretPackets) {
      const stored = opts.storedSecretPackets.map(raw => {
        const r = S.u8(raw);
        return { type: r[1], secret: secretBytes({ type: r[1], body: r.subarray(2) }) };
      });
      const allKnown = sc.secretPackets.every(n => stored.some(o => o.type === n.type && S.equal(o.secret, n.secret)));
      if (allKnown) return { accept: true };
    }
    return { accept: false, err: ERR.SECRET_NEEDS_CLAIM, reason: 'a WiFi password or FindMy key on an unclaimed device' };
  }

  /**
   * Client-side check before a CONFIG_WRITE (§ 10.3 "a client MAY raise before sending").
   * opts: { sec2: bool (device speaks SEC2), claimed, kDev (the key in use, if any),
   *         legacySecrets, storedConfig }.
   * Returns { ok:true } or { ok:false, err, textKey, reason }. For a 2.x / v1 device (sec2 false)
   * nothing is refused here: the v1 rules are unchanged.
   */
  function clientWriteCheck(blob, opts = {}) {
    if (!opts.sec2) return { ok: true };
    const v = deviceWriteVerdict(blob, opts);
    if (v.accept) return { ok: true };
    const textKey = v.err === ERR.SECRET_NEEDS_CLAIM ? 'secrets_need_key' : v.err === ERR.KEY_MISMATCH ? 'key_mismatch' : 'config_malformed';
    return { ok: false, err: v.err, textKey, reason: v.reason };
  }
  /** A CONFIG_WRITE NACK [FF][41|42][err][..] -> { busy, textKey, message } (§ 10.4, PROTOCOL_CHANGES rows 14). */
  function explainConfigNack(frame) {
    const b = S.u8(frame);
    if (b.length < 3 || b[0] !== 0xff || (b[1] !== 0x41 && b[1] !== 0x42)) return null;
    switch (b[2]) {
      case ERR.SECRET_NEEDS_CLAIM: return { err: b[2], textKey: 'claim_first', busy: false };
      case ERR.KEY_MISMATCH: return { err: b[2], textKey: 'key_mismatch', busy: false };
      case ERR.WRITE_BUSY: return { err: b[2], textKey: 'config_busy', busy: true };
      case 0xfe: return { err: b[2], textKey: 'frame_too_long', busy: false };
      case 0xfd: return { err: b[2], textKey: 'claim_mode_refused', busy: false };
      default: return { err: b[2], textKey: 'config_write_failed', busy: false };
    }
  }

  // ---- § 7.10.1 lost-key recovery ---------------------------------------------------------
  /**
   * True when, after the write, a CLAIMED device keeps neither factory-reset trigger: the
   * five-cycle pattern is off (0x27 flags bit 6) and no reset pin is enabled. The stored reset
   * pin counts because it is sticky on a claimed device (§ 10.6). `written` / `stored` are 0x27
   * bodies (or parsed objects); `written` null means the write omits 0x27 (the stored one stays).
   */
  function leavesNoRecovery(written, stored) {
    const w = written ? (written.flags !== undefined ? written : parseSec27(written)) : null;
    const s = stored ? (stored.flags !== undefined ? stored : parseSec27(stored)) : null;
    const eff = w || s;
    if (!eff || !eff.noResetPattern) return false;
    return !(eff.resetPinEnabled || (s && s.resetPinEnabled));
  }
  /** The 0x27 of a blob (first instance), parsed, or null. */
  function sec27Of(blob) {
    const w = walk(blob);
    const p = w.packets.find(x => x.type === PKT_SECURITY);
    return p ? parseSec27(p.body) : null;
  }
  /** Does a write newly ask the display to draw its key (rev 5 SHOW_KEY_ON_SCREEN)? */
  function showKeyRequested(writtenBlob, storedBlob) {
    const w = sec27Of(writtenBlob);
    if (!w || !w.showKeyOnScreen) return false;
    const s = storedBlob ? sec27Of(storedBlob) : null;
    return !(s && s.showKeyOnScreen);
  }
  /** Set or clear one 0x27 flag bit in a body (returns a copy). */
  function withSec27Flag(body, bit, on) {
    const b = Uint8Array.from(S.u8(body));
    b[SEC27.FLAGS] = on ? (b[SEC27.FLAGS] | bit) : (b[SEC27.FLAGS] & ~bit);
    return b;
  }
  /**
   * § 10.3 "to restore a backup onto a different (or re-claimed) device": the copy of a blob
   * with every 0x27 key and encryption_enabled zeroed (and the SEC2 marker cleared).
   */
  function zeroKeyField(blob) {
    const w = walk(blob);
    if (!w.ok) throw new Error('config does not parse: ' + w.error);
    const b = S.u8(blob);
    const hdr = b.subarray(0, 2), version = b[2];
    const pk = w.packets.map(p => {
      if (p.type !== PKT_SECURITY) return p;
      const body = Uint8Array.from(p.body);
      body[SEC27.ENABLED] = 0; body.fill(0, 1, 17); body[SEC27.MARKER] = 0;
      return Object.assign({}, p, { body });
    });
    return buildBlob(pk, { version, header: hdr });
  }

  // ---- device side (reference device, vectors V11) ---------------------------------------
  /** 0x27 at rest on a claimed device (§ 10.2). */
  function sec27AtRest(body, { kV1 }) {
    const b = Uint8Array.from(S.u8(body));
    b[SEC27.ENABLED] = 1; b.set(S.u8(kV1), 1); b[SEC27.MARKER] = SEC27_MARKER_SEC2;
    return b;
  }
  /**
   * What a claimed device stores for an accepted write (§ 10.2, § 10.3, § 10.6).
   * opts: { kV1, storedConfig }. The stored 0x27 supplies the insertion and the sticky reset pin.
   */
  function deviceStoreAfterWrite(written, opts) {
    const w = walk(written);
    const st = walk(opts.storedConfig);
    const stored27 = st.packets.find(p => p.type === PKT_SECURITY);
    const b = S.u8(written);
    let packets = w.packets.map(p => Object.assign({}, p));
    const has27 = packets.some(p => p.type === PKT_SECURITY);
    if (!has27) {
      const ins = Object.assign({}, stored27);
      const at = packets.findIndex(p => p.type > PKT_SECURITY);
      if (at < 0) packets.push(ins); else packets.splice(at, 0, ins);
    } else {
      packets = packets.map(p => {
        if (p.type !== PKT_SECURITY) return p;
        let body = sec27AtRest(p.body, opts);
        const s = stored27 ? parseSec27(stored27.body) : null;
        if (s && s.resetPinEnabled && !(body[SEC27.FLAGS] & SEC_FLAG.RESET_PIN_ENABLED)) {
          body[SEC27.FLAGS] = (body[SEC27.FLAGS] & ~RESET_PIN_FLAGS) | (s.flags & RESET_PIN_FLAGS);
          body[SEC27.RESET_PIN] = s.resetPin;
        }
        return Object.assign({}, p, { body });
      });
    }
    return buildBlob(packets, { version: b[2], header: b.subarray(0, 2) });
  }
  /** What an unclaimed device stores: a non-zero marker is stored as 0; the CRC is rewritten only if it was valid. */
  function deviceStoreUnclaimed(written) {
    const b = Uint8Array.from(S.u8(written));
    const w = walk(b);
    const wasValid = crcOk(b);
    let changed = false;
    for (const p of w.packets) {
      if (p.type === PKT_SECURITY && b[p.offset + SEC27.MARKER] !== 0) { b[p.offset + SEC27.MARKER] = 0; changed = true; }
    }
    if (changed && wasValid) { const c = outerCrc(b); b[b.length - 2] = c & 0xff; b[b.length - 1] = c >>> 8; }
    return b;
  }
  /** The read view of a claimed device (§ 10.2): 0x27 substituted in place, the STORED CRC kept. */
  function deviceReadView(stored, { kDev }) {
    const b = Uint8Array.from(S.u8(stored));
    for (const p of walk(b).packets) {
      if (p.type !== PKT_SECURITY) continue;
      b[p.offset + SEC27.ENABLED] = 1;
      b.set(S.u8(kDev), p.offset + 1);
      b[p.offset + SEC27.MARKER] = 0;
    }
    return b;
  }
  /** CONFIG_CLEAR on a claimed device: a config holding only the stored 0x27 at rest (§ 10.6). */
  function deviceConfigClear(stored) {
    const b = S.u8(stored);
    const p27 = walk(b).packets.find(p => p.type === PKT_SECURITY);
    return buildBlob(p27 ? [p27] : [], { version: b[2], header: b.subarray(0, 2) });
  }
  /** UNCLAIM's scrub (§ 10.4): secrets zeroed, 0x27 to the unclaimed form, the rest kept. */
  function deviceUnclaimScrub(stored) {
    const b = S.u8(stored);
    const pk = walk(b).packets.map(p => {
      const body = Uint8Array.from(p.body);
      if (p.type === PKT_WIFI || p.type === PKT_FINDMY) for (const [o, n] of SECRET_FIELDS[p.type]) body.fill(0, o, o + n);
      if (p.type === PKT_SECURITY) { body[SEC27.ENABLED] = 0; body.fill(0, 1, 17); body[SEC27.MARKER] = 0; }
      return Object.assign({}, p, { body });
    });
    return buildBlob(pk, { version: b[2], header: b.subarray(0, 2) });
  }

  return {
    PKT_WIFI, PKT_SECURITY, PKT_FINDMY, SEC27, SEC27_SIZE, SEC_FLAG, RESET_PIN_FLAGS, ERR, LEGACY_SIZES, SECRET_FIELDS,
    crc16ccitt, outerCrc, crcOk, walk, buildBlob, parseSec27, scanSecrets, deviceWriteVerdict, clientWriteCheck,
    explainConfigNack, leavesNoRecovery, sec27Of, showKeyRequested, withSec27Flag, zeroKeyField,
    sec27AtRest, deviceStoreAfterWrite, deviceStoreUnclaimed, deviceReadView, deviceConfigClear, deviceUnclaimScrub
  };
});
