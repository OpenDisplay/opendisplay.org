// The setup/recovery URL (SECURITY_V2 rev 5 § 7.8.1): vectors U1-U4, the page rules, and garbage.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const U = require('../httpdocs/js/od-setup-url.js');

const VEC = [
  { n: 'U1', url: 'https://opendisplay.org/l/?f=1&k=1&i=1A2B3C&t=3&v=3.0.0&b=16&d=10&p=2', bytes: 69,
    in: { kind: 'setup', id: '1A2B3C', target: 3, fw: [3, 0, 0], b: 16, d: 10, p: 2 } },
  { n: 'U2', url: 'https://opendisplay.org/l/?f=1&k=2&i=00ABCD&t=1&v=3.0.0', bytes: 55,
    in: { kind: 'reset', id: '00ABCD', target: 1, fw: [3, 0, 0], b: null, d: null, p: null } },
  { n: 'U3', url: 'https://opendisplay.org/l/?f=1&k=2&i=FFFFFF&t=99&v=255.255.255&b=9999&d=9999&p=9999', bytes: 83,
    in: { kind: 'reset', id: 'FFFFFF', target: 99, fw: [255, 255, 255], b: 9999, d: 9999, p: 9999 } },
  { n: 'U4', url: 'https://opendisplay.org/l/?f=1&k=1&i=000001&t=5&v=3.1.12&p=7', bytes: 60,
    in: { kind: 'setup', id: '000001', target: 5, fw: [3, 1, 12], b: 10000, d: 0, p: 7 },
    want: { b: null, d: null, p: 7 } }
];
let nU = 0;

test('vectors U1-U4: parse and rebuild byte for byte', () => {
  for (const v of VEC) {
    assert.equal(v.url.length, v.bytes, v.n);
    const r = U.parseSetupUrl(v.url);
    assert.equal(r.status, 'setup', v.n);
    assert.equal(r.kind, v.in.kind); assert.equal(r.id, v.in.id); assert.equal(r.name, 'OD' + v.in.id);
    assert.equal(r.target, v.in.target);
    assert.deepEqual([r.fw.major, r.fw.minor, r.fw.patch], v.in.fw);
    assert.deepEqual(r.preset, v.want || { b: v.in.b, d: v.in.d, p: v.in.p }, v.n);
    assert.equal(r.oldFirmware, false);
    const [maj, min, pat] = v.in.fw;
    assert.equal(U.buildSetupUrl({ kind: v.in.kind, id: v.in.id, target: v.in.target, fw: { major: maj, minor: min, patch: pat },
      b: v.in.b, d: v.in.d, p: v.in.p }), v.url, v.n);
    nU++;
  }
  assert.equal(U.parseSetupUrl(VEC[2].url).targetName, null, 't=99 is in range but unnamed');
  assert.equal(U.parseSetupUrl(VEC[3].url).targetName, 'nRF52840');
});

test('the withdrawn /s/ grammar (rev 4 V13) is not a setup URL', () => {
  const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sec2_vectors.json'), 'utf8'));
  for (const c of V.V13_setup_url) {
    const r = U.parseSetupUrl(c.url);
    assert.equal(r.status, 'not_setup_url', c.url);
    assert.equal(r.reason, 'wrong_path');
  }
});

test('dispatch: the legacy boot-screen token stays legacy', () => {
  const tok = 'AAIBAgMEBQYHCAkKCwwNDg8QERITFBU';
  assert.equal(tok.length, 31);
  assert.deepEqual(U.parseSetupUrl('https://opendisplay.org/l/?' + tok), { status: 'legacy', payload: tok });
  assert.equal(U.parseSetupUrl('?' + tok).status, 'legacy');
  assert.equal(U.parseSetupUrl('https://opendisplay.org/l/?' + tok + 'A').status, 'not_setup_url');
  assert.equal(U.parseSetupUrl('https://opendisplay.org/l/?' + tok + '=').status, 'not_setup_url');
});

