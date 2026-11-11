// Vectors V10 (secret detection, the write verdicts) and V11 (0x27 at rest and the read view)
// against httpdocs/js/od-sec2-policy.js, plus the client-side checks built on them.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../httpdocs/js/od-sec2.js');
const P = require('../httpdocs/js/od-sec2-policy.js');

const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sec2_vectors.json'), 'utf8'));
const h = S.hexToBytes, hex = S.bytesToHex;
let n10 = 0, n11 = 0;

test('V10 secret detection and the device verdict, byte-exact NACK frames', () => {
  for (const c of V.V10_secrets) {
    const claimed = c.device === 'claimed';
    const legacySecrets = c.device.includes('LEGACY_SECRETS');
    let blob = h(c.blob);
    if (c.frames) {
      // Chunked write: [00][41][total:2 LE][chunk] then [00][42][chunk]...; the verdict is at the last chunk.
      const first = h(c.frames[0]);
      assert.equal(S.readU16le(first, 2), blob.length);
      const parts = [first.subarray(4), ...c.frames.slice(1).map(f => h(f).subarray(2))];
      assert.equal(hex(S.concat(...parts)), c.blob);
    }
    const v = P.deviceWriteVerdict(blob, { claimed, kDev: c.k_dev ? h(c.k_dev) : null, legacySecrets,
      storedSecretPackets: c.stored_secret_packets });
    const want = c.verdict === 'accept' ? null : parseInt(c.verdict, 16);
    assert.equal(v.accept, want === null, c.case + ': ' + (v.reason || ''));
    if (want !== null) {
      assert.equal(v.err, want, c.case);
      const frame = hex(Uint8Array.of(0xff, c.frames ? 0x42 : 0x41, v.err, 0x00));
      assert.equal(frame, c.frames ? c.nack_last_chunk : c.nack_single, c.case);
    }
    // The client refuses exactly what the device would refuse, before anything is sent.
    const cc = P.clientWriteCheck(blob, { sec2: true, claimed, kDev: c.k_dev ? h(c.k_dev) : null, legacySecrets,
      storedSecretPackets: c.stored_secret_packets });
    assert.equal(cc.ok, want === null, c.case);
    if (want === 0x10) assert.equal(cc.textKey, 'secrets_need_key');
    n10++;
  }
});

test('V11 0x27 at rest, the sticky reset pin, CONFIG_CLEAR, UNCLAIM and the read view', async () => {
  for (const c of V.V11_config_at_rest) {
    if (c.client_no_recovery_warning !== undefined) {
      assert.equal(P.leavesNoRecovery(h(c.written_0x27), h(c.stored_0x27)), c.client_no_recovery_warning, c.case);
      n11++;
      continue;
    }
    const kDev = c.k_dev ? h(c.k_dev) : null;
    const uid = c.uid ? h(c.uid) : null;
    if (c.case.startsWith('claimed: write')) {
      const kV1 = await S.kV1AtRest(kDev, uid, false);
      assert.equal(P.deviceWriteVerdict(h(c.written), { claimed: true, kDev }).accept, true, c.case);
      const after = P.deviceStoreAfterWrite(h(c.written), { kV1, storedConfig: h(c.stored_before) });
      assert.equal(hex(after), c.stored_after, c.case);
      assert.ok(P.crcOk(after), c.case + ': stored CRC');
    } else if (c.case.startsWith('claimed: CONFIG_CLEAR')) {
      assert.equal(hex(P.deviceConfigClear(h(c.stored_before))), c.stored_after, c.case);
    } else if (c.case.startsWith('unclaimed: a written')) {
      assert.equal(P.deviceWriteVerdict(h(c.written), { claimed: false }).accept, true);
      assert.equal(hex(P.deviceStoreUnclaimed(h(c.written))), c.stored_after, c.case);
      assert.equal(c.reply, '0041');
    } else if (c.case.startsWith('UNCLAIM')) {
      assert.equal(hex(P.deviceUnclaimScrub(h(c.stored_before))), c.stored_after, c.case);
    }
    if (c.read_image_frame) {
      const stored = h(c.stored_after || c.stored);
      const claimedView = !c.case.startsWith('unclaimed') && !c.case.startsWith('UNCLAIM');
      const view = claimedView ? P.deviceReadView(stored, { kDev: kDev || h('000102030405060708090a0b0c0d0e0f') }) : stored;
      assert.equal(hex(S.concat(h('00400000'), S.u16le(view.length), view)), c.read_image_frame, c.case);
    }
    n11++;
  }
});

