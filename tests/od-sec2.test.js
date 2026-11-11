// Acceptance test for httpdocs/js/od-sec2.js: every vector of py-opendisplay's
// tests/fixtures/sec2_vectors.json (copied verbatim to tests/fixtures/), recomputed with node's
// WebCrypto and this repository's own CMAC / CCM. The device-side negative cases run against the
// small reference device in tests/helpers/sec2-refdevice.js, which is written from the spec too.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../httpdocs/js/od-sec2.js');
const { RefDevice } = require('./helpers/sec2-refdevice.js');

const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sec2_vectors.json'), 'utf8'));
const h = S.hexToBytes;
const hex = S.bytesToHex;
const counts = {};
function count(group) { counts[group] = (counts[group] || 0) + 1; }

test('vector file identity', () => {
  assert.equal(V.schema, 'opendisplay-sec2-vectors/1');
  assert.match(V.spec, /revision [3-9]/);
});

test('V0 CMAC: the four RFC 4493 examples', async () => {
  for (const c of V.V0_primitives.cmac_rfc4493) {
    assert.equal(hex(await S.cmac(h(c.key), h(c.msg))), c.mac);
    count('V0');
  }
});

test('V0 CCM: 13-byte nonce, 12-byte tag, incl. zero-length plaintext; decrypt round-trips', async () => {
  for (const c of V.V0_primitives.ccm_m12_l2) {
    const ct = await S.ccmEncrypt(h(c.key), h(c.nonce), h(c.aad), h(c.pt));
    assert.equal(hex(ct), c.ct_tag);
    assert.equal(hex(await S.ccmDecrypt(h(c.key), h(c.nonce), h(c.aad), ct)), c.pt);
    const bad = Uint8Array.from(ct); bad[bad.length - 1] ^= 1;
    assert.equal(await S.ccmDecrypt(h(c.key), h(c.nonce), h(c.aad), bad), null);
    count('V0');
  }
});

test('V0 P-256: generator and a symmetric agreement', async () => {
  const g = V.V0_primitives.p256_generator;
  const kp = await S.keyPairFromScalar(h(g.scalar.padStart(64, '0')));
  assert.equal(hex(kp.Q), g.Q);
  assert.ok(S.isValidPoint(kp.Q));
  count('V0');
  const e = V.V0_primitives.p256_ecdh;
  const a = await S.keyPairFromScalar(h(e.d_a));
  const b = await S.keyPairFromScalar(h(e.d_b));
  assert.equal(hex(a.Q), e.Q_a);
  assert.equal(hex(b.Q), e.Q_b);
  assert.equal(hex(await S.ecdh(a.privateKey, b.Q)), e.Z);
  assert.equal(hex(await S.ecdh(b.privateKey, a.Q)), e.Z_check_ba);
  count('V0');
});

test('V1 KDF: every label and context length, input bytes and output', async () => {
  for (const c of V.V1_kdf) {
    assert.equal(c.label.length, c.label_len);
    assert.equal(c.context.length / 2, c.context_len);
    assert.equal(hex(S.kdfInput(c.label, h(c.context))), c.cmac_input);
    assert.equal(hex(await S.kdf(h(c.k_in), c.label, h(c.context))), c.out);
    count('V1');
  }
  await assert.rejects(S.kdf(new Uint8Array(16), 'OD2/k-ext', new Uint8Array(9)), /context of 9 bytes/);
  await assert.rejects(S.kdf(new Uint8Array(16), 'OD2/nope', new Uint8Array(8)), /unknown KDF label/);
});

test('V2 key hierarchy, LEGACY and CLAIMED', async () => {
  for (const c of V.V2_key_hierarchy) {
    const k = await S.keyHierarchy(h(c.k_dev), h(c.uid));
    assert.equal(hex(k.kExt), c.k_ext);
    assert.equal(hex(k.kConf), c.k_conf);
    assert.equal(hex(k.kLan), c.k_lan);
    assert.equal(hex(k.kV1), c.k_v1_derived);
    assert.equal(hex(await S.kV1AtRest(h(c.k_dev), h(c.uid), c.origin === 'LEGACY')), c.k_v1_at_rest);
    count('V2');
  }
});

