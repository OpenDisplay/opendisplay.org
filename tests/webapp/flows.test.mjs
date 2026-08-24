// Controller-flow tests: the REAL flows.js driven with injected mocks —
// the plan §4/§5 sequences (selection → stored-key → validation → commit) and
// every rollback branch, headlessly (no Web Bluetooth chooser needed).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const flowsSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../httpdocs/app/v1/js/flows.js'),
  'utf8',
);
const { makeFlows } = await import(
  `data:text/javascript;base64,${Buffer.from(flowsSource).toString('base64')}`
);

const INFO = {
  name: 'OD-X', width: 800, height: 480, rotationQuarterTurns: 1,
  colorScheme: 4, transmissionModes: 0x13, partialUpdateSupport: 0,
  panelIcType: 35, firmware: '2.3.1', msdHex: null, authRequired: false,
  authKey: null, authKeyFromProvider: false,
};

function makeDeps({ info = INFO, records = [], storedKeys = {}, readInfoImpl } = {}) {
  const calls = [];
  let keyProviderFn = null;
  const deps = {
    calls,
    adapter: {
      setKeyProvider: (fn) => { keyProviderFn = fn; },
      getKeyProvider: () => keyProviderFn,
      connectViaChooser: async () => calls.push('chooser'),
      connectCached: async (h) => calls.push(['cached', h.id]),
      connectedBleId: () => 'ble-NEW',
      disconnect: async () => calls.push('disconnect'),
      readDeviceInfo: readInfoImpl ?? (async ({ storedKey } = {}) => {
        calls.push(['readInfo', storedKey ? Array.from(storedKey.slice(0, 1)) : null]);
        return info;
      }),
    },
    store: {
      listDevices: async () => records,
      updateDevice: async (id, patch) => calls.push(['update', id, patch.bleId]),
      commitRebind: async (id, bleId, patch) => calls.push(['commit', id, bleId, patch.name]),
      createDevice: async (fields) => {
        calls.push(['create', fields.bleId]);
        return { recordId: 'new-rec', ...fields };
      },
      forgetDevice: async (id) => calls.push(['forget', id]),
    },
    keys: {
      getKey: async (id) => storedKeys[id] ?? null,
      saveKey: async (id, k) => calls.push(['saveKey', id, k[0]]),
      exportKeyHex: async () => 'ab'.repeat(16),
      markExported: async (id) => calls.push(['markExported', id]),
    },
    ui: {
      askForKey: async () => null,
      askRebind: async () => null,
      confirmMismatch: async () => false,
      deliverKeyHex: async () => false,
      toast: () => {},
    },
  };
  return deps;
}

const REC = {
  recordId: 'rec-1', bleId: 'ble-OLD', name: 'OD-Saved',
  width: 800, height: 480, colorScheme: 4,
};

test('repair: card selection allows stored key; validation precedes one commit', async () => {
  const deps = makeDeps({ storedKeys: { 'rec-1': new Uint8Array(16).fill(0x11) } });
  const flows = makeFlows(deps);
  await flows.connectRecordFlow(REC, new Map()); // no handle -> repair path
  const names = deps.calls.map((c) => Array.isArray(c) ? c[0] : c);
  // Order: chooser connect, readInfo WITH the stored key, then the commit.
  assert.deepEqual(names, ['chooser', 'readInfo', 'commit']);
  const read = deps.calls.find((c) => c[0] === 'readInfo');
  assert.deepEqual(read[1], [0x11], 'stored key auto-tried — record was user-selected');
  const commit = deps.calls.find((c) => c[0] === 'commit');
  assert.deepEqual(commit.slice(1), ['rec-1', 'ble-NEW', 'OD-X']);
});

test('repair rollback: validation failure -> no store write, disconnect', async () => {
  const deps = makeDeps({
    readInfoImpl: async () => { throw new Error('Authentication failed'); },
  });
  const flows = makeFlows(deps);
  await assert.rejects(flows.connectRecordFlow(REC, new Map()), /Authentication failed/);
  const names = deps.calls.map((c) => Array.isArray(c) ? c[0] : c);
  assert.ok(!names.includes('commit') && !names.includes('update') && !names.includes('create'),
    `no store writes: ${JSON.stringify(names)}`);
  assert.ok(names.includes('disconnect'));
});

test('repair mismatch declined -> no commit, disconnect', async () => {
  const deps = makeDeps({ info: { ...INFO, width: 122, height: 250 } });
  const flows = makeFlows(deps);
  await assert.rejects(flows.connectRecordFlow(REC, new Map()), /Re-pair cancelled/);
  const names = deps.calls.map((c) => Array.isArray(c) ? c[0] : c);
  assert.ok(!names.includes('commit'));
  assert.ok(names.includes('disconnect'));
});

