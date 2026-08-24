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
  postMessage(msg) { this.posted.push(msg); }
  terminate() { this.terminated = true; }
  /** Simulate the worker answering a render request. */
  reply(id, extra = {}) {
    this.onmessage({ data: { type: 'render', id, ok: true, width: 1, height: 1, ...extra } });
  }
}

function clientWithFakeWorker() {
  const results = [];
  const errors = [];
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  const client = createDitherClient({
    workerUrl: 'about:blank',
    onResult: (m) => results.push(m.id),
    onError: (e) => errors.push(e.message),
  });
  return { client, results, errors, restore: () => { globalThis.Worker = originalWorker; } };
}

test('only ONE render is in flight; rapid edits coalesce to the newest', () => {
  const { client, results, restore } = clientWithFakeWorker();
  try {
    const a = client.request({ d: 1 }, {});
    const b = client.request({ d: 2 }, {});
    const c = client.request({ d: 3 }, {});
    const w = FakeWorker.last;
    // Only the first went out; b and c collapsed into one pending request.
    assert.equal(w.posted.filter((m) => m.type === 'render').length, 1);
    assert.equal(client._state().inFlight, a);
    assert.equal(client._state().queued, c, 'the middle request was dropped');

    w.reply(a);
    assert.deepEqual(results, [a]);
    assert.equal(w.posted.filter((m) => m.type === 'render').length, 2, 'queued request sent');
    w.reply(c);
    assert.deepEqual(results, [a, c], 'b never produced a result');
    assert.equal(b < c, true);
  } finally { restore(); }
});

test('a stale result arriving after a newer one is discarded', () => {
  const { client, results, restore } = clientWithFakeWorker();
  try {
    const a = client.request({}, {});
    const w = FakeWorker.last;
    w.reply(a);
    const b = client.request({}, {});
    w.reply(b);
    // A late duplicate of the older render must not overwrite the newer frame.
    w.reply(a);
    assert.deepEqual(results, [a, b]);
  } finally { restore(); }
});

test('each asset is transferred to the worker exactly once', async () => {
  const { client, restore } = clientWithFakeWorker();
  try {
    const decode = async () => ({ close() {} });
    await client.addAsset('sha-1', {}, decode);
    await client.addAsset('sha-1', {}, decode);
    await client.addAsset('sha-2', {}, decode);
    const w = FakeWorker.last;
    const assetMsgs = w.posted.filter((m) => m.type === 'asset');
    assert.deepEqual(assetMsgs.map((m) => m.assetId), ['sha-1', 'sha-2']);
    assert.equal(client.hasAsset('sha-1'), true);
    client.dropAssets([]);
    assert.equal(client.hasAsset('sha-1'), false, 'dropped so a new document re-sends');
  } finally { restore(); }
});

test('worker errors surface and do not wedge the queue', () => {
  const { client, results, errors, restore } = clientWithFakeWorker();
  try {
    const a = client.request({}, {});
    const w = FakeWorker.last;
    w.onmessage({ data: { type: 'render', id: a, ok: false, error: 'wasm exploded' } });
    assert.deepEqual(errors, ['wasm exploded']);
    const b = client.request({}, {});
    w.reply(b);
    assert.deepEqual(results, [b], 'the client kept working after the failure');
  } finally { restore(); }
});