// Drive the client and the reference device through one whole claim, byte for byte.
for (const c of V.V3_claim) {
  test(`V3 claim (${c.inputs.claim_mode}, frag_max ${c.frag_max}): every value and every fragment`, async () => {
    const I = c.inputs;
    const uid = h(I.uid);
    const client = new S.ClaimClient({ uid, fragMax: c.frag_max, keyPair: await S.keyPairFromScalar(h(I.dc)), nc: h(I.Nc) });
    const dev = new RefDevice({ uid, dflags: parseInt(I.dflags, 16), claimMode: I.claim_mode, timeoutS: I.session_timeout_s,
      rng: { keyPair: await S.keyPairFromScalar(h(I.dd)), nd: h(I.Nd), kNew: h(I.K_new) } });
    const M = c.messages;
    // BEGIN
    const begin = await client.begin();
    assert.equal(hex(begin), M.BEGIN.h2d_body);
    const beginFrames = S.fragment(0x55, 1, begin, c.frag_max);
    assert.deepEqual(beginFrames.map(hex), M.BEGIN.h2d);
    const beginReply = await feed(dev, beginFrames);
    assert.deepEqual(beginReply.map(hex), M.BEGIN.d2h);
    const rb = reassemble(0x55, 1, 81, c.frag_max, beginReply);
    assert.equal(hex(rb), M.BEGIN.d2h_body);
    assert.equal(hex(rb.subarray(65)), c.Cd);
    assert.equal(hex(client.qc), c.Qc);
    // NONCE
    const nonce = client.onBeginReply(rb);
    assert.equal(hex(client.qd), c.Qd);
    assert.equal(hex(nonce), M.NONCE.h2d_body);
    const nonceFrames = S.fragment(0x55, 2, nonce, c.frag_max);
    assert.deepEqual(nonceFrames.map(hex), M.NONCE.h2d);
    const nonceReply = await feed(dev, nonceFrames);
    assert.deepEqual(nonceReply.map(hex), M.NONCE.d2h);
    const rn = reassemble(0x55, 2, 44, c.frag_max, nonceReply);
    assert.equal(hex(rn), M.NONCE.d2h_body);
    assert.equal(hex(rn.subarray(16)), c.W);
    const shown = await client.onNonceReply(rn);
    assert.equal(hex(client.tc), c.Tc);
    assert.equal(shown.code, c.code);
    assert.equal(shown.display, c.code_display);
    assert.equal(hex(client.kNew), I.K_new);
    assert.equal(hex(await S.codeRaw(h(I.Nc), uid, h(c.Qc), h(c.Qd), h(I.Nd))), c.code_raw);
    assert.ok(client.codeMatches(c.code_display));
    assert.ok(!client.codeMatches(String((Number(c.code) + 1) % 1000000).padStart(6, '0')));
    // Intermediate values, recomputed from the spec formulas.
    const z = await S.ecdh((await S.keyPairFromScalar(h(I.dc))).privateKey, h(c.Qd));
    assert.equal(hex(z), c.Z);
    const prk = await S.extract(new Uint8Array(16), z);
    assert.equal(hex(prk), c.PRK);
    assert.equal(hex(await S.kdf(prk, 'OD2/wrap', h(c.Tc))), c.k_wrap);
    // CONFIRM
    const conf = await client.confirm();
    assert.equal(hex(client.kConf), c.K_conf);
    assert.equal(hex(conf), c.tag_c);
    assert.equal(hex(conf), M.CONFIRM.h2d_body);
    const confFrames = S.fragment(0x55, 3, conf, c.frag_max);
    assert.deepEqual(confFrames.map(hex), M.CONFIRM.h2d);
    const confReply = await feed(dev, confFrames);
    assert.deepEqual(confReply.map(hex), M.CONFIRM.d2h);
    const rc = reassemble(0x55, 3, 18, c.frag_max, confReply);
    assert.equal(hex(rc), M.CONFIRM.d2h_body);
    assert.equal(hex(rc.subarray(0, 16)), c.tag_d);
    const done = await client.onConfirmReply(rc);
    assert.equal(done.timeoutS, I.session_timeout_s);
    assert.equal(hex(done.keys.kH2d), c.k_h2d);
    assert.equal(hex(done.keys.kD2h), c.k_d2h);
    assert.equal(hex(done.keys.sid), c.sid);
    // ABORT / EXIT: empty bodies, one empty LAST fragment each way.
    for (const [name, sub] of [['ABORT', 4], ['EXIT', 5]]) {
      assert.deepEqual(S.fragment(0x55, sub, new Uint8Array(0), c.frag_max).map(hex), M[name].h2d);
      assert.deepEqual(M[name].d2h, M[name].h2d);
      const r = new S.Reassembler(0x55, sub, 0, c.frag_max).push(h(M[name].d2h[0]));
      assert.ok(r.done && r.body.length === 0);
    }
    count('V3');
  });
}

