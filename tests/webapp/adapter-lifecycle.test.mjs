// M1 adapter state-machine tests: the REAL ble-adapter.js module driven
// against scripted mock instances behind a mock bridge. Covers the lifecycle
// invariants (plan §3): serialized connects, attach-rejected-while-connected,
// renewal after every disconnect (explicit, unexpected, failed-connect,
// timeout), deadlines with disconnect-on-timeout, auth wrap-and-replay, and
// fresh-instance schema readiness gating operations.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const adapterSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../httpdocs/app/v1/js/ble-adapter.js'),
  'utf8',
);

// Fresh module instance per test file run (module-level state machine).
const adapter = await import(
  `data:text/javascript;base64,${Buffer.from(adapterSource).toString('base64')}`
);

// --- scripted mock OpenDisplayBLE ---

const GOOD_OFFSETS = {
  pixel_width: 8, pixel_height: 10, rotation: 16, color_scheme: 24,
  transmission_modes: 25, partial_update_support: 23, panel_ic_type: 6,
};

function makeMockInstance(overrides = {}) {
  const inst = {
    id: Symbol('inst'),
    encryptionSession: { authenticated: false, masterKey: null },
    device: null,
    onDisconnect: null,
    calls: [],
    packetSchema: null,
    packetSizes: {},
    packetFieldOffsets: {},
    async loadYAMLConfig() {
      inst.calls.push('loadYAMLConfig');
      inst.packetSchema = { 32: { fields: [] } };
      inst.packetSizes = { 32: 40 };
      inst.packetFieldOffsets = { 32: GOOD_OFFSETS };
    },
    async connect() { inst.calls.push('connect'); },
    async disconnect() { inst.calls.push('disconnect'); },
    async readConfig(cb) {
      inst.calls.push('readConfig');
      cb([1, 2, 3], null);
    },
    async readFirmwareVersion(cb) {
      inst.calls.push('readFirmwareVersion');
      cb({ major: 2, minor: 3, patch: 1 }, null);
    },
    async readMsd() { return new Uint8Array(16).fill(7); },
    async setEncryptionKey(k) { inst.encryptionSession.masterKey = k; },
    async authenticate() { inst.encryptionSession.authenticated = true; },
    parseConfigBytes() { return { packets: [] }; },
    extractDisplayConfig() {
      return {
        pixelWidth: 800, pixelHeight: 480, rotation: 1, colorScheme: 4,
        transmissionModes: 0x13, partialUpdateSupport: 0, panelIcType: 35,
      };
    },
    ...overrides,
  };
  return inst;
}

let instances = [];

function installBridge(overrides = {}) {
  instances = [];
  const make = () => {
    const inst = makeMockInstance(overrides);
    instances.push(inst);
    globalThis.odAppBle = inst;
    return inst;
  };
  globalThis.odAppBridge = { renew: make };
  make();
}

function current() { return globalThis.odAppBle; }

beforeEach(async () => {
  installBridge();
  adapter.setKeyProvider(null);
  adapter.setUnexpectedDisconnectListener(null);
  // Settle the state machine from any prior test.
  await adapter.disconnect().catch(() => {});
  installBridge();
});

test('connect happy path: ready gates connect; states transition', async () => {
  await adapter.connectViaChooser('OD');
  assert.equal(adapter.getState(), 'connected');
  const c = current().calls;
  assert.ok(c.indexOf('loadYAMLConfig') < c.indexOf('connect'), 'ready before connect');
});

test('connect rejected while already connected; attach too', async () => {
  await adapter.connectViaChooser('OD');
  await assert.rejects(adapter.connectViaChooser('OD'), /while connected/i);
  await assert.rejects(adapter.connectCached({ id: 'x' }), /while connected/i);
});

test('explicit disconnect renews the instance', async () => {
  await adapter.connectViaChooser('OD');
  const before = current();
  await adapter.disconnect();
  assert.equal(adapter.getState(), 'idle');
  assert.notEqual(current(), before, 'fresh instance after disconnect');
  assert.ok(before.calls.includes('disconnect'));
});

