// Unit tests for the REAL app modules: httpdocs/app/v1/js/ble-adapter.js and
// boot-bridge.js, run against the real ble-common.js (vm sandbox) and the real
// config.yaml (sandbox fetch serves httpdocs files). Covers the M0 invariants:
// instance-scoped readiness, dedup, failed-load retry, renewal isolation, and
// the pinned auto-reconnect flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadBootBridge,
  setSandboxFetchMode,
} from './lib/load-ble-common.mjs';

// Wire the sandbox bridge into THIS realm's globals, exactly as the page does,
// then import the real adapter module.
const { bridge, currentInstance } = loadBootBridge();
globalThis.odAppBridge = bridge;
Object.defineProperty(globalThis, 'odAppBle', {
  configurable: true,
  get: () => currentInstance(),
});

// The app uses .js module files (browser MIME safety, plan §2); Node maps bare
// .js to CJS, so import the REAL source via a data: URL instead of copying it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const adapterSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../httpdocs/app/v1/js/ble-adapter.js'),
  'utf8',
);
const adapter = await import(
  `data:text/javascript;base64,${Buffer.from(adapterSource).toString('base64')}`
);

test('ready(): validates the real schema (display packet, sizes, field offsets)', async () => {
  await adapter.ready();
  const inst = currentInstance();
  assert.ok(inst.packetSchema[0x20], 'display packet parsed');
  assert.ok(inst.packetSizes[0x20] > 0, 'display packet size cached');
  for (const f of [
    'pixel_width',
    'pixel_height',
    'rotation',
    'color_scheme',
    'transmission_modes',
    'partial_update_support',
    'panel_ic_type',
  ]) {
    assert.equal(typeof inst.packetFieldOffsets[0x20][f], 'number', `offset for ${f}`);
  }
});

test('ready(): repeated calls dedupe to one in-flight init per instance', async () => {
  const p1 = adapter.ready();
  const p2 = adapter.ready();
  assert.equal(p1, p2, 'same promise returned');
  await p1;
});

test('ready(): failed schema load is NOT cached — retry succeeds', async () => {
  bridge.renew(); // fresh instance with no readiness yet
  setSandboxFetchMode('fail');
  await assert.rejects(adapter.ready(), /schema failed to load|lacks required/i);
  setSandboxFetchMode('httpdocs');
  await adapter.ready(); // must retry, not replay the cached rejection
  assert.ok(currentInstance().packetSchema[0x20]);
});

test('renew(): fresh instance with its own readiness; old instance discarded', async () => {
  await adapter.ready();
  const before = currentInstance();
  await adapter.renew();
  const after = currentInstance();
  assert.notEqual(before, after, 'bridge produced a fresh instance');
  assert.ok(after.packetSchema[0x20], 'fresh instance schema-ready');
  // Fresh per-connection state — nothing carried over from `before`.
  assert.notEqual(before.encryptionSession, after.encryptionSession);
});

test('bridge pins autoReconnectEnabled false against library re-enables', () => {
  const inst = currentInstance();
  assert.equal(inst.autoReconnectEnabled, false);
  // ble-common's connect()/_doConnectToGATT() assign true; the pin must hold.
  inst.autoReconnectEnabled = true;
  assert.equal(inst.autoReconnectEnabled, false, 'library write is inert');
});

test('adapter resolves the instance per call, never captures it', async () => {
  await adapter.ready();
  const first = currentInstance();
  await adapter.renew();
  // A ready() call after renew must operate on the NEW instance: its promise
  // is keyed on the new instance, not the captured old one.
  await adapter.ready();
  assert.notEqual(currentInstance(), first);
  assert.ok(currentInstance().packetSchema[0x20]);
});