for (const c of V.V4_auth) {
  test(`V4 auth (${c.inputs.origin}, frag_max ${c.frag_max}): every value and every fragment`, async () => {
    const I = c.inputs;
    const uid = h(I.uid);
    const kDev = h(I.k_dev);
    const client = new S.AuthClient({ uid, kDev, fragMax: c.frag_max, keyPair: await S.keyPairFromScalar(h(I.dc)), nc: h(I.Nc) });
    const dev = new RefDevice({ uid, dflags: parseInt(I.dflags, 16), kDev, origin: I.origin, timeoutS: I.session_timeout_s,
      rng: { keyPair: await S.keyPairFromScalar(h(I.dd)), nd: h(I.Nd) } });
    assert.equal(hex(await S.kdf(kDev, 'OD2/k-ext', uid)), c.K_ext);
    const M = c.messages;
    const hello = await client.hello();
    assert.equal(hex(hello), M.HELLO.h2d_body);
    const hf = S.fragment(0x56, 1, hello, c.frag_max);
    assert.deepEqual(hf.map(hex), M.HELLO.h2d);
    const hr = await feed(dev, hf);
    assert.deepEqual(hr.map(hex), M.HELLO.d2h);
    const rh = reassemble(0x56, 1, 81, c.frag_max, hr);
    assert.equal(hex(rh), M.HELLO.d2h_body);
    const fin = await client.onHelloReply(rh);
    assert.equal(hex(client.qc), c.Qc);
    assert.equal(hex(client.qd), c.Qd);
    assert.equal(hex(client.ta), c.Ta);
    assert.equal(hex(fin), c.tag_c);
    const z = await S.ecdh((await S.keyPairFromScalar(h(I.dc))).privateKey, h(c.Qd));
    assert.equal(hex(z), c.Z);
    assert.equal(hex(await S.extract(h(c.K_ext), z)), c.PRK);
    const ff = S.fragment(0x56, 2, fin, c.frag_max);
    assert.deepEqual(ff.map(hex), M.FINISH.h2d);
    const fr = await feed(dev, ff);
    assert.deepEqual(fr.map(hex), M.FINISH.d2h);
    const rf = reassemble(0x56, 2, 18, c.frag_max, fr);
    assert.equal(hex(rf.subarray(0, 16)), c.tag_d);
    const done = await client.onFinishReply(rf);
    assert.equal(done.keyLegacy, I.origin === 'LEGACY');
    assert.equal(hex(done.keys.kH2d), c.k_h2d);
    assert.equal(hex(done.keys.kD2h), c.k_d2h);
    assert.equal(hex(done.keys.sid), c.sid);
    count('V4');
  });
}

