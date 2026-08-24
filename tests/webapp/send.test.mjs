// Send-preparation tests: the exact interleavings that could put one
// composition on another tag's panel. Uses the REAL send.js with injected
// dependencies, so the switch-during-await races are reproducible headlessly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppModule } from './lib/load-app-module.mjs';

const { prepareSend, panelSignature, SendAbortedError } = await loadAppModule('composer/send.js');

// TWO IDENTICAL TAGS: same panel, same scheme, same rotation — so their frames
// share a signature and only object identity can tell the compositions apart.
const PANEL = { width: 800, height: 480, rotationQuarterTurns: 0, colorScheme: 4, panelIcType: 35 };
const RECORD_A = { recordId: 'rec-A', bleId: 'ble-A', ...PANEL };
const RECORD_B = { recordId: 'rec-B', bleId: 'ble-B', ...PANEL };

function fakeSession(gen = 0) {
  return { generation: () => gen };
}

function frameFor(panel = PANEL) {
  return { signature: panelSignature(panel), indices: new Uint8Array(4) };
}

function harness({ devices = [RECORD_A, RECORD_B], connected = 'ble-A', delayMs = 0 } = {}) {
  const state = { session: fakeSession(), frame: frameFor(), connected };
  return {
    state,
    deps: (owner, frame) => ({
      owner,
      ownerGen: owner.generation(),
      frame,
      record: devices[0],
      currentSession: () => state.session,
      currentFrame: () => state.frame,
      getDevice: async (id) => {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        return devices.find((d) => d.recordId === id);
      },
      connectedBleId: () => state.connected,
    }),
  };
}

test('happy path returns the FRESH record, not the captured copy', async () => {
  const stale = { ...RECORD_A, name: 'old name', firmwareVersion: '1.0' };
  const fresh = { ...RECORD_A, name: 'new name', firmwareVersion: '2.3' };
  const owner = fakeSession();
  const frame = frameFor();
  const { record } = await prepareSend({
    owner, ownerGen: 0, frame, record: stale,
    currentSession: () => owner,
    currentFrame: () => frame,
    getDevice: async () => fresh,
    connectedBleId: () => 'ble-A',
  });
  assert.equal(record.firmwareVersion, '2.3', 'the re-read record is used');
});

test('switching to an IDENTICALLY-SPECCED device mid-await aborts the send', async () => {
  const h = harness({ delayMs: 10 });
  const owner = h.state.session;
  const frame = h.state.frame;
  const p = prepareSend(h.deps(owner, frame));

  // While getDevice is in flight, the user opens device B's composer: a new
  // session and a new frame — whose signature is IDENTICAL.
  h.state.session = fakeSession();
  h.state.frame = frameFor();
  assert.equal(h.state.frame.signature, frame.signature, 'signatures cannot distinguish them');

  await assert.rejects(p, (err) => {
    assert.ok(err instanceof SendAbortedError);
    assert.match(err.message, /changed while preparing to send/);
    return true;
  });
});

test('an edit that replaces the frame mid-await aborts the send', async () => {
  const h = harness({ delayMs: 10 });
  const owner = h.state.session;
  const frame = h.state.frame;
  const p = prepareSend(h.deps(owner, frame));
  // Same session, but the document changed so a NEW frame was produced.
  h.state.frame = frameFor();
  await assert.rejects(p, /changed while preparing to send/);
});

test('a session released mid-await (generation bump) aborts the send', async () => {
  const h = harness({ delayMs: 10 });
  let gen = 0;
  const owner = { generation: () => gen };
  h.state.session = owner;
  const frame = h.state.frame;
  const p = prepareSend(h.deps(owner, frame));
  gen = 1; // release() bumps the generation
  await assert.rejects(p, /changed while preparing to send/);
});

test('sending to a device that is no longer connected is refused', async () => {
  const h = harness();
  h.state.connected = 'ble-B'; // the user connected the OTHER tag
  await assert.rejects(
    prepareSend(h.deps(h.state.session, h.state.frame)),
    /not the one this composition is for/,
  );
});

test('a forgotten device is refused', async () => {
  const owner = fakeSession();
  const frame = frameFor();
  await assert.rejects(
    prepareSend({
      owner, ownerGen: 0, frame, record: RECORD_A,
      currentSession: () => owner,
      currentFrame: () => frame,
      getDevice: async () => undefined,
      connectedBleId: () => 'ble-A',
    }),
    /no longer saved/,
  );
});

test('a frame rendered for a different panel spec is refused', async () => {
  const owner = fakeSession();
  // The record was rebound to a smaller mono panel after this frame rendered.
  const frame = frameFor(PANEL);
  const rebound = { ...RECORD_A, width: 122, height: 250, colorScheme: 0 };
  await assert.rejects(
    prepareSend({
      owner, ownerGen: 0, frame, record: RECORD_A,
      currentSession: () => owner,
      currentFrame: () => frame,
      getDevice: async () => rebound,
      connectedBleId: () => 'ble-A',
    }),
    /panel changed since this preview/,
  );
});

test('panelSignature distinguishes every field that changes the wire format', () => {
  const base = panelSignature(PANEL);
  assert.notEqual(base, panelSignature({ ...PANEL, width: 801 }));
  assert.notEqual(base, panelSignature({ ...PANEL, height: 481 }));
  assert.notEqual(base, panelSignature({ ...PANEL, rotationQuarterTurns: 1 }));
  assert.notEqual(base, panelSignature({ ...PANEL, colorScheme: 0 }));
  assert.notEqual(base, panelSignature({ ...PANEL, panelIcType: 0x1d }),
    'panel IC matters: it drives the BWRY paint swap and the gray LUT');
});
