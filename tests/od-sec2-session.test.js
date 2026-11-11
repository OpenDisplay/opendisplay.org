// The session driver against the reference device (tests/helpers/sec2-refdevice.js): selection
// and pinning, auth with several keys, claim (typed code, no panel, blank panel, display seen),
// rotation (store before confirm), unclaim, sealed requests, oversize and FE handling, config
// read-back and the client-side secret refusal. Host-tested only: no Bluetooth here.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../httpdocs/js/od-sec2.js');
const P = require('../httpdocs/js/od-sec2-policy.js');
const KS = require('../httpdocs/js/od-keystore.js');
const { Sec2Session, Sec2SessionError, secretsNeedKey, frameLimit } = require('../httpdocs/js/od-sec2-session.js');
const { RefDevice, RefTransport } = require('./helpers/sec2-refdevice.js');

const NAME = 'OD1A2B3C';
const UID = S.hexToBytes('0102030405060708');
const noSleep = async () => {};
function rig(devOpts = {}, { storage = KS.memoryStorage(), persisted = async () => true } = {}) {
  const dev = new RefDevice(Object.assign({ uid: UID }, devOpts));
  const tr = new RefTransport(dev);
  const store = new KS.KeyStore({ storage, persisted });
  const s = new Sec2Session({ transport: tr, keyStore: store, name: NAME, sleep: noSleep });
  return { dev, tr, store, s, storage };
}
function reconnect(r) {
  r.dev.disconnect();
  r.tr = new RefTransport(r.dev);
  r.s = new Sec2Session({ transport: r.tr, keyStore: r.store, name: NAME, sleep: noSleep });
  return r;
}
const typed = code => async ({ display }) => code === 'right' ? display : code;
const ack = yes => async () => yes;

// A minimal valid config: 0x01 system packet and the CRC (P.buildBlob computes it).
function cfg(packets) { return P.buildBlob(packets); }
function sec27(key, flags = 0) {
  const b = new Uint8Array(64); b[0] = 1; b.set(S.u8(key), 1); b[19] = flags; return b;
}
function wifi() { const b = new Uint8Array(P.LEGACY_SIZES[0x26]); b[0] = 0x41; b.set([0x70, 0x77], 32); return b; }  // ssid "A", password "pw"

test('selection: firmware 2.x -> v1; 3.x with SEC_STATUS -> SEC2 and pinned; pinned + silence -> refuse', async () => {
  const old = rig({ fw: [2, 7, 0] });
  old.dev.handlers = {};
  old.dev._plaintext = async (cmd) => (cmd === 0x0043 ? [Uint8Array.of(0x00, 0x43, 2, 7, 0, 0)] : []);
  assert.equal((await old.s.select()).mode, 'v1');
  assert.equal(old.store.isPinned(NAME), false);

  const r = rig({ claimMode: 'fresh' });
  const sel = await r.s.select();
  assert.equal(sel.mode, 'sec2'); assert.equal(sel.fw.major, 3);
  assert.equal(r.store.isPinned(NAME), true);
  // The same name later stops answering SEC_STATUS (a v1 impostor, or a 2.x reflash): refused.
  const fake = new RefTransport({ receive: async f => (f[1] === 0x43 ? [Uint8Array.of(0x00, 0x43, 2, 7, 0, 0)] : []), closed: false });
  const s2 = new Sec2Session({ transport: fake, keyStore: r.store, name: NAME, sleep: noSleep });
  await assert.rejects(s2.select(), e => e.code === 'downgrade_refused' && e.textKey === 'seen_on_sec2');
});

test('claim with the typed code, then a sealed config read-back', async () => {
  const blob = cfg([{ type: 0x01, body: new Uint8Array(22) }]);
  const r = rig({ claimMode: 'fresh', config: blob });
  await r.s.select();
  let shown = null;
  const res = await r.s.claim({ askCode: async ({ display }) => { shown = display; return display.replace(' ', ''); }, acknowledge: ack(false) });
  assert.match(shown, /^\d{3} \d{3}$/);
  assert.equal(res.codeChecked, true);
  assert.equal(S.bytesToHex(r.dev.kDev), res.key);
  assert.equal(r.store.get(NAME).confirmed, res.key);
  assert.equal(r.store.displaySeen(NAME), true);
  assert.ok(r.s.hasSession);
  const back = await r.s.readConfig();
  assert.equal(S.bytesToHex(back), S.bytesToHex(blob));
  // Everything after the claim went sealed.
  const after = r.tr.sent.slice(r.tr.sent.findIndex(f => f[1] === 0x55 && f[2] === 3) + 1);
  assert.ok(after.length >= 1 && after.every(f => f[0] === 0x00 && f[1] === 0x40 && f.length >= S.H2D_OVERHEAD));
});