test('repair mismatch accepted -> commit carries validated values', async () => {
  const deps = makeDeps({ info: { ...INFO, width: 122, height: 250 } });
  deps.ui.confirmMismatch = async ({ record, info }) => {
    assert.equal(record.recordId, 'rec-1');
    assert.equal(info.width, 122); // validated metadata presented
    return true;
  };
  const flows = makeFlows(deps);
  await flows.connectRecordFlow(REC, new Map());
  assert.ok(deps.calls.some((c) => c[0] === 'commit'));
});

test('cached connect: confirmed binding, stored key auto-tried, update not rebind', async () => {
  const deps = makeDeps({ storedKeys: { 'rec-1': new Uint8Array(16).fill(0x22) } });
  const flows = makeFlows(deps);
  await flows.connectRecordFlow(REC, new Map([['ble-OLD', { id: 'ble-OLD' }]]));
  const names = deps.calls.map((c) => Array.isArray(c) ? c[0] : c);
  assert.deepEqual(names, ['cached', 'readInfo', 'update']);
});

test('cached connect failure -> disconnect, no store write', async () => {
  const deps = makeDeps({ readInfoImpl: async () => { throw new Error('timed out'); } });
  const flows = makeFlows(deps);
  await assert.rejects(
    flows.connectRecordFlow(REC, new Map([['ble-OLD', { id: 'ble-OLD' }]])),
    /timed out/,
  );
  const names = deps.calls.map((c) => Array.isArray(c) ? c[0] : c);
  assert.ok(!names.includes('update'));
  assert.ok(names.includes('disconnect'));
});

test('addDevice: rebind proposal AFTER validation with info shown; accept commits; dialog key saved after success', async () => {
  const candidate = { recordId: 'rec-9', bleId: null, name: 'OD-Lost', width: 800, height: 480 };
  const deps = makeDeps({
    records: [candidate],
    readInfoImpl: async () => {
      // Locked device: the flow's armed provider supplies the key mid-read.
      const provider = deps.adapter.getKeyProvider();
      const key = await provider({ name: 'OD-X' });
      deps.calls.push(['gotKeyFromDialog', key[0]]);
      return { ...INFO, authRequired: true };
    },
  });
  deps.ui.askForKey = async () => ({ key: new Uint8Array(16).fill(0x33), save: true });
  deps.ui.askRebind = async ({ info, candidates }) => {
    assert.equal(info.width, 800, 'validated metadata passed to the dialog');
    return candidates[0].recordId;
  };
  const flows = makeFlows(deps);
  const rid = await flows.addDeviceFlow(new Map());
  assert.equal(rid, 'rec-9');
  const names = deps.calls.map((c) => Array.isArray(c) ? c[0] : c);
  const commitIdx = names.indexOf('commit');
  const saveIdx = names.indexOf('saveKey');
  assert.ok(commitIdx !== -1 && saveIdx !== -1 && saveIdx > commitIdx,
    `key saved only after successful commit: ${JSON.stringify(names)}`);
  assert.deepEqual(deps.calls[saveIdx], ['saveKey', 'rec-9', 0x33]);
});

test('addDevice: candidate stored keys are NEVER auto-tried on the generic path', async () => {
  const candidate = { recordId: 'rec-9', bleId: null, name: 'OD-Lost', width: 800, height: 480 };
  const deps = makeDeps({ records: [candidate], storedKeys: { 'rec-9': new Uint8Array(16).fill(0x44) } });
  const flows = makeFlows(deps);
  await flows.addDeviceFlow(new Map());
  const read = deps.calls.find((c) => c[0] === 'readInfo');
  assert.equal(read[1], null, 'readDeviceInfo called with NO stored key');
});

test('addDevice failure -> disconnect, no store writes, no key saved', async () => {
  const deps = makeDeps({ readInfoImpl: async () => { throw new Error('Config read failed'); } });
  deps.ui.askForKey = async () => ({ key: new Uint8Array(16).fill(0x55), save: true });
  const flows = makeFlows(deps);
  await assert.rejects(flows.addDeviceFlow(new Map()), /Config read failed/);
  const names = deps.calls.map((c) => Array.isArray(c) ? c[0] : c);
  assert.ok(!names.some((n) => ['create', 'commit', 'update', 'saveKey'].includes(n)));
  assert.ok(names.includes('disconnect'));
});

test('export flow: cancelled delivery does NOT mark exported', async () => {
  const deps = makeDeps();
  deps.ui.deliverKeyHex = async () => false;
  const flows = makeFlows(deps);
  const delivered = await flows.exportKeyFlow(REC);
  assert.equal(delivered, false);
  assert.ok(!deps.calls.some((c) => c[0] === 'markExported'));
});

test('export flow: confirmed delivery marks exported', async () => {
  const deps = makeDeps();
  deps.ui.deliverKeyHex = async () => true;
  const flows = makeFlows(deps);
  const delivered = await flows.exportKeyFlow(REC);
  assert.equal(delivered, true);
  assert.deepEqual(deps.calls.at(-1), ['markExported', 'rec-1']);
});

beforeEach(() => {});
