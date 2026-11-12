// Acknowledgement delivery in ble-common.js (EN04 / Nordic first hardware run): a reply can be
// delivered before the write that caused it resolves, notifications are handled one at a time
// in arrival order, and a 0x0085 START that carries data gets a pass-aware budget. Host-tested.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = { window: {}, console, navigator: {}, document: {}, setTimeout, clearTimeout, crypto: globalThis.crypto };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'httpdocs', 'js', 'ble-common.js'), 'utf8') + ';this.OD = OpenDisplayBLE;', ctx);

function ble() {
  const b = new ctx.OD({});
  b.log = () => {};
  b.setStatus = () => {};
  b.isConnected = true;
  return b;
}
const ev = (bytes, pad = 0) => {
  // A DataView into a larger buffer: handlers must honour byteOffset / byteLength.
  const buf = new Uint8Array(pad + bytes.length + 3).fill(0xee);
  buf.set(bytes, pad);
  return { target: { value: new DataView(buf.buffer, pad, bytes.length) } };
};
const tick = () => new Promise(r => setTimeout(r, 0));

test('notifications reach the handler chain in arrival order even when opening one is slow', async () => {
  const b = ble();
  const seen = [];
  b.onNotification = bytes => seen.push(bytes[1]);
  // The first frame takes longer to open than the second (as an async record open can).
  b.sec2Link = {
    async incoming(bytes) {
      if (bytes[1] === 0x01) await new Promise(r => setTimeout(r, 20));
      return bytes;
    }
  };
  b._onNotification(ev([0x00, 0x01]));
  b._onNotification(ev([0x00, 0x02]));
  b._onNotification(ev([0x00, 0x03]));
  await b._rxChain;
  assert.deepEqual(seen, [0x01, 0x02, 0x03]);
});

test('a notification view with an offset is read as its own bytes, copied at once', async () => {
  const b = ble();
  const seen = [];
  b.onNotification = bytes => seen.push(Array.from(bytes));
  const e = ev([0x00, 0x30, 0x01], 5);
  b._onNotification(e);
  new Uint8Array(e.target.value.buffer).fill(0);  // the stack reuses the buffer for the next one
  await b._rxChain;
  assert.deepEqual(seen, [[0x00, 0x30, 0x01]]);
});

test('a v1 auth challenge delivered before the write resolves is not lost', async () => {
  const b = ble();
  b.encryptionSession.masterKey = new Uint8Array(16);
  // The device answers inside the write: the reply event fires before sendCommand resolves.
  b.sendCommand = async cmd => {
    if (cmd[1] === 0x50) await b.handleNotification(ev([0x00, 0x50, 0x05]));
  };
  const t0 = Date.now();
  await assert.rejects(() => b.authenticate(), err => {
    assert.match(String(err && err.message), /status 0x5/);
    return true;
  });
  assert.ok(Date.now() - t0 < 1000, 'no 5 s timeout: the reply was taken');
});

test('identical config-write chunk ACKs, each delivered inside its write, are all taken', async () => {
  const b = ble();
  b.sendCommand = async cmd => {
    if (cmd[1] === 0x41 || cmd[1] === 0x42) await b.handleNotification(ev([0x00, cmd[1], 0x00, 0x00]));
  };
  const blob = new Uint8Array(900).fill(7);
  await b.writeConfig(blob);
  await tick();
  assert.equal(b.configWriteState.active, false);
});

test('a drive START carrying data waits for the pass refreshes it may run first; bounded', () => {
  const f = ctx.driveStartAckTimeoutMs;
  assert.equal(f(1), 15000 + 90000);
  assert.equal(f(3), 15000 + 90000);   // max(90 s, 2 x 45 s)
  assert.equal(f(8), 15000 + 7 * 45000);
  assert.ok(f(3) > 23000 && Number.isFinite(f(8)));
});

test('the drive START timer uses the pass-aware budget only when the START carries data', () => {
  for (const [carries, label, ms] of [[true, 'drive start', 105000], [false, 'start', undefined]]) {
    const b = ble();
    const armed = [];
    b._armDirectWriteAckTimer = (l, t) => armed.push([l, t]);
    b.sendHexCommand = async () => {};
    b._activateFullDirectWrite({ chunks: [], startCommandHex: '0085', passes: 3, startCarriesData: carries });
    assert.deepEqual(armed, [[label, ms]]);
  }
});

test('a sealed frame opened twice concurrently is delivered once (counter re-checked after the await)', async () => {
  const S = require('../httpdocs/js/od-sec2.js');
  const kD2h = new Uint8Array(16).fill(3);
  const rl = new S.ClientRecordLayer({ kH2d: new Uint8Array(16).fill(1), kD2h });
  const f5 = await S.sealD2h(kD2h, 5, Uint8Array.of(0x00, 0x42));
  const f6 = await S.sealD2h(kD2h, 6, Uint8Array.of(0x00, 0x42));
  const [a, b] = await Promise.all([rl.open(f5), rl.open(f5)]);
  assert.equal([a, b].filter(r => r.ok).length, 1);
  assert.equal((await rl.open(f6)).ok, true);   // a new counter is never a duplicate
  assert.equal(rl.rxLast, 6);
});
