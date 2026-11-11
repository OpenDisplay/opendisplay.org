// Drives httpdocs/js/toolbox-sec2.js with a stub DOM, the real ble-common.js and the reference
// SEC2 device behind a fake GATT characteristic: the connect hook, the wizard (verify panel,
// typed code), rotation of a migrated key and its opt-out, the client-side secret refusal with
// "write without them now", the SHOW_KEY confirmation, and ?key= removal. No browser, no radio.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const S = require('../httpdocs/js/od-sec2.js');
const P = require('../httpdocs/js/od-sec2-policy.js');
const { RefDevice } = require('./helpers/sec2-refdevice.js');

const JS = path.join(__dirname, '..', 'httpdocs', 'js');
const NAME = 'OD1A2B3C';

function el(tag) {
  const e = {
    tag, children: [], parentNode: null, dataset: {}, textContent: '', value: '', checked: false, type: '', className: '',
    id: '', style: {}, onclick: null, onchange: null, oncancel: null, open: false,
    appendChild(c) { c.parentNode = e; e.children.push(c); return c; },
    remove() { if (e.parentNode) e.parentNode.children = e.parentNode.children.filter(x => x !== e); },
    setAttribute(k, v) { e[k] = v; }, focus() {}, click() { e.clicked = true; },
    showModal() { e.open = true; if (e._onShow) e._onShow(e); }, close() { e.open = false; },
    all() { return [e].concat(...e.children.map(c => c.all())); },
    text() { return e.all().map(x => x.textContent).filter(Boolean).join(' | '); }
  };
  return e;
}

/**
 * answers: list of functions (dialog, world) -> {button, value?, checked?}; one per dialog in order.
 */
function world({ dev, answers = [], href = 'https://opendisplay.org/firmware/toolbox/', v1Keys = {} }) {
  const shown = [];
  const flashes = [];
  const logs = [];
  const byId = new Map();
  const body = el('body');
  const document = {
    body, documentElement: body,
    getElementById(id) { return byId.get(id) || body.all().find(x => x.id === id) || null; },
    createElement(tag) {
      const d = el(tag);
      if (tag === 'dialog') {
        d._onShow = dlg => {
          const n = shown.length;
          shown.push(dlg.text());
          const f = answers[n];
          const a = f ? f(dlg, W) : { button: 'cancel' };
          setImmediate(() => {
            const inp = dlg.all().find(x => x.tag === 'input' && x.type === 'text');
            const cb = dlg.all().find(x => x.tag === 'input' && x.type === 'checkbox');
            if (inp && a.value != null) inp.value = a.value;
            if (cb && a.checked != null) cb.checked = a.checked;
            const btn = dlg.all().find(x => x.tag === 'button' && x.dataset.id === a.button);
            if (!btn) throw new Error('dialog ' + n + ' has no button ' + a.button + ': ' + dlg.text());
            btn.onclick();
          });
        };
      }
      return d;
    }
  };
  const panel = el('div'); panel.id = 'bleConnectionPanel'; byId.set('bleConnectionPanel', panel);
  const np = el('input'); np.id = 'namePrefix'; np.value = 'OD'; const npWrap = el('div'); npWrap.appendChild(np); byId.set('namePrefix', np);
  const storage = new Map();
  const localStorage = { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) };
  localStorage.setItem('opendisplay.deviceKeys', JSON.stringify(v1Keys));
  const history = { state: null, replaced: [], replaceState(s, t, u) { this.replaced.push(u); } };
  const loc = new URL(href);
  const ctx = {
    console, setTimeout, clearTimeout, setImmediate, crypto: globalThis.crypto, URL, URLSearchParams, Blob: class { constructor(p) { this.p = p; } },
    document, localStorage, history, location: { href: loc.href, search: loc.search },
    navigator: { storage: { persisted: async () => true } }
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  const run = f => vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), ctx, { filename: f });
  run('ble-common.js');
  vm.runInContext(`
    var bleLib = null;
    function addLog(m, t) { __logs.push([t, m]); }
    function tbFlash(m, k) { __flashes.push(m); }
    function toolboxDeviceName() { return bleLib && bleLib.device ? bleLib.device.name : ''; }
    function tbSavedKey(name) { try { return JSON.parse(localStorage.getItem('opendisplay.deviceKeys'))[name] || ''; } catch (e) { return ''; } }
    var v1AuthCalls = 0;
    async function ensureAuthenticatedOnConnect() { v1AuthCalls++; }
    async function ensureAuthenticatedOnDemand() { v1AuthCalls++; }
    function getEncryptionKeyFromUrl() { return null; }
  `, Object.assign(ctx, { __logs: logs, __flashes: flashes }));
  for (const f of ['od-v3.js', 'od-sec2.js', 'od-sec2-policy.js', 'od-keystore.js', 'od-sec2-session.js', 'ble-sec2.js',
    'od-texts.js', 'od-wizard.js', 'od-setup-url.js', 'toolbox-sec2.js']) run(f);

  // A connected OpenDisplayBLE whose characteristic is the reference device.
  vm.runInContext('bleLib = new OpenDisplayBLE({}); bleLib.log = () => {}; bleLib.setStatus = () => {};', ctx);
  const ble = vm.runInContext('bleLib', ctx);
  ble.isConnected = true;
  ble.device = { name: NAME, gatt: { connected: true } };
  ble.delay = async () => {};
  ble.characteristic = {
    properties: { writeWithoutResponse: true },
    async writeValueWithoutResponse(data) {
      const f = Uint8Array.from(data);
      const replies = await dev.receive(f);
      if (dev._teardownAfterReply) { dev._teardownAfterReply = false; dev.session = null; }
      for (const r of replies) await ble.handleNotification({ target: { value: new DataView(Uint8Array.from(r).buffer) } });
    }
  };
  const W = { ctx, ble, dev, shown, flashes, logs, history, localStorage, TbSec2: ctx.TbSec2,
    connect: () => vm.runInContext('ensureAuthenticatedOnConnect()', ctx),
    v1Calls: () => vm.runInContext('v1AuthCalls', ctx) };
  return W;
}

