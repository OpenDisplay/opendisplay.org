// Drives the Toolbox glue (httpdocs/js/toolbox-v3.js) with a stub DOM and a fake device, so the
// migration and backup flows run end to end without a browser. The real Toolbox page (index.html)
// is NOT loaded here: collectPacketBytes / parseRawBytes are simple stand-ins.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const V3 = require('../httpdocs/js/od-v3.js');

const ROOT = path.join(__dirname, '..', 'httpdocs');
const presets = JSON.parse(fs.readFileSync(path.join(ROOT, 'firmware', 'toolbox', 'simple-config-presets.json'), 'utf8'));
const drive = JSON.parse(fs.readFileSync(path.join(ROOT, 'firmware', 'toolbox', 'drive-presets.json'), 'utf8'));
const SIZES = { 1: 22, 2: 22, 32: 46, 38: 160, 39: 64 };
const schema = { packet_types: Object.fromEntries(Object.entries(SIZES).map(([k, n]) => [k, { fields: [{ name: 'body', size: String(n) }] }])) };

function el() {
  const kids = new Map();
  const e = {
    hidden: false, textContent: '', innerHTML: '', value: '', disabled: false, title: '', dataset: {}, options: [], selectedOptions: [],
    className: '', id: '', onclick: null, onsubmit: null, oncancel: null, open: false,
    setAttribute() {}, appendChild(c) { return c; }, remove() {}, click() {},
    querySelector(sel) { if (!kids.has(sel)) kids.set(sel, el()); return kids.get(sel); },
    showModal() { this.open = true; e._onShow && e._onShow(e); },
    close() { this.open = false; }
  };
  return e;
}

// `answer`: 'ok' | 'cancel', or an array with one answer per dialog in order.
// `identTarget`: READ_IDENT fw_target byte (6 = not a fw_target value, so the chip decides).
function makeWorld({ packets, answer = 'ok', pick = null, firmware = '3.0.0', identFlags = null, identTarget = 6, driveDoc = drive }) {
  const byId = new Map();
  const asked = [];
  const document = {
    readyState: 'complete',
    getElementById(id) { if (id === 'tbMigrateDialog') return null; if (!byId.has(id)) byId.set(id, el()); return byId.get(id); },
    createElement() {
      const d = el();
      d._onShow = (dlg) => {
        const n = asked.length;
        asked.push({ title: dlg.querySelector('#tbMigrateTitle').textContent, ok: dlg.querySelector('#tbMigrateOk').textContent, lines: [] });
        const a = Array.isArray(answer) ? answer[n] : answer;
        setImmediate(() => {
          if (a === 'ok') dlg.querySelector('#tbMigrateForm').onsubmit({ preventDefault() {} });
          else dlg.querySelector('#tbMigrateCancel').onclick();
        });
      };
      return d;
    },
    body: { appendChild() {} },
    addEventListener() {}
  };
  // The fake device stores whatever is written.
  let stored = null;
  const writes = [];
  const bleLib = {
    isConnected: true,
    async readIdent() { return identFlags == null && identTarget === 6 ? null : Uint8Array.from([0, 0x46, 4, identTarget, 0, ...(identFlags == null ? [] : [identFlags])]); },
    async writeConfig(b) { stored = Uint8Array.from(b); writes.push(stored); },
    readConfig(cb) { setImmediate(() => cb(stored, null)); },
    delay: () => Promise.resolve()
  };
  const logs = [], flashes = [];
  const ctx = {
    OpenDisplayV3: V3, document, console, setTimeout, setImmediate, clearTimeout, URL, Blob: class {},
    fetch: async () => ({ ok: true, json: async () => driveDoc }),
    bleLib, schema, tbFirmwareVersion: firmware, tbMode: 'setup', tbScreen: 'home',
    instances: { packets },
    simpleConfigPresets: presets, simpleConfigSelections: { driverBoard: null, display: null },
    addLog: (m, k) => logs.push([k, m]), tbFlash: m => flashes.push(m),
    toolboxDeviceName: () => 'OD123456', isAuthError: () => false, ensureAuthenticatedOnDemand: async () => {},
    connectToBleDevice: async () => {}, renderEditor() {}, editorMarkClean() {},
    parseRawBytes() {},
    collectPacketBytes() {
      const out = [0, 0, 1];
      let n = 0;
      const sorted = ctx.instances.packets.slice().sort((a, b) => Number(a.pid) - Number(b.pid));
      for (const p of sorted) {
        out.push(n++ & 0xff, Number(p.pid));
        if (p.raw != null) { const b = V3.hexToBytes(p.raw); out.push(b.length & 0xff, b.length >> 8, ...b); }
        else if (p.rawLegacy != null) out.push(...V3.hexToBytes(p.rawLegacy));
        else out.push(...new Array(SIZES[p.pid]).fill(0));
      }
      const total = out.length + 2;
      out[0] = total & 0xff; out[1] = total >> 8;
      const b = Uint8Array.from([...out, 0, 0]);
      const crc = V3.outerCrc(b);
      b[b.length - 2] = crc & 0xff; b[b.length - 1] = crc >> 8;
      return Array.from(b);
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'toolbox-v3.js'), 'utf8') + '\n;this.__api = { tbMigrateIfNeeded, tbLoadDriveDb, tbCheckConfigSize, tbTargetGeneration, tbTargetClassInfo, tbAssertConfigFits, get db() { return tbDriveDb; } };', ctx);
  return { ctx, api: ctx.__api, asked, writes, logs, flashes, get stored() { return stored; } };
}