test('the read view of a claimed device carries K_dev; the client verifies a round-trip write is accepted', async () => {
  const c = V.V11_config_at_rest.find(x => x.case.includes('carries the STORED CRC'));
  const kDev = h('000102030405060708090a0b0c0d0e0f');
  const view = P.deviceReadView(h(c.stored), { kDev });
  const s27 = P.sec27Of(view);
  assert.equal(hex(s27.key), hex(kDev));
  assert.equal(s27.marker, 0);
  // read -> edit -> write round-trips exactly (§ 10.3: an equal key is accepted).
  assert.ok(P.clientWriteCheck(view, { sec2: true, claimed: true, kDev }).ok);
  // ...but not onto another claimed device.
  const other = P.clientWriteCheck(view, { sec2: true, claimed: true, kDev: new Uint8Array(16).fill(9) });
  assert.equal(other.err, 0x11);
  // zeroKeyField makes it writable anywhere.
  const z = P.zeroKeyField(view);
  assert.ok(P.crcOk(z));
  assert.ok(P.clientWriteCheck(z, { sec2: true, claimed: true, kDev: new Uint8Array(16).fill(9) }).ok);
  assert.ok(P.clientWriteCheck(z, { sec2: true, claimed: false }).ok);
});

test('v1 / 2.x devices are never refused client-side', () => {
  const c = V.V10_secrets.find(x => x.verdict === '0x10');
  assert.ok(P.clientWriteCheck(h(c.blob), { sec2: false }).ok);
});

test('no-recovery rule: pattern off and no pin warns; a stored (sticky) pin or a written pin does not', () => {
  const base = new Uint8Array(64);
  const off = P.withSec27Flag(base, P.SEC_FLAG.NO_RESET_PATTERN, true);
  assert.equal(P.leavesNoRecovery(off, null), true);
  assert.equal(P.leavesNoRecovery(off, base), true);
  const pinStored = P.withSec27Flag(base, P.SEC_FLAG.RESET_PIN_ENABLED, true);
  assert.equal(P.leavesNoRecovery(off, pinStored), false);
  assert.equal(P.leavesNoRecovery(P.withSec27Flag(off, P.SEC_FLAG.RESET_PIN_ENABLED, true), base), false);
  assert.equal(P.leavesNoRecovery(base, base), false);
  // The write omits 0x27: the stored one decides.
  assert.equal(P.leavesNoRecovery(null, off), true);
});

test('SHOW_KEY_ON_SCREEN: only a newly set bit asks for the confirmation', () => {
  const v = V.V11_config_at_rest.find(x => x.case.includes('carries the STORED CRC'));
  const stored = h(v.stored);
  assert.equal(P.showKeyRequested(stored, stored), false);
  const w = P.walk(stored);
  const pk = w.packets.map(p => p.type === 0x27 ? Object.assign({}, p, { body: P.withSec27Flag(p.body, P.SEC_FLAG.SHOW_KEY_ON_SCREEN, true) }) : p);
  const withShow = P.buildBlob(pk);
  assert.equal(P.showKeyRequested(withShow, stored), true);
  assert.equal(P.showKeyRequested(withShow, withShow), false);
});

test('CONFIG_WRITE NACK explanations', () => {
  assert.equal(P.explainConfigNack(h('ff411000')).textKey, 'claim_first');
  assert.equal(P.explainConfigNack(h('ff421000')).textKey, 'claim_first');
  assert.equal(P.explainConfigNack(h('ff411100')).textKey, 'key_mismatch');
  assert.equal(P.explainConfigNack(h('ff410100')).busy, true);
  assert.equal(P.explainConfigNack(h('ff410000')).textKey, 'config_write_failed');
  assert.equal(P.explainConfigNack(h('0041')), null);
});

test.after(() => console.log(`# SEC2 policy vectors reproduced: V10=${n10} V11=${n11}`));