const sysPkt = () => ({ number: 0, type: 0x01, body: new Uint8Array(22) });
const wifiPkt = () => { const b = new Uint8Array(160); b[0] = 0x41; b.set([0x70, 0x77], 32); return { number: 0, type: 0x26, body: b }; };

test('?key= is taken and removed from the address bar; a setup URL keeps its k', () => {
  const w = world({ dev: new RefDevice({}), href: 'https://opendisplay.org/firmware/toolbox/?key=00112233445566778899aabbccddeeff&x=1' });
  assert.equal(w.history.replaced.length, 1);
  assert.doesNotMatch(w.history.replaced[0], /key=/);
  assert.match(w.history.replaced[0], /x=1/);
  assert.equal(w.ctx.getEncryptionKeyFromUrl(), '00112233445566778899aabbccddeeff');
  const t = w.TbSec2.takeKeyFromUrl('https://opendisplay.org/l/?f=1&k=1&i=1A2B3C');
  assert.equal(t.key, null); assert.equal(t.url, null);
  assert.equal(w.TbSec2.takeKeyFromUrl('https://x.test/?k=00112233445566778899AABBCCDDEEFF').key, '00112233445566778899aabbccddeeff');
  assert.deepEqual({ ...w.TbSec2.setupParams('?setup=OD1A2B3C&kind=reset') }, { name: 'OD1A2B3C', kind: 'reset', newer: false });
  assert.equal(w.TbSec2.setupParams('?setup=<b>'), null);
});

test('a 2.x device keeps the v1 path; the SEC2 module steps aside', async () => {
  const dev = new RefDevice({ fw: [2, 7, 0] });
  dev._plaintext = async cmd => (cmd === 0x0043 ? [Uint8Array.of(0x00, 0x43, 2, 7, 0, 0)] : []);
  const w = world({ dev });
  await w.connect();
  assert.equal(w.v1Calls(), 1);
  assert.equal(w.ble.sec2Link, null);
});