test('unexpected disconnect: renews first, then notifies listener', async () => {
  await adapter.connectViaChooser('OD');
  const before = current();
  let sawFreshInstance = null;
  adapter.setUnexpectedDisconnectListener(() => {
    sawFreshInstance = current() !== before;
  });
  await before.onDisconnect(); // library fires gattserverdisconnected (async handler)
  assert.equal(adapter.getState(), 'idle');
  assert.equal(sawFreshInstance, true, 'listener ran after the bridge renewed');
});

test('failed connect renews (partial per-connection state discarded)', async () => {
  installBridge({ connect: async () => { throw new Error('GATT boom'); } });
  const before = current();
  await assert.rejects(adapter.connectViaChooser('OD'), /GATT boom/);
  assert.equal(adapter.getState(), 'idle');
  assert.notEqual(current(), before);
});

test('connect deadline: hang -> TimeoutError, disconnect, renew', async () => {
  installBridge({ connect: () => new Promise(() => {}) });
  const before = current();
  adapter.DEADLINES.connect = 50;
  try {
    await assert.rejects(adapter.connectViaChooser('OD'), /timed out/i);
  } finally {
    adapter.DEADLINES.connect = 25000;
  }
  assert.equal(adapter.getState(), 'idle');
  assert.notEqual(current(), before, 'renewed after timeout');
});

test('readDeviceInfo happy path maps display fields and quarter-turns', async () => {
  await adapter.connectViaChooser('OD');
  current().device = { id: 'ble-1', name: 'OD-TEST' };
  const info = await adapter.readDeviceInfo();
  assert.equal(info.width, 800);
  assert.equal(info.height, 480);
  assert.equal(info.rotationQuarterTurns, 1);
  assert.equal(info.colorScheme, 4);
  assert.equal(info.firmware, '2.3.1');
  assert.equal(info.msdHex, '07'.repeat(16));
  assert.equal(info.authRequired, false);
});

test('config-read deadline: silent device -> TimeoutError + disconnect', async () => {
  installBridge({ readConfig: async () => { /* never calls back */ } });
  await adapter.connectViaChooser('OD');
  adapter.DEADLINES.config = 50;
  try {
    await assert.rejects(adapter.readDeviceInfo(), /timed out/i);
  } finally {
    adapter.DEADLINES.config = 15000;
  }
  assert.equal(adapter.getState(), 'idle', 'timeout disconnected');
});

test('0xFE: stored key authenticates and the read replays once', async () => {
  let configCalls = 0;
  installBridge({
    readConfig: async (cb) => {
      configCalls++;
      if (configCalls === 1) cb(null, new Error('Authentication required (0xFE)'));
      else cb([9, 9], null);
    },
  });
  await adapter.connectViaChooser('OD');
  const key = new Uint8Array(16).fill(0xaa);
  const info = await adapter.readDeviceInfo({ storedKey: key });
  assert.equal(configCalls, 2, 'replayed exactly once');
  assert.equal(info.authRequired, true);
  assert.deepEqual(current().encryptionSession.masterKey, key);
});

test('0xFE with no stored key: key provider asked once; cancel -> AuthRequiredError', async () => {
  installBridge({
    readConfig: async (cb) => cb(null, new Error('Authentication required (0xFE)')),
  });
  await adapter.connectViaChooser('OD');
  let asks = 0;
  adapter.setKeyProvider(async () => { asks++; return null; });
  await assert.rejects(adapter.readDeviceInfo(), /cancelled/i);
  assert.equal(asks, 1);
  // No provider at all:
  adapter.setKeyProvider(null);
  await assert.rejects(adapter.readDeviceInfo(), /locked/i);
});