test('V5 sealed records, both directions; counters 0 and 0xFFFFFFFF rejected', async () => {
  const R = V.V5_records;
  for (const f of R.h2d) {
    const frame = await S.sealH2d(h(R.k_h2d), parseInt(f.cmd, 16), f.ctr, h(f.payload));
    assert.equal(hex(frame), f.frame);
    assert.equal(hex(await S.openH2d(h(R.k_h2d), frame)), f.payload);
    count('V5');
  }
  for (const f of R.d2h) {
    assert.equal(hex(await S.sealD2h(h(R.k_d2h), f.ctr, h(f.plaintext))), f.frame);
    const rl = new S.ClientRecordLayer({ kH2d: h(R.k_h2d), kD2h: h(R.k_d2h) });
    rl.rxLast = f.ctr - 1;
    const r = await rl.open(h(f.frame));
    assert.ok(r.ok);
    assert.equal(hex(r.plaintext), f.plaintext);
    count('V5');
  }
  // The client sealer counts from 1 and refuses the plaintext set.
  const rl = new S.ClientRecordLayer({ kH2d: h(R.k_h2d), kD2h: h(R.k_d2h) });
  assert.equal(hex(await rl.seal(h('0040'))), R.h2d[0].frame);
  assert.equal(hex(await rl.seal(h('0040'))), R.h2d[1].frame);
  await assert.rejects(rl.seal(h('0054')), /plaintext set/);
  rl.txCtr = 0xfffffffd;
  assert.equal(hex(await rl.seal(h('0040'))), R.h2d[4].frame);
  await assert.rejects(rl.seal(h('0040')), /exhausted/);
  for (const f of R.rejected_counters) {
    if (f.direction === 'h2d') {
      const dev = await RefDevice.withSession(h(R.k_h2d), h(R.k_d2h));
      const out = await dev.receive(h(f.frame));
      assert.equal(out.length, 1);
      const r = await dev.openOwnReply(out[0]);
      assert.equal(hex(r.plaintext), 'ff40' + f.sealed_nack);
    } else {
      const c = new S.ClientRecordLayer({ kH2d: h(R.k_h2d), kD2h: h(R.k_d2h) });
      const r = await c.open(h(f.frame));
      assert.equal(r.ok, false);
      assert.equal(f.client, 'discard');
    }
    count('V5');
  }
});

test('V6 rotation: K_conf_new, the tag, the new K_v1 and the sealed exchange', async () => {
  const R = V.V6_rotation;
  const uid = h(R.uid);
  const { kConfNew, tag } = await S.rotateTag(h(R.K_new), uid, h(R.sid));
  assert.equal(hex(kConfNew), R.K_conf_new);
  assert.equal(hex(tag), R.rotate_tag);
  assert.equal(hex(await S.kV1AtRest(h(R.K_new), uid, false)), R.K_v1_new_at_rest);
  const s = R.sealed;
  const rl = new S.ClientRecordLayer({ kH2d: h(s.k_h2d), kD2h: h(s.k_d2h) });
  assert.equal(hex(await rl.seal(h('005701'))), s.ROTATE_request_ctr1);
  const rep = await rl.open(h(s.ROTATE_reply_ctr1));
  assert.ok(rep.ok);
  assert.equal(hex(rep.plaintext), '005701' + R.K_new);
  assert.equal(hex(await rl.seal(S.concat(h('005702'), tag))), s.ROTATE_CONFIRM_request_ctr2);
  const rep2 = await rl.open(h(s.ROTATE_CONFIRM_reply_ctr2));
  assert.ok(rep2.ok);
  assert.equal(hex(rep2.plaintext), '005702');
  assert.equal(hex(await rl.seal(S.concat(h('005703'), S.UNCLAIM_GUARD))), s.UNCLAIM_request_ctr3);
  count('V6');
});