const carried = (panel = '0x1e', ic = '0x6') => [
  { uid: 'a', pid: '1', fields: { ic_type: ic } },
  { uid: 'b', pid: '2', fields: {} },
  { uid: 'c', pid: '32', fields: { panel_ic_type: panel, pixel_width: '0xa8', pixel_height: '0x180' } },
  { uid: 'd', pid: '38', fields: { ssid: 'home' } },
  { uid: 'e', pid: '39', fields: { encryption_key: 'ab'.repeat(16) } },
  { uid: 'f', pid: '46', rawLegacy: '00'.repeat(157), fields: {} }
];

test('3.x device with a 2.x config: confirmed migration writes, reads back and keeps the rest', async () => {
  const w = makeWorld({ packets: carried() });
  const r = await w.api.tbMigrateIfNeeded();
  assert.equal(r, 'done');
  assert.equal(w.writes.length, 1);
  const walked = V3.walkConfig(w.stored, id => SIZES[id] ?? null);
  const ids = walked.packets.map(p => p.id);
  for (const id of [1, 2, 32, 38, 39, 0xb1, 0xae, 0xaf, 0xb0]) assert.ok(ids.includes(id), 'has ' + id);
  assert.ok(!ids.includes(0x2e), 'burned packet removed');
  assert.equal(w.asked.length, 1);
});

test('declining writes nothing', async () => {
  const w = makeWorld({ packets: carried(), answer: 'cancel' });
  assert.equal(await w.api.tbMigrateIfNeeded(), 'declined');
  assert.equal(w.writes.length, 0);
});

const driveOf = (bytes) => V3.walkConfig(bytes, id => SIZES[id] ?? null).packets
  .filter(p => p.id >= 0xae && p.id <= 0xb1).map(p => p.body).sort();
const bodies = (list) => list.map(p => p.body_hex).sort();

// No shipped panel is blocked on any class since schema_minor 2: a fixture blocks 0x0002 on BG22.
const p2 = drive.panels['0x0002'];
const bg22Blocked = Object.assign({}, drive, { panels: Object.assign({}, drive.panels, { '0x0002': Object.assign({}, p2, {
  targets: { default: p2.targets.default, bg22: { status: 'blocked', verified: 'untested', blocked_on: ['WINDOW'], packets: [] } }
}) }) });

test('blocked panel: informs, writes nothing', async () => {
  const w = makeWorld({ packets: carried('0x2'), driveDoc: bg22Blocked });
  assert.equal(await w.api.tbMigrateIfNeeded(), 'blocked');
  assert.equal(w.writes.length, 0);
  assert.equal(w.asked.length, 1);
  assert.match(w.asked[0].title, /can.t be driven/);
  // The same data on an ESP32 migrates.
  const esp = makeWorld({ packets: carried('0x2', '0x2'), driveDoc: bg22Blocked });
  assert.equal(await esp.api.tbMigrateIfNeeded(), 'done');
  assert.deepEqual(driveOf(esp.stored), bodies(p2.targets.default.packets));
});