test('rule 2: optional fields that fail are ignored; unknown fields ignored; first occurrence wins', () => {
  const r = U.parseSetupUrl('https://opendisplay.org/l/?f=1&k=1&i=1a2b3c&t=0&v=3.00.1&b=016&d=10&p=x&z=9&d=11&q');
  assert.equal(r.status, 'setup'); assert.equal(r.id, '1A2B3C');
  assert.equal(r.target, null); assert.equal(r.fw, null);
  assert.deepEqual(r.preset, { b: null, d: 10, p: null });
  assert.deepEqual(r.ignored.sort(), ['b', 'p', 't', 'v']);
  assert.equal(U.parseSetupUrl('https://opendisplay.org/l/?f=1&k=2&i=000001&k=1').kind, 'reset');
  assert.equal(U.parseSetupUrl('https://opendisplay.org/l/?f=1&k=1&i=000001&v=256.0.0').fw, null);
  assert.equal(U.parseSetupUrl('https://opendisplay.org/l/?f=1&k=1&i=000001&t=100').target, null);
  // Fields in another order still parse (append-only is the writer's rule; the reader is lenient).
  assert.equal(U.parseSetupUrl('https://opendisplay.org/l/?f=1&i=000001&k=1').status, 'setup');
});

test('rule 3: unknown future formats and a bad core go to the generic flow, nothing preselected', () => {
  const f2 = U.parseSetupUrl('https://opendisplay.org/l/?f=2&k=2&i=ABCDEF&x=1&b=3');
  assert.equal(f2.status, 'generic'); assert.equal(f2.newerFormat, true);
  assert.equal(f2.kind, 'reset'); assert.equal(f2.name, 'ODABCDEF');
  assert.deepEqual(f2.preset, { b: null, d: null, p: null });
  const f9 = U.parseSetupUrl('https://opendisplay.org/l/?f=999&k=7&i=zz');
  assert.equal(f9.status, 'generic'); assert.equal(f9.kind, 'setup'); assert.equal(f9.id, null);
  assert.equal(U.parseSetupUrl('https://opendisplay.org/l/?f=1000&k=1&i=000001').status, 'generic');
  assert.equal(U.parseSetupUrl('https://opendisplay.org/l/?f=01&k=1&i=000001').newerFormat, true);
  assert.equal(U.parseSetupUrl('https://opendisplay.org/l/?f=&k=1&i=000001').status, 'generic');
  const badK = U.parseSetupUrl('https://opendisplay.org/l/?f=1&k=3&i=000001&b=2');
  assert.equal(badK.status, 'generic'); assert.equal(badK.newerFormat, false); assert.equal(badK.reason, 'bad_kind');
  assert.equal(badK.kind, 'setup'); assert.deepEqual(badK.preset, { b: null, d: null, p: null });
  const badI = U.parseSetupUrl('https://opendisplay.org/l/?f=1&k=1&i=00001G');
  assert.equal(badI.reason, 'bad_id'); assert.equal(badI.name, null);
  assert.equal(U.parseSetupUrl('https://opendisplay.org/l/?f=1&k=1').reason, 'bad_id');
});

test('rule 9: firmware older than 3 is flagged', () => {
  assert.equal(U.parseSetupUrl('https://opendisplay.org/l/?f=1&k=1&i=000001&v=2.9.9').oldFirmware, true);
});