test('claim: a wrong code aborts, nothing is stored, the device stays unclaimed', async () => {
  const r = rig({ claimMode: 'fresh' });
  await r.s.select();
  await assert.rejects(r.s.claim({ askCode: async () => '000000x', acknowledge: ack(true) }), e => e.code === 'code_mismatch');
  await assert.rejects(rig({ claimMode: 'fresh' }).s.claim({ askCode: async ({ display }) => String((Number(display.replace(' ', '')) + 1) % 1e6).padStart(6, '0'), acknowledge: ack(true) }),
    e => e.textKey === 'code_mismatch');
  assert.equal(r.dev.claimed, false);
  assert.equal(r.store.hasAnyKey(NAME), false);
  assert.ok(r.tr.sent.some(f => f[1] === 0x55 && f[2] === S.CLAIM_SUB.ABORT));
});

test('claim: no panel needs the acknowledgement; refused when this browser saw a panel before', async () => {
  const r = rig({ claimMode: 'fresh', dflags: 0 });
  await r.s.select();
  let asked = null;
  await assert.rejects(r.s.claim({ askCode: async () => { throw new Error('must not ask'); }, acknowledge: async k => { asked = k; return false; } }),
    e => e.code === 'cancelled');
  assert.equal(asked, 'no_panel');
  assert.equal(r.dev.claimed, false);
  const ok = await r.s.claim({ askCode: async () => { throw new Error('must not ask'); }, acknowledge: ack(true) });
  assert.equal(ok.codeChecked, false);
  assert.equal(r.store.displaySeen(NAME), false);

  const seen = rig({ claimMode: 'fresh', dflags: 0 });
  seen.store.setDisplaySeen(NAME);
  await assert.rejects(seen.s.claim({ askCode: async () => '1', acknowledge: ack(true) }), e => e.textKey === 'display_seen');
  assert.equal(seen.dev.claimed, false);
});

test('claim: a blank panel is the user\'s acknowledgement path', async () => {
  const r = rig({ claimMode: 'fresh' });
  let asked = null;
  const res = await r.s.claim({ askCode: async () => ({ blank: true }), acknowledge: async k => { asked = k; return true; } });
  assert.equal(asked, 'blank_panel'); assert.equal(res.codeChecked, false); assert.equal(r.dev.claimed, true);
  assert.equal(r.store.displaySeen(NAME), false);
});

test('claim: NOT_IN_CLAIM_MODE gives the two-cycle text; non-durable storage refuses before BEGIN', async () => {
  const r = rig({});
  await assert.rejects(r.s.claim({ askCode: typed('right'), acknowledge: ack(true) }), e => e.textKey === 'not_in_claim_mode');
  const broken = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); }, removeItem: () => {} };
  const nd = rig({ claimMode: 'fresh' }, { storage: broken });
  await assert.rejects(nd.s.claim({ askCode: typed('right'), acknowledge: ack(true) }), e => e.textKey === 'storage_not_durable');
  assert.ok(!nd.tr.sent.some(f => f[1] === 0x55), 'nothing sent');
  // The device itself refuses BEGIN outside claim mode with 0x04.
  const t = rig({});
  t.s.status = S.parseSecStatus(Uint8Array.from([...t.dev.status().slice(0, 4), 0x01, ...t.dev.status().slice(5)]));
  t.s.readStatus = async () => t.s.status;
  await assert.rejects(t.s.claim({ askCode: typed('right'), acknowledge: ack(true) }), e => e.code === 'not_in_claim_mode');
});

test('claim: beforeOnlyKey sees persisted=false and can abort; the staged key stays a candidate', async () => {
  const r = rig({ claimMode: 'fresh' }, { persisted: async () => false });
  let info = null;
  await assert.rejects(r.s.claim({ askCode: async ({ display }) => display, acknowledge: ack(true),
    beforeOnlyKey: async i => { info = i; return false; } }), e => e.code === 'cancelled');
  assert.equal(info.persisted, false); assert.equal(info.kind, 'claim');
  assert.equal(r.dev.claimed, false);
  assert.equal(r.store.get(NAME).candidates[0].source, 'pending-claim');
});