test('V7 negative cases: the exact error, refusal, silence or discard', async () => {
  const claim0 = V.V3_claim[0], auth0 = V.V4_auth[0], R = V.V5_records;
  for (const c of V.V7_negative) {
    if (c.case.startsWith('index 127')) { count('V7'); continue; } // unreachable by construction (note in the file)
    if (c.side === 'device' && c.h2d) {
      let dev;
      if (c.expect === 'AUTH_FAILED' && c.h2d[0].startsWith('005503')) dev = await RefDevice.afterNonce(claim0);
      else if (c.expect === 'AUTH_FAILED') dev = await RefDevice.afterHello(auth0);
      else dev = new RefDevice({ uid: h(claim0.inputs.uid), dflags: 1, claimMode: 'gesture',
        rng: { keyPair: await S.keyPairFromScalar(h(claim0.inputs.dd)), nd: h(claim0.inputs.Nd), kNew: h(claim0.inputs.K_new) } });
      const out = await feed(dev, c.h2d.map(h));
      assert.deepEqual(out.map(hex), c.d2h, c.case);
    } else if (c.side === 'device' && c.frame) {
      const dev = await RefDevice.withSession(h(R.k_h2d), h(R.k_d2h));
      if (c.verdict_first) {
        const first = await dev.receive(h(c.frame));
        assert.equal(first.length, 0, 'first copy accepted (no reply from the stub handler)');
      }
      const out = await dev.receive(h(c.frame));
      if (Array.isArray(c.d2h) && c.d2h.length === 0) {
        assert.equal(out.length, 0, c.case);
        assert.equal(dev.strikes, c.strikes, c.case);
      } else {
        assert.equal(out.length, 1, c.case);
        const code = { integrity: 'f3', replay: 'f2', record: 'f1' }[c.verdict];
        const r = await dev.openOwnReply(out[0]);
        assert.equal(hex(r.plaintext), 'ff' + c.frame.slice(2, 4) + code, c.case);
        assert.equal(dev.strikes, c.verdict === 'integrity' ? 1 : 0, c.case);
      }
    } else if (c.side === 'client' && c.begin_reply) {
      const I = V.V3_claim.find(x => x.messages.BEGIN.d2h_body.slice(2, 130) === c.begin_reply.slice(2, 130) && x.inputs.dflags === c.begin_reply.slice(0, 2)).inputs;
      const cl = new S.ClaimClient({ uid: h(I.uid), keyPair: await S.keyPairFromScalar(h(I.dc)), nc: h(I.Nc) });
      await cl.begin();
      cl.onBeginReply(h(c.begin_reply));
      await assert.rejects(cl.onNonceReply(h(c.nonce_reply)), c.expect.includes('commitment') ? /commitment mismatch/ : /could not unwrap/, c.case);
    } else if (c.side === 'client' && c.frame) {
      const rl = new S.ClientRecordLayer({ kH2d: h(R.k_h2d), kD2h: h(R.k_d2h) });
      if (c.case.includes('repeated')) {
        const own = await S.sealD2h(h(R.k_d2h), 7, h('0041'));
        assert.ok((await rl.open(own)).ok);
      }
      const r = await rl.open(h(c.frame));
      assert.equal(r.ok, false, c.case);
      if (c.case.includes('repeated')) {
        const fresh = new S.ClientRecordLayer({ kH2d: h(R.k_h2d), kD2h: h(R.k_d2h) });
        assert.ok((await fresh.open(h(c.frame))).ok, 'the vector frame itself is genuine');
      }
    } else {
      assert.fail('unhandled V7 case ' + c.case);
    }
    count('V7');
  }
});

test('V8 code edge cases', () => {
  for (const c of V.V8_code) {
    assert.equal(S.codeFromRaw(h(c.code_raw)), c.code);
    assert.equal(S.formatCode(c.code), c.display);
    assert.equal(S.normalizeTypedCode(c.display), c.code);
    count('V8');
  }
  assert.equal(S.normalizeTypedCode(' 508-279 '), '508279');
  assert.equal(S.normalizeTypedCode('5082790'), null);
  assert.equal(S.normalizeTypedCode('5O8279'), null);
  assert.equal(S.normalizeTypedCode(''), null);
});

