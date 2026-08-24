// M3 unit tests: palette selection, paint-back and the dither-client contract.
// The wasm library itself is exercised in the browser test; here we pin the
// app-side logic that decides what gets sent to a panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppModule } from './lib/load-app-module.mjs';

const dither = await loadAppModule('composer/dither.js');
const { createDitherClient } = await loadAppModule('composer/dither-client.js');
const { IDEAL_PALETTES } = await loadAppModule('composer/palettes.js');

// --- measured palette selection ---

test('measured palettes are chosen per (panel, scheme), mirroring py-opendisplay', () => {
  const lib = {
    SPECTRA_7_3_6COLOR: 'spectra6',
    SPECTRA_7_3_6COLOR_V2: 'spectra6v2',
    MONO_4_26: 'mono426',
    SOLUM_BWR: 'solum',
    BWRY_3_97: 'bwry397',
  };
  const pick = (colorScheme, panelIcType, useMeasured = true) =>
    dither.ditherTarget(lib, { colorScheme, panelIcType, useMeasured });

  assert.deepEqual(pick(4, 35), { target: 'spectra6', measured: true });
  assert.deepEqual(pick(0, 39), { target: 'mono426', measured: true });
  assert.deepEqual(pick(1, 33), { target: 'solum', measured: true });
  assert.deepEqual(pick(3, 55), { target: 'bwry397', measured: true });
  assert.deepEqual(pick(8, 66), { target: 'spectra6v2', measured: true });
});

test('unmeasured panels and the opt-out fall back to the ideal ColorScheme', () => {
  const lib = { MONO_4_26: 'mono426' };
  // Right scheme, unknown panel.
  assert.deepEqual(dither.ditherTarget(lib, { colorScheme: 0, panelIcType: 999, useMeasured: true }),
    { target: 0, measured: false });
  // Known panel, but the user turned measured palettes off.
  assert.deepEqual(dither.ditherTarget(lib, { colorScheme: 0, panelIcType: 39, useMeasured: false }),
    { target: 0, measured: false });
  // Known mapping but the library lacks the export (older vendored bundle).
  assert.deepEqual(dither.ditherTarget({}, { colorScheme: 0, panelIcType: 39, useMeasured: true }),
    { target: 0, measured: false });
});

// --- paint-back ---

test('paintForSend paints EXACT ideal palette colours, fully opaque', () => {
  const indices = new Uint8Array([0, 1, 2, 3, 4, 5]);
  const rgba = dither.paintForSend(indices, 4, null);
  const ideal = IDEAL_PALETTES[4];
  for (let i = 0; i < indices.length; i++) {
    assert.deepEqual(
      [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]], ideal[indices[i]],
      `pixel ${i}`,
    );
    assert.equal(rgba[i * 4 + 3], 255, 'opaque');
  }
});

test('preview paints the MEASURED inks it dithered against, not the ideal ones', () => {
  const measured = [[31, 24, 41], [185, 202, 205]];
  const rgba = dither.paintPreview(new Uint8Array([0, 1]), measured);
  assert.deepEqual([rgba[0], rgba[1], rgba[2]], [31, 24, 41]);
  assert.deepEqual([rgba[4], rgba[5], rgba[6]], [185, 202, 205]);
});

test('BWRY panels 0x1D/0x1E swap yellow and red on the SEND canvas only', () => {
  assert.equal(dither.needsBwryPaintSwap(3, 0x1d), true);
  assert.equal(dither.needsBwryPaintSwap(3, 0x1e), true);
  assert.equal(dither.needsBwryPaintSwap(3, 0x37), false, 'other BWRY panels unaffected');
  assert.equal(dither.needsBwryPaintSwap(4, 0x1d), false, 'only scheme 3');

  const indices = new Uint8Array([0, 1, 2, 3]);
  const ideal = IDEAL_PALETTES[3];
  const swapped = dither.paintForSend(indices, 3, 0x1d);
  // Index 2 (yellow) must be painted RED, and index 3 (red) painted YELLOW,
  // so the panelIcType-blind encoder emits the panel-native codes.
  assert.deepEqual([swapped[8], swapped[9], swapped[10]], ideal[3], 'index 2 painted red');
  assert.deepEqual([swapped[12], swapped[13], swapped[14]], ideal[2], 'index 3 painted yellow');

  const plain = dither.paintForSend(indices, 3, 0x37);
  assert.deepEqual([plain[8], plain[9], plain[10]], ideal[2], 'no swap on other panels');
});

test('toRgbTriples normalises the library palette shape', () => {
  assert.deepEqual(dither.toRgbTriples([{ r: 1, g: 2, b: 3 }]), [[1, 2, 3]]);
  assert.deepEqual(dither.toRgbTriples([[4, 5, 6]]), [[4, 5, 6]]);
});

// --- dither client contract (generation ids, coalescing, asset transfer) ---