test('claim: CONFIRM sent but no reply -> claim_unconfirmed, the key is kept and opens the next session', async () => {
  const r = rig({ claimMode: 'fresh' });
  const orig = r.tr.send.bind(r.tr);
  r.tr.send = async f => { await orig(f); if (f[1] === 0x55 && f[2] === S.CLAIM_SUB.CONFIRM) r.tr.drain(); };
  await assert.rejects(r.s.claim({ askCode: async ({ display }) => display, acknowledge: ack(true) }), e => e.code === 'claim_unconfirmed');
  assert.equal(r.dev.claimed, true);
  assert.equal(r.store.get(NAME).confirmed, null);
  assert.equal(r.store.keysToTry(NAME).length, 1);
  reconnect(r);
  await r.s.select();
  const a = await r.s.authenticate();
  assert.equal(a.key, S.bytesToHex(r.dev.kDev));
  assert.equal(r.store.get(NAME).confirmed, a.key);
});

test('auth: up to three keys, wrong keys are never deleted before a success, the right one is promoted', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const r = rig({ kDev });
  r.store.addCandidate(NAME, new Uint8Array(16).fill(1), 'user');
  r.store.addCandidate(NAME, kDev, 'link');
  await r.s.select();
  const a = await r.s.authenticate();
  assert.equal(a.key, S.bytesToHex(kDev));
  assert.deepEqual(r.store.get(NAME).candidates, []);
  // Only wrong keys: not authorised, and they are all still there.
  const w = rig({ kDev });
  for (const b of [1, 2, 3, 4]) w.store.addCandidate(NAME, new Uint8Array(16).fill(b), 'user');
  await w.s.select();
  await assert.rejects(w.s.authenticate(), e => e.code === 'not_authorised' && e.textKey === 'not_authorised');
  assert.equal(w.store.get(NAME).candidates.length, 4);
  assert.equal(w.tr.sent.filter(f => f[1] === 0x56 && f[2] === 1 && f[3] === 0).length, 3, 'three HELLOs at most');
});

test('auth: BUSY backs off and retries; a 2.x key from the old store is a candidate', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const storage = KS.memoryStorage();
  storage.setItem(KS.V1_STORE_KEY, JSON.stringify({ [NAME]: S.bytesToHex(kDev) }));
  const r = rig({ kDev, origin: 'LEGACY' }, { storage });
  let busy = 2;
  const orig = r.dev._auth.bind(r.dev);
  r.dev._auth = async (sub, body) => { if (sub === 1 && busy-- > 0) return r.dev._err(0x56, 1, S.SEC_ERR.BUSY); return orig(sub, body); };
  const slept = [];
  r.s.sleep = async ms => { slept.push(ms); };
  await r.s.select();
  const a = await r.s.authenticate();
  assert.equal(a.keyLegacy, true); assert.equal(slept.length, 2);
  assert.equal(JSON.parse(storage.getItem(KS.V1_STORE_KEY))[NAME], S.bytesToHex(kDev), '2.x store untouched');
});

test('rotation: the new key is stored before ROTATE_CONFIRM; the old key stays a candidate until the new one authenticated', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const r = rig({ kDev, origin: 'LEGACY' });
  r.store.addCandidate(NAME, kDev);
  await r.s.select();
  await r.s.authenticate();
  assert.equal(r.s.rotationWanted(), true);
  let stagedBeforeConfirm = false;
  const orig = r.tr.send.bind(r.tr);
  r.tr.send = async f => {
    if (r.s.rl && f[0] === 0x00 && f[1] === 0x57 && r.store.get(NAME).candidates.some(c => c.source === 'pending-rotate')) stagedBeforeConfirm = true;
    return orig(f);
  };
  const res = await r.s.rotate();
  assert.ok(stagedBeforeConfirm);
  assert.equal(S.bytesToHex(r.dev.kDev), res.key);
  // After the ACK: nothing confirmed, the new key first, the old one kept as 'pre-rotation'.
  const mid = r.store.get(NAME);
  assert.equal(mid.confirmed, null);
  assert.deepEqual(r.store.keysToTry(NAME), [res.key, S.bytesToHex(kDev)]);
  assert.equal(mid.candidates[1].source, 'pre-rotation');
  assert.equal(r.s.hasSession, false);
  await r.s.readStatus();
  const again = await r.s.authenticate();
  assert.equal(again.key, res.key); assert.equal(again.keyLegacy, false);
  // The new key's first session confirms it; only now is the old key dropped.
  assert.equal(r.store.get(NAME).confirmed, res.key);
  assert.deepEqual(r.store.get(NAME).candidates, []);
});