test('operations serialize: second readDeviceInfo rejects while one is in flight', async () => {
  let release;
  installBridge({
    readConfig: async (cb) => { await new Promise((r) => { release = () => { cb([1], null); r(); }; }); },
  });
  await adapter.connectViaChooser('OD');
  const first = adapter.readDeviceInfo();
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(adapter.readDeviceInfo(), /in progress/i);
  release();
  await first;
});

test('per-connection isolation: locked A then B — B instance has no session state', async () => {
  // Device A: locked, authenticates with key A.
  let configCalls = 0;
  installBridge({
    readConfig: async (cb) => {
      configCalls++;
      if (configCalls === 1) cb(null, new Error('Authentication required (0xFE)'));
      else cb([1], null);
    },
  });
  await adapter.connectViaChooser('OD');
  const instA = current();
  await adapter.readDeviceInfo({ storedKey: new Uint8Array(16).fill(0xa1) });
  assert.equal(instA.encryptionSession.authenticated, true);
  await adapter.disconnect();

  // Device B: fresh instance, no key/session carried over.
  const instB = current();
  assert.notEqual(instA, instB);
  assert.equal(instB.encryptionSession.authenticated, false);
  assert.equal(instB.encryptionSession.masterKey, null);
});

test('fresh instance readiness gates the next connect (slow schema load)', async () => {
  await adapter.connectViaChooser('OD');
  await adapter.disconnect();
  // Replace the renewed instance with a slow-loading one.
  installBridge({
    loadYAMLConfig: async function () {
      await new Promise((r) => setTimeout(r, 30));
      this.packetSchema = { 32: {} };
      this.packetSizes = { 32: 40 };
      this.packetFieldOffsets = { 32: GOOD_OFFSETS };
    },
  });
  const inst = current();
  await adapter.connectViaChooser('OD');
  assert.ok(
    inst.calls.indexOf('loadYAMLConfig') < inst.calls.indexOf('connect'),
    'connect waited for the fresh instance schema',
  );
});

// --- race-condition coverage (M1 review round 2) ---