test('FRESH claim mode: "does the display show SETUP MODE and the ID", then the typed code claims it', async () => {
  const dev = new RefDevice({ uid: S.hexToBytes('0102030405060708'), claimMode: 'fresh' });
  dev.ident = () => Uint8Array.of(0x00, 0x46, 0x04, 0x03, 0x01, 0, 0, 0, 0, 0, 0, 0, 0x29);
  const w = world({ dev, answers: [
    dlg => { assert.match(dlg.text(), /SETUP MODE and the ID OD1A2B3C/); return { button: 'yes' }; },
    (dlg, W) => ({ button: 'ok', value: S.formatCode(W.dev.lastCode) })
  ] });
  await w.connect();
  assert.equal(w.v1Calls(), 0, 'no v1 for a SEC2 device');
  assert.equal(dev.claimed, true);
  const rec = w.TbSec2.keyStore().get(NAME);
  assert.equal(rec.confirmed, S.bytesToHex(dev.kDev));
  assert.equal(rec.sec2, true); assert.equal(rec.displaySeen, true);
  assert.ok(w.flashes.some(f => /Claimed/.test(f)));
});

test('a wrong code is refused and nothing is stored', async () => {
  const dev = new RefDevice({ uid: S.hexToBytes('0102030405060708'), claimMode: 'gesture' });
  const w = world({ dev, answers: [(dlg, W) => ({ button: 'ok', value: String((W.dev.lastCode + 1) % 1e6).padStart(6, '0') })] });
  await w.connect();
  assert.equal(dev.claimed, false);
  assert.equal(w.TbSec2.keyStore().hasAnyKey(NAME), false);
  assert.ok(w.flashes.some(f => /does not match/.test(f)));
});

test('an open device offers claim (gesture text) or use without a key', async () => {
  const dev = new RefDevice({ uid: S.hexToBytes('0102030405060708') });
  const w = world({ dev, answers: [dlg => { assert.match(dlg.text(), /Use without a key/); return { button: 'no_key' }; }] });
  await w.connect();
  assert.ok(w.flashes.some(f => /without a key/.test(f)));
  const g = world({ dev: new RefDevice({ uid: S.hexToBytes('0102030405060708') }), answers: [
    () => ({ button: 'claim' }),
    dlg => { assert.match(dlg.text(), /twice in total, not more/); return { button: 'ok' }; }
  ] });
  await g.connect();
  assert.ok(g.flashes.some(f => /not in claim mode/.test(f)), 'the device was not put into claim mode');
});

test('a migrated 2.x key: the stored 2.x key opens the session, then it rotates (one-way text shown)', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const dev = new RefDevice({ uid: S.hexToBytes('0102030405060708'), kDev, origin: 'LEGACY' });
  const w = world({ dev, v1Keys: { [NAME]: S.bytesToHex(kDev) }, answers: [
    dlg => { assert.match(dlg.text(), /one-way step/); return { button: 'rotate', checked: false }; }
  ] });
  await w.connect();
  assert.notEqual(S.bytesToHex(dev.kDev), S.bytesToHex(kDev), 'rotated');
  assert.equal(w.TbSec2.keyStore().get(NAME).confirmed, S.bytesToHex(dev.kDev));
  assert.equal(w.ble.sec2Link.session.hasSession, true, 're-authenticated with the new key');
});

test('rotation opt-out: ticking "Do not replace" keeps the 2.x key and remembers the choice', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const dev = new RefDevice({ uid: S.hexToBytes('0102030405060708'), kDev, origin: 'LEGACY' });
  const w = world({ dev, v1Keys: { [NAME]: S.bytesToHex(kDev) }, answers: [() => ({ button: 'rotate', checked: true })] });
  await w.connect();
  assert.equal(S.bytesToHex(dev.kDev), S.bytesToHex(kDev));
  assert.equal(w.TbSec2.keyStore().noRotate(NAME), true);
  // Next connect: no prompt at all.
  dev.disconnect();
  w.ble.sec2Link.onDisconnect();
  const before = w.shown.length;
  await w.connect();
  assert.equal(w.shown.length, before);
  assert.equal(S.bytesToHex(dev.kDev), S.bytesToHex(kDev));
});