test('rotation: opt-out, refused confirm and a lost ACK keep the old key usable', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const r = rig({ kDev, origin: 'LEGACY' });
  r.store.addCandidate(NAME, kDev);
  r.store.setNoRotate(NAME, true);
  await r.s.select(); await r.s.authenticate();
  assert.equal(r.s.rotationWanted(), false);

  const f = rig({ kDev, origin: 'LEGACY' });
  f.dev.failRotatePersist = true;
  f.store.addCandidate(NAME, kDev);
  await f.s.select(); await f.s.authenticate();
  await assert.rejects(f.s.rotate(), e => e.code === 'rotate_refused');
  assert.equal(f.store.get(NAME).confirmed, S.bytesToHex(kDev));
  assert.deepEqual(f.store.keysToTry(NAME).slice(0, 2).sort(), [S.bytesToHex(kDev), f.store.get(NAME).candidates[0].key].sort());

  const l = rig({ kDev, origin: 'LEGACY' });
  l.store.addCandidate(NAME, kDev);
  await l.s.select(); await l.s.authenticate();
  const orig = l.tr.send.bind(l.tr);
  l.tr.send = async fr => { await orig(fr); if (fr[0] === 0x00 && fr[1] === 0x57 && fr.length === 2 + 4 + 17 + 12) l.tr.drain(); };
  await assert.rejects(l.s.rotate(), e => e.code === 'rotation_unconfirmed');
  // The device did rotate; the staged key opens the next session.
  reconnect(l);
  await l.s.select();
  assert.equal((await l.s.authenticate()).key, S.bytesToHex(l.dev.kDev));
});

test('the global opt-out "Do not replace keys carried over from firmware 2.x" applies to every device', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const r = rig({ kDev, origin: 'LEGACY' });
  r.store.addCandidate(NAME, kDev);
  r.store.setNoRotateAll(true);
  assert.equal(r.store.noRotateFor('ODFFFFFF'), true, 'also for a device never seen before');
  await r.s.select(); await r.s.authenticate();
  assert.equal(r.s.rotationWanted(), false);
  r.store.setNoRotateAll(false);
  assert.equal(r.s.rotationWanted(), true);
  const t = new KS.KeyStore({ storage: r.storage });
  assert.equal(t.noRotateAll(), false);
  r.store.setNoRotateAll(true);
  assert.equal(new KS.KeyStore({ storage: r.storage }).noRotateAll(), true, 'persists');
});

test('automatic rotation needs a store the browser keeps: private window / evictable -> skipped', async () => {
  const blocked = new KS.KeyStore({ storage: { getItem: () => null, setItem: () => { throw new Error('denied'); }, removeItem() {} }, persisted: async () => true });
  assert.equal(await blocked.keepsKeys(), false);
  const evictable = new KS.KeyStore({ storage: KS.memoryStorage(), persisted: async () => false, persist: async () => false });
  assert.equal(await evictable.keepsKeys(), false);
  const granted = new KS.KeyStore({ storage: KS.memoryStorage(), persisted: async () => false, persist: async () => true });
  assert.equal(await granted.keepsKeys(), true);
  const kept = new KS.KeyStore({ storage: KS.memoryStorage(), persisted: async () => true });
  assert.equal(await kept.keepsKeys(), true);
});