test('BG22 + a formerly BG22-blocked panel (ep154): migrates with the bg22-class packets', async () => {
  const w = makeWorld({ packets: carried('14') });
  assert.equal(await w.api.tbMigrateIfNeeded(), 'done');
  assert.equal(w.writes.length, 1);
  assert.deepEqual(driveOf(w.stored), bodies(drive.panels['0x000E'].targets.bg22.packets));
});

test('BG22 + available panel: bg22-class packets; ESP32: default packets; READ_IDENT target wins over an unknown chip', async () => {
  const bg = makeWorld({ packets: carried('0x2') });
  assert.equal(bg.api.tbTargetClassInfo().cls, 'bg22');
  assert.equal(await bg.api.tbMigrateIfNeeded(), 'done');
  assert.deepEqual(driveOf(bg.stored), bodies(drive.panels['0x0002'].targets.bg22.packets));
  const esp = makeWorld({ packets: carried('0x2', '0x2') });
  assert.equal(await esp.api.tbMigrateIfNeeded(), 'done');
  assert.equal(esp.api.tbTargetClassInfo().cls, 'default');
  assert.deepEqual(driveOf(esp.stored), bodies(drive.panels['0x0002'].targets.default.packets));
  // Chip unknown (ic_type 0): unknown -> restrictive; READ_IDENT 0x03 / 0x01 decide when present.
  const unk = makeWorld({ packets: carried('0x2', '0x0') });
  assert.equal(await unk.api.tbMigrateIfNeeded(), 'done');
  assert.deepEqual(unk.api.tbTargetClassInfo(), { cls: 'bg22', how: 'unknown', restrictive: true });
  assert.deepEqual(driveOf(unk.stored), bodies(drive.panels['0x0002'].targets.bg22.packets));
  const id1 = makeWorld({ packets: carried('0x2', '0x0'), identTarget: 0x01 });
  assert.equal(await id1.api.tbMigrateIfNeeded(), 'done');
  assert.deepEqual(driveOf(id1.stored), bodies(drive.panels['0x0002'].targets.default.packets));
});

test('pre-write gate: default-class drive data is never written to a BG22', async () => {
  const pk = carried('0x2').filter(p => p.pid !== '46')
    .concat(drive.panels['0x0002'].packets.map((p, i) => ({ uid: 'x' + i, pid: String(p.id), raw: p.body_hex, fields: {} })));
  const w = makeWorld({ packets: pk });
  await w.api.tbLoadDriveDb();
  assert.throws(() => w.api.tbAssertConfigFits(new Uint8Array(100)), /does not run on this device \(EFR32BG22\).*WINDOW\/FILL/);
  const esp = makeWorld({ packets: pk.map(p => p.pid === '1' ? Object.assign({}, p, { fields: { ic_type: '0x2' } }) : p) });
  assert.doesNotThrow(() => esp.api.tbAssertConfigFits(new Uint8Array(100)));
  // And the migration on connect replaces the stored default-class data with the bg22 view.
  assert.equal(await w.api.tbMigrateIfNeeded(), 'done');
  assert.deepEqual(driveOf(w.stored), bodies(drive.panels['0x0002'].targets.bg22.packets));
});

test('2.x device: no dialog, no write', async () => {
  const w = makeWorld({ packets: carried(), firmware: '2.27.1' });
  assert.equal(await w.api.tbMigrateIfNeeded(), 'none');
  assert.equal(w.asked.length, 0);
});

test('3.x device that already has drive data: nothing to do unless READ_IDENT says so', async () => {
  const w = makeWorld({ packets: carried() });
  await w.api.tbMigrateIfNeeded();
  const migrated = w.ctx.instances.packets;
  const w2 = makeWorld({ packets: migrated });
  assert.equal(await w2.api.tbMigrateIfNeeded(), 'none');
  const w3 = makeWorld({ packets: migrated, identFlags: 0x03 });
  assert.equal(await w3.api.tbMigrateIfNeeded(), 'done');
});

test('size gate follows the connected device', async () => {
  const w = makeWorld({ packets: carried() });
  assert.equal(w.api.tbTargetGeneration(), 'v3');
  assert.equal(w.api.tbCheckConfigSize(3121).ok, false);
  assert.equal(w.api.tbCheckConfigSize(3120).ok, true);
  const w2 = makeWorld({ packets: carried(), firmware: '2.3.0' });
  assert.equal(w2.api.tbCheckConfigSize(2049).ok, false);
});