test('secrets on an unclaimed device: refused, or written without them; then after the claim', async () => {
  const dev = new RefDevice({ uid: S.hexToBytes('0102030405060708'), claimMode: 'fresh' });
  dev.ident = () => Uint8Array.of(0x00, 0x46, 0x04, 0x03, 0x00, 0x29, 0, 0, 0, 0, 0);
  const w = world({ dev, answers: [
    dlg => { assert.match(dlg.text(), /need a key/); return { button: 'strip' }; }
  ] });
  await w.connect();  // virgin: entry Configure, no dialog
  const blob = P.buildBlob([sysPkt(), wifiPkt()]);
  await w.ble.writeConfig(blob);
  assert.ok(dev.config, 'written');
  assert.equal(P.scanSecrets(P.walk(dev.config).packets).hasSecret, false, 'without the secrets');
  assert.equal(S.bytesToHex(w.TbSec2._state().pendingSecrets), S.bytesToHex(blob));
  // Cancel: nothing written.
  const w2 = world({ dev: new RefDevice({ uid: S.hexToBytes('0102030405060708'), claimMode: 'fresh' }), answers: [() => ({ button: 'cancel' })] });
  w2.dev.ident = dev.ident;
  await w2.connect();
  await assert.rejects(w2.ble.writeConfig(blob), /Claim this device first/);
  assert.equal(w2.dev.config, null);
});

test('SHOW_KEY_ON_SCREEN asks for confirmation with the required warning', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const dev = new RefDevice({ uid: S.hexToBytes('0102030405060708'), kDev });
  const w = world({ dev, v1Keys: { [NAME]: S.bytesToHex(kDev) }, answers: [
    dlg => { assert.match(dlg.text(), /Anyone who can see the display, or a photo of it, has the key/); return { button: 'cancel' }; }
  ] });
  await w.connect();
  const s27 = new Uint8Array(64); s27[0] = 1; s27.set(kDev, 1); s27[19] = P.SEC_FLAG.SHOW_KEY_ON_SCREEN;
  const blob = P.buildBlob([sysPkt(), { number: 0, type: 0x27, body: s27 }]);
  await assert.rejects(w.ble.writeConfig(blob), /Not written/);
  assert.equal(dev.writes || 0, 0);
});

test('a claimed device with the pattern off and no reset pin asks before writing', async () => {
  const kDev = new Uint8Array(16).fill(0x42);
  const dev = new RefDevice({ uid: S.hexToBytes('0102030405060708'), kDev });
  const w = world({ dev, v1Keys: { [NAME]: S.bytesToHex(kDev) }, answers: [
    dlg => { assert.match(dlg.text(), /wired reflash/); return { button: 'ok' }; }
  ] });
  await w.connect();
  const s27 = new Uint8Array(64); s27[0] = 1; s27.set(kDev, 1); s27[19] = P.SEC_FLAG.NO_RESET_PATTERN;
  await w.ble.writeConfig(P.buildBlob([sysPkt(), { number: 0, type: 0x27, body: s27 }]));
  assert.equal(dev.writes, 1);
  assert.ok(w.logs.some(([, m]) => /30 seconds/.test(m)), 'the 30 s reconnect note');
  assert.ok(w.ble.maxReconnectAttempts >= 5);
});

test('the claim-mode scan option adds a masked manufacturer filter first and keeps the fallbacks', () => {
  const w = world({ dev: new RefDevice({}) });
  w.ble.claimModeScan = true;
  const a = w.ble.buildRequestDeviceOptionAttempts('OD');
  assert.equal(a[0].filters[0].manufacturerData[0].mask[13], 0x0c);
  assert.ok(a.length >= 2, 'fallbacks kept');
  w.ble.claimModeScan = false;
  assert.equal(w.ble.buildRequestDeviceOptionAttempts('OD')[0].filters[0].manufacturerData[0].mask, undefined);
});