test('frame limit: min(MTU - 3, 244) on every target; frag_max 20..limit; sealed frames are refused, never split', async () => {
  assert.equal(frameLimit(null), 244);
  assert.equal(frameLimit(247), 244);
  assert.equal(frameLimit(256), 244);
  assert.equal(frameLimit(517), 244);
  assert.equal(frameLimit(185), 182);
  const tr = new RefTransport(new RefDevice({ uid: UID }));
  assert.equal(new Sec2Session({ transport: tr, maxFrame: 300 }).maxFrame, 244);
  assert.equal(new Sec2Session({ transport: tr, mtu: 185 }).maxFrame, 182);
  assert.equal(new Sec2Session({ transport: tr, mtu: 185, fragMax: 244 }).fragMax, 182);
  assert.equal(new Sec2Session({ transport: tr, fragMax: 5 }).fragMax, 20);
  // The HELLO declares the session's frag_max, and no handshake frame exceeds it.
  const kDev = new Uint8Array(16).fill(0x42);
  for (const fragMax of [20, 182]) {
    const dev = new RefDevice({ uid: UID, kDev });
    const t = new RefTransport(dev);
    const store = new KS.KeyStore({ storage: KS.memoryStorage(), persisted: async () => true });
    store.addCandidate(NAME, kDev);
    const s = new Sec2Session({ transport: t, keyStore: store, name: NAME, sleep: noSleep, mtu: 185, fragMax });
    await s.select(); await s.authenticate();
    const hello = t.sent.find(f => f[0] === 0x00 && f[1] === 0x56 && f[2] === 0x01 && (f[3] & 0x7f) === 0);
    assert.ok(hello, 'HELLO sent');
    assert.equal(hello[5], fragMax);   // [00][56][sub][frag][ver][frag_max]
    assert.ok(t.sent.filter(f => f[1] === 0x56).every(f => f.length <= fragMax));
    // A sealed request one byte over the 182 B limit is refused before anything is sent.
    const n = t.sent.length;
    await assert.rejects(s.request(S.concat(Uint8Array.of(0x00, 0x30), new Uint8Array(182 - 18 + 1))), e => e.code === 'frame_too_long');
    assert.equal(t.sent.length, n);
  }
});

test('rotation is refused when the browser cannot store the key', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const r = rig({ kDev, origin: 'LEGACY' });
  r.store.addCandidate(NAME, kDev);
  await r.s.select(); await r.s.authenticate();
  r.store.storage.setItem = () => { throw new Error('quota'); };
  await assert.rejects(r.s.rotate(), e => e.textKey === 'storage_not_durable');
  assert.equal(S.bytesToHex(r.dev.kDev), S.bytesToHex(kDev));
});

test('unclaim: keys are dropped only after the sealed ACK; the pin stays', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const r = rig({ kDev });
  r.store.addCandidate(NAME, kDev);
  await r.s.select(); await r.s.authenticate();
  await r.s.unclaim();
  assert.equal(r.dev.claimed, false);
  assert.equal(r.store.hasAnyKey(NAME), false);
  assert.equal(r.store.isPinned(NAME), true);
});

test('sealed requests: chunk sizes come from the limit minus the seal overhead; oversize fails at once', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const r = rig({ kDev });
  r.store.addCandidate(NAME, kDev);
  await r.s.select(); await r.s.authenticate();
  assert.equal(r.s.payloadBudget(), 244 - 18);
  assert.deepEqual(r.s.configChunkSizes(), { first: 198, next: 200 });
  // Too big for one sealed frame: refused before sending.
  const n = r.tr.sent.length;
  await assert.rejects(r.s.request(S.concat(Uint8Array.of(0x00, 0x30), new Uint8Array(227))), e => e.code === 'frame_too_long');
  assert.equal(r.tr.sent.length, n);
  // A device with a smaller limit answers the sealed refusal; it is an error at once, no wait.
  r.dev.maxFrame = 100;
  await assert.rejects(r.s.request(S.concat(Uint8Array.of(0x00, 0x30), new Uint8Array(150))), e => e.code === 'frame_too_long' && /sealed/.test(e.message));
  // ...and the plaintext form, on an unclaimed device.
  const u = rig({ maxFrame: 50 });
  await u.s.select();
  await assert.rejects(u.s.request(S.concat(Uint8Array.of(0x00, 0x30), new Uint8Array(60)), { timeoutMs: 1 }), e => e.code === 'frame_too_long');
});

test('FE: a claimed device without a session -> "not authorised"; at most two gated commands are sent', async () => {
  const r = rig({ kDev: new Uint8Array(16).fill(0x42) });
  await r.s.select();
  await assert.rejects(r.s.request(Uint8Array.of(0x00, 0x40)), e => e.code === 'needs_session' && e.textKey === 'not_authorised');
  await assert.rejects(r.s.request(Uint8Array.of(0x00, 0x40)), e => e.textKey === 'not_authorised');
  const before = r.tr.sent.length;
  await assert.rejects(r.s.request(Uint8Array.of(0x00, 0x40)), e => e.code === 'not_authorised');
  assert.equal(r.tr.sent.length, before, 'third gated command not sent');
  assert.equal(r.dev.closed, false, 'the device never reached its abuse limit');
});

