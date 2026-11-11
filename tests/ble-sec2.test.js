// ble-common.js with a SEC2 link attached, over a fake GATT characteristic wired to the
// reference device: handshakes go raw, later commands are sealed by sendCommand(), sealed
// notifications are opened before the handler chain, an oversize refusal aborts at once, the
// v1 layer is never used, and chunk sizes follow the seal overhead. Host-tested only.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const S = require('../httpdocs/js/od-sec2.js');
const KS = require('../httpdocs/js/od-keystore.js');
const { Sec2Link } = require('../httpdocs/js/ble-sec2.js');
const { RefDevice } = require('./helpers/sec2-refdevice.js');

const ctx = { window: {}, console, navigator: {}, document: {}, setTimeout, clearTimeout, crypto: globalThis.crypto };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'httpdocs', 'js', 'ble-common.js'), 'utf8') + ';this.OD = OpenDisplayBLE;', ctx);

const NAME = 'OD1A2B3C';
function setup(devOpts) {
  const dev = new RefDevice(Object.assign({ uid: S.hexToBytes('0102030405060708') }, devOpts));
  const ble = new ctx.OD({});
  ble.log = () => {};
  ble.setStatus = () => {};
  ble.isConnected = true;
  const written = [];
  const notes = [];
  ble.onNotification = b => notes.push(Uint8Array.from(b));
  ble.characteristic = {
    properties: { writeWithoutResponse: true },
    async writeValueWithoutResponse(data) {
      const f = Uint8Array.from(data);
      written.push(f);
      const replies = await dev.receive(f);
      if (dev._teardownAfterReply) { dev._teardownAfterReply = false; dev.session = null; }
      for (const r of replies) await ble.handleNotification({ target: { value: new DataView(Uint8Array.from(r).buffer) } });
    }
  };
  const store = new KS.KeyStore({ storage: KS.memoryStorage() });
  const errors = [];
  const link = new Sec2Link(ble, { keyStore: store, name: NAME, sleep: async () => {}, onError: (e, o) => errors.push([e.code, o.fatal]) });
  ble.attachSec2(link);
  ble.onSec2Error = () => {};
  link.onError = (e, o) => { errors.push([e.code, o.fatal]); ble._onSec2Error(e, o); };
  return { dev, ble, link, store, written, notes, errors };
}

test('auth over the link, then sendCommand seals and the reply reaches the handler chain in plaintext', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const r = setup({ kDev });
  r.store.addCandidate(NAME, kDev);
  await r.link.own(async s => { assert.equal((await s.select()).mode, 'sec2'); await s.authenticate(); });
  assert.equal(r.link.sealed, true);
  r.dev.handlers[0x0030] = () => Uint8Array.of(0x00, 0x30, 0x01);
  await r.ble.sendCommand(Uint8Array.of(0x00, 0x30, 0xaa));
  const w = r.written[r.written.length - 1];
  assert.equal(w.length, 2 + 4 + 1 + 12, 'sealed on the wire');
  assert.deepEqual(Array.from(r.notes[r.notes.length - 1]), [0x00, 0x30, 0x01]);
  // v1 is never used for this connection.
  assert.equal(r.ble.encryptionSession.authenticated, false);
  assert.ok(!r.written.some(f => f[0] === 0x00 && f[1] === 0x50));
  // Chunk sizes from the frame limit minus the seal overhead.
  assert.equal(r.ble._directWriteChunkSize(), 226);
  assert.equal(r.link.pipeDataSize(244), 244 - 18 - 1);
});

test('an oversize refusal aborts the in-flight operation at once (no 90 s wait)', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const r = setup({ kDev, maxFrame: 120 });
  r.store.addCandidate(NAME, kDev);
  await r.link.own(async s => { await s.select(); await s.authenticate(); });
  let aborted = null;
  r.ble.abortInFlightOperations = e => { aborted = e; };
  // 150 B of payload fits our 244 B limit but not this device's 120 B: it refuses sealed.
  await r.ble.sendCommand(S.concat(Uint8Array.of(0x00, 0x30), new Uint8Array(150)));
  assert.deepEqual(r.errors[r.errors.length - 1], ['frame_too_long', true]);
  assert.equal(aborted && aborted.code, 'frame_too_long');
  // Bigger than our own limit: refused before anything is written.
  const n = r.written.length;
  await assert.rejects(r.ble.sendCommand(S.concat(Uint8Array.of(0x00, 0x30), new Uint8Array(230))), e => e.code === 'frame_too_long');
  assert.equal(r.written.length, n);
});

test('claim over the link with the typed code; the session survives for a config read', async () => {
  const r = setup({ claimMode: 'fresh' });
  const res = await r.link.own(s => s.claim({ askCode: async ({ display }) => display, acknowledge: async () => true }));
  assert.equal(S.bytesToHex(r.dev.kDev), res.key);
  r.dev.handlers[0x0040] = () => S.concat(Uint8Array.of(0x00, 0x40, 0, 0, 3, 0), Uint8Array.of(1, 2, 3));
  await r.ble.sendCommand(Uint8Array.of(0x00, 0x40));
  assert.deepEqual(Array.from(r.notes[r.notes.length - 1]), [0x00, 0x40, 0, 0, 3, 0, 1, 2, 3]);
});

test('disconnect drops the session; a claimed device without a session gets at most two gated commands', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const r = setup({ kDev });
  r.store.addCandidate(NAME, kDev);
  await r.link.own(async s => { await s.select(); await s.authenticate(); });
  const ch = r.ble.characteristic;
  r.ble.resetState();
  assert.equal(r.link.sealed, false);
  r.dev.disconnect();
  r.ble.isConnected = true; r.ble.characteristic = ch;
  await r.ble.sendCommand(Uint8Array.of(0x00, 0x40));
  await r.ble.sendCommand(Uint8Array.of(0x00, 0x40));
  assert.deepEqual(r.errors.slice(-2), [['needs_session', false], ['needs_session', false]]);
  assert.ok(r.notes.slice(-2).every(n => n.length === 3 && n[2] === 0xfe), 'FE still reaches the old "needs a key" detection');
  await assert.rejects(r.ble.sendCommand(Uint8Array.of(0x00, 0x40)), e => e.code === 'not_authorised');
  assert.equal(r.dev.closed, false, 'the device abuse limit was never reached');
});