class FakeWorker {
  constructor() {
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    FakeWorker.last = this;
  }
  postMessage(msg) {
    this.posted.push(msg);
    // Acknowledge assets the way the real worker does.
    if (msg.type === 'asset') {
      // The real worker echoes the attempt token.
      queueMicrotask(() => this.onmessage({
        data: { type: 'asset-ack', assetId: msg.assetId, attempt: msg.attempt },
      }));
    }
  }
  terminate() { this.terminated = true; }
  renders() { return this.posted.filter((m) => m.type === 'render'); }
  /** Simulate the worker answering a render request. */
  reply(id, extra = {}) {
    const req = this.renders().find((m) => m.id === id);
    this.onmessage({
      data: { type: 'render', id, epoch: req?.epoch ?? 0, ok: true, width: 1, height: 1, ...extra },
    });
  }
}

function clientWithFakeWorker() {
  const results = [];
  const errors = [];
  const originalWorker = globalThis.Worker;
  FakeWorker.last = null; // the worker is lazy; don't inherit a previous test's
  globalThis.Worker = FakeWorker;
  const client = createDitherClient({
    workerUrl: 'about:blank',
    onResult: (m) => results.push(m.id),
    onError: (e) => errors.push(e.message),
  });
  return { client, results, errors, restore: () => { globalThis.Worker = originalWorker; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('only ONE render is in flight; rapid edits coalesce to the newest', () => {
  const { client, results, restore } = clientWithFakeWorker();
  try {
    const a = client.request({ layers: [] }, {});
    const b = client.request({ layers: [] }, {});
    const c = client.request({ layers: [] }, {});
    const w = FakeWorker.last;
    assert.equal(w.renders().length, 1, 'only the first went out');
    assert.equal(client._state().inFlight, a);
    assert.equal(client._state().queued, c, 'the middle request was dropped');
    assert.ok(b < c);

    // A completes while C is still queued: it is SUPERSEDED and must not be
    // shown or become sendable.
    w.reply(a);
    assert.deepEqual(results, [], 'superseded result discarded');
    assert.equal(w.renders().length, 2, 'the queued render was issued');
    w.reply(c);
    assert.deepEqual(results, [c], 'only the newest frame is accepted');
  } finally { restore(); }
});

test('a late duplicate of an older render is discarded', () => {
  const { client, results, restore } = clientWithFakeWorker();
  try {
    const a = client.request({ layers: [] }, {});
    const w = FakeWorker.last;
    w.reply(a);
    const b = client.request({ layers: [] }, {});
    w.reply(b);
    w.reply(a); // straggler
    assert.deepEqual(results, [a, b]);
  } finally { restore(); }
});

test('a device switch TERMINATES the worker so no stale ack or frame survives', async () => {
  const { client, results, restore } = clientWithFakeWorker();
  try {
    await client.addAsset('sha-1', {}, async () => ({ close() {} }));
    await flush();
    const a = client.request({ layers: [{ assetId: 'sha-1' }] }, {});
    const oldWorker = FakeWorker.last;
    assert.equal(client.assetReady('sha-1'), true);

    client.newEpoch();                      // e.g. the composer opened device B
    assert.equal(oldWorker.terminated, true, 'the old worker is torn down');
    assert.equal(client.hasAsset('sha-1'), false,
      'its assets are forgotten, so a stale ack cannot mark them ready');

    // A late result from the dead worker must be ignored entirely.
    oldWorker.onmessage({ data: { type: 'render', id: a, epoch: 0, ok: true, width: 1, height: 1 } });
    assert.deepEqual(results, [], "device A's frame never reaches device B");

    // A late ACK from the dead worker must NOT satisfy anything.
    oldWorker.onmessage({ data: { type: 'asset-ack', assetId: 'sha-1', attempt: 1 } });
    assert.equal(client.assetReady('sha-1'), false, 'stale ack ignored');

    // A late ERROR from the dead worker must not tear down its replacement.
    // And a same-hash asset in the NEW session is re-sent to a fresh worker.
    await client.addAsset('sha-1', {}, async () => ({ close() {} }));
    await flush();
    const freshWorker = FakeWorker.last;
    assert.notEqual(freshWorker, oldWorker, 'a fresh worker was created');

    oldWorker.onerror({ message: 'late failure from the dead worker' });
    assert.equal(freshWorker.terminated, undefined, 'the replacement survives');

    const b = client.request({ layers: [{ assetId: 'sha-1' }] }, {});
    freshWorker.reply(b);
    assert.deepEqual(results, [b]);
  } finally { restore(); }
});

test('a fatal worker error tears the worker down instead of wedging the queue', async () => {
  const { client, results, errors, restore } = clientWithFakeWorker();
  try {
    await client.addAsset('sha-1', {}, async () => ({ close() {} }));
    await flush();
    client.request({ layers: [{ assetId: 'sha-1' }] }, {});
    const dead = FakeWorker.last;

    dead.onerror({ message: 'wasm out of memory' });
    assert.deepEqual(errors, ['wasm out of memory']);
    assert.equal(dead.terminated, true, 'the dead worker is not reused');
    assert.equal(client.hasAsset('sha-1'), false, 'assets must be rehydrated');

    // Recovery: re-send the asset, render on a fresh worker.
    await client.addAsset('sha-1', {}, async () => ({ close() {} }));
    await flush();
    const id = client.request({ layers: [{ assetId: 'sha-1' }] }, {});
    assert.notEqual(FakeWorker.last, dead);
    FakeWorker.last.reply(id);
    assert.deepEqual(results, [id]);
  } finally { restore(); }
});

test('a render WAITS until every referenced asset is acknowledged', async () => {
  const { client, results, restore } = clientWithFakeWorker();
  try {
    const doc = { layers: [{ assetId: 'sha-1' }] };
    const id = client.request(doc, {});
    // The render is held, so no worker has even been constructed yet.
    assert.equal(FakeWorker.last, null, 'render held: the photo is not in the worker yet');
    assert.equal(client._state().queued, id);

    await client.addAsset('sha-1', {}, async () => ({ close() {} }));
    await flush();
    const w = FakeWorker.last;
    assert.equal(w.renders().length, 1, 'render issued once the asset was acknowledged');
    w.reply(id);
    assert.deepEqual(results, [id]);
  } finally { restore(); }
});

test('each asset is transferred exactly once; a failed decode stays retryable', async () => {
  const { client, restore } = clientWithFakeWorker();
  try {
    const decode = async () => ({ close() {} });
    await client.addAsset('sha-1', {}, decode);
    await client.addAsset('sha-1', {}, decode);
    await client.addAsset('sha-2', {}, decode);
    const w = FakeWorker.last;
    assert.deepEqual(
      w.posted.filter((m) => m.type === 'asset').map((m) => m.assetId),
      ['sha-1', 'sha-2'],
    );

    await assert.rejects(
      client.addAsset('sha-3', {}, async () => { throw new Error('decode failed'); }),
      /decode failed/,
    );
    assert.equal(client.hasAsset('sha-3'), false, 'a failed decode can be retried');

    client.newEpoch();
    assert.equal(client.hasAsset('sha-1'), false, 'a new session re-sends its assets');
  } finally { restore(); }
});

test('worker errors surface and do not wedge the queue', () => {
  const { client, results, errors, restore } = clientWithFakeWorker();
  try {
    const a = client.request({ layers: [] }, {});
    const w = FakeWorker.last;
    w.onmessage({ data: { type: 'render', id: a, epoch: 0, ok: false, error: 'wasm exploded' } });
    assert.deepEqual(errors, ['wasm exploded']);
    const b = client.request({ layers: [] }, {});
    w.reply(b);
    assert.deepEqual(results, [b], 'the client kept working after the failure');
  } finally { restore(); }
});

test('a decode finishing after a session switch cannot satisfy the new claim', async () => {
  const { client, restore } = clientWithFakeWorker();
  try {
    // Start a slow decode in session A.
    let releaseA;
    const slowA = client.addAsset('sha-1', {}, () => new Promise((res) => {
      releaseA = () => res({ close() {}, tag: 'A' });
    }));
    assert.equal(client.hasAsset('sha-1'), true, 'A staked its claim');

    client.newEpoch();                       // session B opens
    assert.equal(client.hasAsset('sha-1'), false, "A's claim was cleared");

    // Session B loads the SAME content hash.
    await client.addAsset('sha-1', {}, async () => ({ close() {}, tag: 'B' }));
    await flush();
    assert.equal(client.assetReady('sha-1'), true, "B's asset is ready");
    const bWorker = FakeWorker.last;
    const postedByB = bWorker.posted.filter((m) => m.type === 'asset').length;

    // A's decode finally finishes: it must be discarded, not posted, and must
    // not disturb B's ready claim.
    releaseA();
    await slowA;
    await flush();
    assert.equal(client.assetReady('sha-1'), true, "B's claim survives A's late decode");
    assert.equal(
      bWorker.posted.filter((m) => m.type === 'asset').length, postedByB,
      "A's bitmap was never posted",
    );
  } finally { restore(); }
});

test('a decode FAILING after a session switch does not delete the new claim', async () => {
  const { client, restore } = clientWithFakeWorker();
  try {
    let failA;
    const slowA = client.addAsset('sha-9', {}, () => new Promise((_, rej) => {
      failA = () => rej(new Error('decode aborted'));
    }));
    client.newEpoch();
    await client.addAsset('sha-9', {}, async () => ({ close() {} }));
    await flush();
    assert.equal(client.assetReady('sha-9'), true);

    failA();
    await assert.rejects(slowA, /decode aborted/);
    assert.equal(client.assetReady('sha-9'), true,
      "the new session's asset must survive the old session's failure");
  } finally { restore(); }
});