test('session gone mid-way: an idempotent request re-authenticates once', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const blob = cfg([{ type: 0x01, body: new Uint8Array(22) }]);
  const r = rig({ kDev, config: blob });
  r.store.addCandidate(NAME, kDev);
  await r.s.select(); await r.s.authenticate();
  r.dev.session = null;  // the device dropped the session (reboot, timeout)
  const back = await r.s.readConfig();
  assert.ok(back.length > 0);
  r.dev.session = null;
  await assert.rejects(r.s.request(Uint8Array.of(0x00, 0x30)), e => e.code === 'session_gone');
});

test('secrets need a key: refused client-side on an unclaimed SEC2 device, mapped NACKs on a claimed one', async () => {
  const withWifi = cfg([{ type: 0x01, body: new Uint8Array(22) }, { type: 0x26, body: wifi() }]);
  assert.equal(secretsNeedKey(withWifi, { sec2: true, claimed: false }), true);
  assert.equal(secretsNeedKey(withWifi, { sec2: false, claimed: false }), false, '2.x devices are not refused');
  const u = rig({});
  await u.s.select();
  await assert.rejects(u.s.writeConfig(withWifi), e => e.textKey === 'secrets_need_key');
  assert.ok(!u.tr.sent.some(f => f[1] === 0x41), 'nothing sent');

  const kDev = new Uint8Array(16).fill(0x42);
  const c = rig({ kDev });
  c.store.addCandidate(NAME, kDev);
  await c.s.select(); await c.s.authenticate();
  assert.equal(await c.s.writeConfig(withWifi), true);
  const other = cfg([{ type: 0x01, body: new Uint8Array(22) }, { type: 0x27, body: sec27(new Uint8Array(16).fill(9)) }]);
  await assert.rejects(c.s.writeConfig(other), e => e.textKey === 'key_mismatch');
  // The device's own NACK is mapped too (the client check bypassed).
  c.dev.handlers[0x0041] = () => Uint8Array.of(0xff, 0x41, 0x01, 0x00);
  await assert.rejects(c.s.writeConfig(withWifi), e => e.textKey === 'config_busy' && e.busy === true);
  c.dev.handlers[0x0041] = () => Uint8Array.of(0xff, 0x41, 0x10, 0x00);
  await assert.rejects(c.s.writeConfig(withWifi), e => e.textKey === 'claim_first');
});

test('a large config goes out in sealed chunks that fit the frame', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const big = cfg([{ type: 0x01, body: new Uint8Array(22) }, { type: 0xb2, body: new Uint8Array(900) }]);
  const r = rig({ kDev });
  r.store.addCandidate(NAME, kDev);
  let got = [];
  r.dev.handlers[0x0041] = p => { got = [p]; return Uint8Array.of(0x00, 0x41); };
  r.dev.handlers[0x0042] = p => { got.push(p); return Uint8Array.of(0x00, 0x42); };
  await r.s.select(); await r.s.authenticate();
  await r.s.writeConfig(big);
  const sealed = r.tr.sent.filter(f => f[0] === 0x00 && (f[1] === 0x41 || f[1] === 0x42));
  assert.ok(sealed.length >= 5);
  assert.ok(sealed.every(f => f.length <= 244));
  assert.equal(S.readU16le(got[0], 0), big.length);
  assert.equal(S.bytesToHex(S.concat(got[0].subarray(2), ...got.slice(1))), S.bytesToHex(big));
});

test('READ_MSD and READ_IDENT work without a session on a claimed device', async () => {
  const r = rig({ kDev: new Uint8Array(16).fill(0x42) });
  await r.s.select();
  assert.equal((await r.s.readMsd()).length, 16);
  assert.equal((await r.s.readIdent())[1], 0x46);
});

test('Sec2SessionError carries a text key', () => {
  const e = new Sec2SessionError('x', 'claim_first', 'm');
  assert.equal(e.textKey, 'claim_first'); assert.ok(e instanceof Error);
});