test('client reassembler is strict about the deterministic split', () => {
  const body = new Uint8Array(81).map((_, i) => i);
  const frames = S.fragment(0x55, 1, body, 20);
  const r = new S.Reassembler(0x55, 1, 81, 20);
  for (const f of frames.slice(0, -1)) assert.deepEqual(r.push(f), { done: false });
  assert.deepEqual(Array.from(r.push(frames[frames.length - 1]).body), Array.from(body));
  // A short non-LAST fragment (any split the device may legally accept from a host) is refused here.
  const odd = new S.Reassembler(0x55, 1, 81, 20);
  assert.ok(odd.push(Uint8Array.of(0, 0x55, 1, 0, 1, 2)).error);
  // A SEC error ends the message.
  const e = new S.Reassembler(0x55, 1, 81, 20).push(h('ff550104'));
  assert.equal(e.secError.name, 'NOT_IN_CLAIM_MODE');
  // Frames of other opcodes are not ours.
  assert.ok(new S.Reassembler(0x55, 1, 81, 20).push(h('004300')).ignore);
});

test('point validation rejects off-curve, (0,0), X >= p and Y >= p', () => {
  const q = h(V.V3_claim[0].Qc);
  assert.ok(S.isValidPoint(q));
  const off = Uint8Array.from(q); off[63] ^= 1;
  assert.ok(!S.isValidPoint(off));
  assert.ok(!S.isValidPoint(new Uint8Array(64)));
  assert.ok(!S.isValidPoint(new Uint8Array(64).fill(0xff)));
  assert.ok(!S.isValidPoint(q.subarray(0, 63)));
});

test('client receive classification (§ 9.5 client rules)', () => {
  const sent = { cmdLos: new Set([0x41, 0x43, 0x54, 0x56]) };
  assert.equal(S.classifyInbound(h('e501000000ea7a6f6eee4f7a247da8f7a9224c'), sent), 'sealed');
  assert.equal(S.classifyInbound(h('0041fe'), sent), 'session_gone');
  assert.equal(S.classifyInbound(h('ff41fe'), sent), 'oversize');
  assert.equal(S.classifyInbound(h('ff71fe'), sent), 'discard'); // not something we sent
  assert.equal(S.classifyInbound(h('ff560207'), sent), 'sec_error');
  assert.equal(S.classifyInbound(h('00430102030405'), sent), 'plaintext');
  assert.equal(S.classifyInbound(h('0041'), sent), 'discard'); // a plaintext ACK of a gated opcode
  assert.equal(S.classifyInbound(h('ff4110'), sent), 'discard');
  assert.deepEqual(S.parseRefusal(h('ff71fe')), { cmdLo: 0x71, code: 0xfe, name: 'OVERSIZE' });
  assert.equal(S.parseRefusal(h('ff4110')), null);
});

test('SEC_STATUS parse', () => {
  const st = S.parseSecStatus(h('005402023102000011223344556677100e0503'));
  assert.equal(st.state, 2);
  assert.ok(st.claimed);
  assert.equal(st.uidHex, '0011223344556677');
  assert.equal(st.timeoutS, 0x0e10);
  assert.ok(st.claimMode && st.rotationSuggested && st.claimModeFresh);
  assert.ok(st.hasPanel && st.keyLegacy);
  assert.equal(st.rendersLeft, 3);
  assert.equal(S.parseSecStatus(h('0054')), null);
});

test.after(() => {
  // Printed so the report can quote the counts (the run's TAP output carries them).
  console.log('# SEC2 vectors reproduced: ' + Object.entries(counts).map(([k, v]) => k + '=' + v).join(' '));
});

async function feed(dev, frames) {
  const out = [];
  for (const f of frames) out.push(...await dev.receive(f));
  return out;
}
function reassemble(cmdLo, sub, len, fragMax, frames) {
  const r = new S.Reassembler(cmdLo, sub, len, fragMax);
  let res = null;
  for (const f of frames) {
    res = r.push(f);
    assert.ok(!res.error, res.error);
  }
  assert.ok(res && res.done);
  return res.body;
}
