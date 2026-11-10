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

function makeWorld({ packets, answer = 'ok', pick = null, firmware = '3.0.0', identFlags = null }) {
  const byId = new Map();
  const asked = [];
  const document = {
    readyState: 'complete',
    getElementById(id) { if (id === 'tbMigrateDialog') return null; if (!byId.has(id)) byId.set(id, el()); return byId.get(id); },
    createElement() {
      const d = el();
      d._onShow = (dlg) => {
        asked.push({ title: dlg.querySelector('#tbMigrateTitle').textContent, lines: [] });
        setImmediate(() => {
          if (answer === 'ok') dlg.querySelector('#tbMigrateForm').onsubmit({ preventDefault() {} });
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
    async readIdent() { return identFlags == null ? null : Uint8Array.from([0, 0x46, 4, 6, 0, identFlags]); },
    async writeConfig(b) { stored = Uint8Array.from(b); writes.push(stored); },
    readConfig(cb) { setImmediate(() => cb(stored, null)); },
    delay: () => Promise.resolve()
  };
  const logs = [], flashes = [];
  const ctx = {
    OpenDisplayV3: V3, document, console, setTimeout, setImmediate, clearTimeout, URL, Blob: class {},
    fetch: async () => ({ ok: true, json: async () => drive }),
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
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'toolbox-v3.js'), 'utf8') + '\n;this.__api = { tbMigrateIfNeeded, tbLoadDriveDb, tbCheckConfigSize, tbTargetGeneration, get db() { return tbDriveDb; } };', ctx);
  return { ctx, api: ctx.__api, asked, writes, logs, flashes, get stored() { return stored; } };
}

const carried = (panel = '0x1e') => [
  { uid: 'a', pid: '1', fields: { ic_type: '0x6' } },
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

test('blocked panel: informs, writes nothing', async () => {
  const w = makeWorld({ packets: carried('14') });
  assert.equal(await w.api.tbMigrateIfNeeded(), 'blocked');
  assert.equal(w.writes.length, 0);
  assert.match(w.asked[0].title, /can.t be driven/);
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