test('garbage never throws and is never a setup URL', () => {
  const bad = [
    undefined, null, 42, {}, '', '   ', 'hello', 'f=1', 'javascript:alert(1)',
    'http://opendisplay.org/l/?f=1&k=1&i=000001',
    'https://evil.example/l/?f=1&k=1&i=000001',
    'https://opendisplay.org.evil.example/l/?f=1&k=1&i=000001',
    'https://user@opendisplay.org/l/?f=1&k=1&i=000001',
    'https://opendisplay.org:8443/l/?f=1&k=1&i=000001',
    'https://opendisplay.org/x/?f=1&k=1&i=000001',
    'https://opendisplay.org/l/x?f=1&k=1&i=000001',
    'https://opendisplay.org/?f=1&k=1&i=000001',
    'https://opendisplay.org/l/?f=1&k=1&i=<script>',
    'https://opendisplay.org/l/?f=1&k=1&i=000001&b=1"onload=x',
    'https://opendisplay.org/l/?f=1&k=1&i=000001\n&b=2',
    'https://opendisplay.org/l/?' + 'a'.repeat(3000),
    'https://opendisplay.org/l/?',
    'https://opendisplay.org/l/',
    'https://opendisplay.org/l/?&&&',
    'https://opendisplay.org/l/?x=1&f=1&k=1&i=000001'
  ];
  for (const b of bad) {
    let r;
    assert.doesNotThrow(() => { r = U.parseSetupUrl(b); }, String(b));
    assert.notEqual(r.status, 'setup', String(b));
    assert.notEqual(r.status, 'legacy', String(b));
  }
  // Fuzz: random strings after the known prefix never throw and only ever yield numbers / fixed strings.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alphabet = 'fkitvbdp=&.0123456789ABCDEFabcdef%#?/-_ ';
  for (let n = 0; n < 2000; n++) {
    let s = 'https://opendisplay.org/l/?f=1';
    const len = Math.floor(rnd() * 60);
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const r = U.parseSetupUrl(s);
    if (r.status === 'setup') {
      assert.match(r.id, /^[0-9A-F]{6}$/);
      for (const v of Object.values(r.preset)) assert.ok(v === null || (Number.isInteger(v) && v >= 1 && v <= 9999));
      assert.ok(r.target === null || (r.target >= 1 && r.target <= 99));
    }
  }
});

test('accepted input forms: full URL, www, /l/index.html, a bare query, a fragment', () => {
  const q = 'f=1&k=1&i=1A2B3C';
  for (const s of ['https://opendisplay.org/l/?' + q, 'https://WWW.opendisplay.org/l?' + q,
    'https://opendisplay.org/l/index.html?' + q, '?' + q, '/l/?' + q, q, 'https://opendisplay.org/l/?' + q + '#x', ' https://opendisplay.org/l/?' + q + '\n']) {
    assert.equal(U.parseSetupUrl(s).status, 'setup', s);
  }
});

test('preset indices map to registry ids; unknown indices give null', () => {
  const reg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'httpdocs', 'firmware', 'toolbox', 'simple-config-id-registry.json'), 'utf8'));
  const r = U.parseSetupUrl(VEC[0].url);
  const p = U.presetsFor(r, reg);
  assert.equal(p.driverBoard, 'm3-pro-silabs');
  assert.equal(p.display, 'ep42-400x300');
  assert.equal(p.power, 'battery-2000');
  assert.deepEqual(U.presetsFor(U.parseSetupUrl(VEC[2].url), reg), { driverBoard: null, display: null, power: null });
  assert.deepEqual(U.presetsFor(U.parseSetupUrl('f=2&k=1&i=000001&b=16'), reg), { driverBoard: null, display: null, power: null });
  assert.equal(U.presetsFor(r, { driverBoards: [{ id: 'x', index: 16 }] }).driverBoard, 'x');
});

test('the Toolbox link carries the name, the kind and the preset ids, never a key', () => {
  const reg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'httpdocs', 'firmware', 'toolbox', 'simple-config-id-registry.json'), 'utf8'));
  const r = U.parseSetupUrl('https://opendisplay.org/l/?f=1&k=2&i=1A2B3C&t=3&v=3.0.0&b=16&d=10&p=2&key=00112233445566778899aabbccddeeff');
  const link = new URL(U.toolboxLinkFor(r, U.presetsFor(r, reg), 'https://opendisplay.org/firmware/toolbox/index.html'));
  assert.equal(link.searchParams.get('device'), 'OD1A2B3C'); assert.equal(link.searchParams.get('setup'), 'OD1A2B3C');
  assert.equal(link.searchParams.get('kind'), 'reset');
  assert.equal(link.searchParams.get('driver'), 'm3-pro-silabs'); assert.equal(link.searchParams.get('display'), 'ep42-400x300');
  assert.doesNotMatch(link.toString(), /key|0011223344/);
  const g = new URL(U.toolboxLinkFor(U.parseSetupUrl('f=5&k=1&i=1A2B3C&b=16'), { driverBoard: 'x' }));
  assert.equal(g.searchParams.get('newer'), '1'); assert.equal(g.searchParams.get('driver'), null);
});

test.after(() => console.log(`# setup URL vectors reproduced: U=${nU} (V13 rev-4 /s/ cases: refused as withdrawn)`));