test('concurrent connects during slow readiness: exactly one wins', async () => {
  installBridge({
    loadYAMLConfig: async function () {
      await new Promise((r) => setTimeout(r, 30));
      this.packetSchema = { 32: {} };
      this.packetSizes = { 32: 40 };
      this.packetFieldOffsets = { 32: GOOD_OFFSETS };
    },
  });
  const results = await Promise.allSettled([
    adapter.connectViaChooser('OD'),
    adapter.connectViaChooser('OD'),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one connect succeeded');
  assert.match(String(rejected[0].reason), /while connecting/i);
  assert.equal(adapter.getState(), 'connected');
});

test('disconnect during a slow connect: late success is invalidated, never connected', async () => {
  let releaseConnect;
  installBridge({
    connect: () => new Promise((r) => { releaseConnect = r; }),
  });
  const connectP = adapter.connectViaChooser('OD');
  await new Promise((r) => setTimeout(r, 10)); // connect in flight
  // Unexpected disconnect fires while the connect promise is pending.
  globalThis.odAppBle.onDisconnect?.();
  await new Promise((r) => setTimeout(r, 10));
  releaseConnect(); // the old connect "succeeds" late
  await assert.rejects(connectP, /torn down|while the operation/i);
  assert.notEqual(adapter.getState(), 'connected', 'late success must not set connected');
});

test('unexpected disconnect during an op: op result invalidated', async () => {
  let releaseConfig;
  installBridge({
    readConfig: async (cb) => { releaseConfig = () => cb([1], null); },
  });
  await adapter.connectViaChooser('OD');
  const inst = current();
  const opP = adapter.readDeviceInfo();
  await new Promise((r) => setTimeout(r, 10));
  await inst.onDisconnect(); // async handler: renews before notifying
  releaseConfig(); // config "arrives" on the discarded instance
  await assert.rejects(opP, /torn down|Not connected|timed out/i);
});

test('unexpected disconnect handler awaits readiness before notifying', async () => {
  await adapter.connectViaChooser('OD');
  const before = current();
  let readyAtNotify = null;
  adapter.setUnexpectedDisconnectListener(() => {
    // The fresh instance must already be schema-ready when the UI hears.
    readyAtNotify = !!current().packetSchema?.[32];
  });
  await before.onDisconnect();
  assert.equal(readyAtNotify, true);
});

test('stored key fails -> exactly one provider ask; provider key succeeds', async () => {
  let authCalls = 0;
  let configCalls = 0;
  installBridge({
    authenticate: async function () {
      authCalls++;
      if (this.encryptionSession.masterKey?.[0] === 0xba) { this.encryptionSession.authenticated = true; return; }
      throw new Error('Authentication failed: wrong key');
    },
    readConfig: async (cb) => {
      configCalls++;
      if (configCalls === 1) cb(null, new Error('Authentication required (0xFE)'));
      else cb([1], null);
    },
  });
  await adapter.connectViaChooser('OD');
  let asks = 0;
  adapter.setKeyProvider(async ({ reason }) => {
    asks++;
    assert.equal(reason, 'stored-key-failed');
    return new Uint8Array(16).fill(0xba);
  });
  const info = await adapter.readDeviceInfo({ storedKey: new Uint8Array(16).fill(0x01) });
  assert.equal(asks, 1);
  assert.equal(authCalls, 2, 'stored key tried, then provider key');
  assert.equal(info.authKeyFromProvider, true, 'caller told the key came from the dialog');
});

test('rate-limit error surfaces without burning the provider ask', async () => {
  installBridge({
    authenticate: async () => { throw new Error('Authentication rate limit exceeded (10 attempts per minute)'); },
    readConfig: async (cb) => cb(null, new Error('Authentication required (0xFE)')),
  });
  await adapter.connectViaChooser('OD');
  let asks = 0;
  adapter.setKeyProvider(async () => { asks++; return new Uint8Array(16); });
  await assert.rejects(
    adapter.readDeviceInfo({ storedKey: new Uint8Array(16).fill(1) }),
    /rate limit/i,
  );
  assert.equal(asks, 0, 'provider not consulted while rate limited');
});

// --- lease/step coverage (M1 review round 3) ---

test('stale connect resolving late does NOT clobber a newer connect\'s state', async () => {
  let releaseA;
  installBridge({ connect: () => new Promise((r) => { releaseA = r; }) });
  const connectA = adapter.connectViaChooser('OD');
  await new Promise((r) => setTimeout(r, 10));
  // Unexpected disconnect kills A's attempt and renews.
  await globalThis.odAppBle.onDisconnect?.();
  // B starts on the fresh instance; make B's connect slow too.
  let releaseB;
  globalThis.odAppBle.connect = () => new Promise((r) => { releaseB = r; });
  const connectB = adapter.connectViaChooser('OD');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(adapter.getState(), 'connecting', 'B owns the state');
  releaseA(); // stale A resolves late
  await assert.rejects(connectA, /torn down|while the operation/i);
  assert.equal(adapter.getState(), 'connecting', 'stale A must not reset B to idle');
  // A third connect must STILL be rejected while B is in flight.
  await assert.rejects(adapter.connectViaChooser('OD'), /while connecting/i);
  releaseB();
  await connectB;
  assert.equal(adapter.getState(), 'connected');
});

test('mid-op disconnect STOPS the operation: no further BLE calls on the old instance', async () => {
  let releaseFirmware;
  installBridge({
    readFirmwareVersion: async function (cb) {
      this.calls.push('readFirmwareVersion');
      await new Promise((r) => { releaseFirmware = () => { cb({ major: 1, minor: 0, patch: 0 }, null); r(); }; });
    },
  });
  await adapter.connectViaChooser('OD');
  const inst = current();
  const opP = adapter.readDeviceInfo();
  await new Promise((r) => setTimeout(r, 10));
  await inst.onDisconnect(); // renews mid-op
  releaseFirmware(); // firmware step completes AFTER the disconnect
  await assert.rejects(opP, /torn down|while the operation/i);
  // The op must have stopped at the firmware step: config was never issued.
  assert.ok(!inst.calls.includes('readConfig'),
    `no post-disconnect BLE call on the old instance: ${inst.calls.join(',')}`);
});

// --- coalesced-disconnect + auth-liveness coverage (M1 review round 4) ---

test('concurrent disconnects coalesce; an older teardown cannot break the next connect', async () => {
  let releaseDisc;
  installBridge({
    disconnect: function () {
      this.calls.push('disconnect');
      return new Promise((r) => { releaseDisc = r; });
    },
  });
  await adapter.connectViaChooser('OD');
  const instA = current();
  // Two disconnects race (deadline teardown + controller catch): coalesce.
  const d1 = adapter.disconnect();
  const d2 = adapter.disconnect();
  releaseDisc();
  await Promise.all([d1, d2]);
  assert.equal(instA.calls.filter((c) => c === 'disconnect').length, 1, 'one teardown, not two');
  assert.equal(adapter.getState(), 'idle');
  // The next connect must proceed unmolested by any straggling teardown.
  globalThis.odAppBle.connect = async function () { this.calls?.push?.('connect'); };
  await adapter.connectViaChooser('OD');
  assert.equal(adapter.getState(), 'connected');
  const info = await adapter.readDeviceInfo();
  assert.equal(info.width, 800, 'operation on the new connection succeeds');
});

test('disconnect during stored-key auth: provider NOT asked, no radio calls after teardown', async () => {
  let failAuth;
  installBridge({
    readConfig: async (cb) => cb(null, new Error('Authentication required (0xFE)')),
    authenticate: () => new Promise((_, rej) => { failAuth = () => rej(new Error('GATT disconnected')); }),
  });
  await adapter.connectViaChooser('OD');
  const inst = current();
  let asks = 0;
  adapter.setKeyProvider(async () => { asks++; return new Uint8Array(16); });
  const opP = adapter.readDeviceInfo({ storedKey: new Uint8Array(16).fill(0x77) });
  await new Promise((r) => setTimeout(r, 10));
  await inst.onDisconnect(); // connection dies mid-auth
  failAuth(); // the stored-key authenticate() rejects because of the drop
  await assert.rejects(opP, /torn down|while the operation/i);
  assert.equal(asks, 0, 'key dialog never opened for a dead session');
});

// --- sendCanvas (M3) ---

function fakeCanvas(w, h) {
  return { width: w, height: h };
}

test('sendCanvas rejects unsupported schemes BEFORE the fail-open encoder sees them', async () => {
  installBridge({ sendCanvasToDisplay: async () => { throw new Error('should not be reached'); } });
  await adapter.connectViaChooser('OD');
  // Scheme 7 packs as MONOCHROME in the shared encoder (proven in the spike).
  await assert.rejects(
    adapter.sendCanvas(fakeCanvas(10, 10), 7, { originalWidth: 10, originalHeight: 10 }),
    /not supported/i,
  );
  await assert.rejects(
    adapter.sendCanvas(fakeCanvas(10, 10), 9, { originalWidth: 10, originalHeight: 10 }),
    /not supported/i,
  );
});

test('sendCanvas rejects a canvas whose size does not match the panel + rotation', async () => {
  installBridge();
  await adapter.connectViaChooser('OD');
  // Unrotated: canvas must equal the native size.
  await assert.rejects(
    adapter.sendCanvas(fakeCanvas(100, 50), 0, { originalWidth: 800, originalHeight: 480 }),
    /does not match panel/,
  );
  // Rotated: the canvas must be SWAPPED, so passing native dims is wrong.
  await assert.rejects(
    adapter.sendCanvas(fakeCanvas(800, 480), 0,
      { originalWidth: 800, originalHeight: 480, rotationQuarterTurns: 1 }),
    /expected 480x800/,
  );
});

test('sendCanvas resolves on REFRESH complete and reports transfer separately', async () => {
  let captured = null;
  installBridge({
    sendCanvasToDisplay: async (canvas, scheme, opts) => { captured = opts; },
  });
  await adapter.connectViaChooser('OD');

  const events = [];
  const p = adapter.sendCanvas(fakeCanvas(480, 800), 4, {
    originalWidth: 800, originalHeight: 480, rotationQuarterTurns: 1,
    panelIcType: 35, transmissionModes: 0x13,
    onProgress: (s, t) => events.push(`progress:${s}/${t}`),
    onTransferComplete: () => events.push('transfer'),
  });
  await new Promise((r) => setTimeout(r, 5));

  // The library passes wire quarter-turns plus NATIVE dimensions.
  assert.equal(captured.rotation, 1);
  assert.equal(captured.originalWidth, 800);
  assert.equal(captured.originalHeight, 480);
  assert.equal(captured.panelIcType, 35);

  captured.onProgress(3, 10);
  // The ONLY public signal for the data-phase boundary is this status string.
  captured.onStatusChange('Upload complete (2.10s), refreshing display...');
  captured.onStatusChange('Upload complete (2.10s), refreshing display...'); // repeat
  assert.deepEqual(events, ['progress:3/10', 'transfer'], 'transfer announced exactly once');

  // onComplete only fires after refresh-complete (0x73) in the real library.
  captured.onComplete(true, null);
  assert.deepEqual(await p, { skipped: false, refreshed: true });
});

test('a no-change partial update reports SKIPPED, not "refreshed"', async () => {
  let captured = null;
  installBridge({ sendCanvasToDisplay: async (c, s, opts) => { captured = opts; } });
  await adapter.connectViaChooser('OD');
  const events = [];
  const p = adapter.sendCanvas(fakeCanvas(10, 10), 0, {
    originalWidth: 10, originalHeight: 10,
    onTransferComplete: () => events.push('transfer'),
  });
  await new Promise((r) => setTimeout(r, 5));
  // The library skips the upload entirely and completes immediately.
  captured.onStatusChange('No pixel changes — upload skipped');
  captured.onComplete(true, null);
  assert.deepEqual(await p, { skipped: true, refreshed: false });
  assert.deepEqual(events, [], 'nothing was transferred, so nothing is announced');
});

test('sendCanvas surfaces a device-side failure', async () => {
  let captured = null;
  installBridge({ sendCanvasToDisplay: async (c, s, opts) => { captured = opts; } });
  await adapter.connectViaChooser('OD');
  const p = adapter.sendCanvas(fakeCanvas(10, 10), 0, { originalWidth: 10, originalHeight: 10 });
  await new Promise((r) => setTimeout(r, 5));
  captured.onComplete(false, new Error('NACK: etag mismatch'));
  await assert.rejects(p, /etag mismatch/);
});

test('a disconnect mid-send invalidates the result and stops progress callbacks', async () => {
  let captured = null;
  installBridge({ sendCanvasToDisplay: async (c, s, opts) => { captured = opts; } });
  await adapter.connectViaChooser('OD');
  const inst = current();
  const progress = [];
  const p = adapter.sendCanvas(fakeCanvas(10, 10), 0, {
    originalWidth: 10, originalHeight: 10,
    onProgress: (s, t) => progress.push([s, t]),
  });
  await new Promise((r) => setTimeout(r, 5));
  captured.onProgress(1, 10);
  await inst.onDisconnect();          // the tag drops mid-upload
  captured.onProgress(5, 10);          // late callbacks from the dead instance
  captured.onComplete(true, null);     // and a late "success"
  await assert.rejects(p, /torn down|while the operation/i);
  assert.deepEqual(progress, [[1, 10]], 'no progress reported after the disconnect');
});

test('sendCanvas refuses when not connected', async () => {
  installBridge();
  await assert.rejects(
    adapter.sendCanvas(fakeCanvas(10, 10), 0, { originalWidth: 10, originalHeight: 10 }),
    /Not connected/,
  );
});
