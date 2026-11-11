// Browser key store: candidates vs confirmed, staging with read-back, pins, the 2.x store import.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const KS = require('../httpdocs/js/od-keystore.js');

const A = '00112233445566778899aabbccddeeff', B = 'ffeeddccbbaa99887766554433221100', C = '0f'.repeat(16), D = 'a0'.repeat(16);
const mk = (o = {}) => new KS.KeyStore(Object.assign({ storage: KS.memoryStorage(), now: () => 1 }, o));

test('candidates never replace a confirmed key; promote drops the others only on success', () => {
  const s = mk();
  assert.equal(s.addCandidate('OD1', 'nonsense'), false);
  assert.equal(s.addCandidate('OD1', A.toUpperCase().replace(/(..)/g, '$1:').slice(0, -1)), true);
  s.addCandidate('OD1', B); s.addCandidate('OD1', A);
  assert.deepEqual(s.keysToTry('OD1'), [A, B]);
  s.promote('OD1', B, { uid: '0102030405060708' });
  const r = s.get('OD1');
  assert.equal(r.confirmed, B); assert.deepEqual(r.candidates, []); assert.equal(r.sec2, true); assert.equal(r.uid, '0102030405060708');
  s.addCandidate('OD1', C); s.addCandidate('OD1', D); s.addCandidate('OD1', A);
  assert.deepEqual(s.keysToTry('OD1'), [B, C, D], 'at most three, confirmed first');
});

test('stage() writes, reads back and puts the pending key first; refuses when storage fails', () => {
  const s = mk();
  s.promote('OD1', A);
  s.stage('OD1', B, 'rotate');
  assert.deepEqual(s.keysToTry('OD1'), [A, B]);
  assert.equal(s.get('OD1').candidates[0].source, 'pending-rotate');
  const bad = mk({ storage: { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} } });
  assert.equal(bad.durable(), false);
  assert.throws(() => bad.stage('OD1', A, 'claim'), e => e instanceof KS.Sec2StorageError && e.textKey === 'storage_not_durable');
  const lying = KS.memoryStorage();
  const orig = lying.getItem;
  lying.getItem = k => (k === KS.STORE_KEY ? null : orig(k));
  assert.throws(() => mk({ storage: lying }).stage('OD1', A, 'claim'), KS.Sec2StorageError);
  assert.equal(mk({ storage: null }).durable(), typeof localStorage !== 'undefined');
});

test('persisted() reports the browser answer and never throws', async () => {
  assert.equal(await mk({ persisted: async () => true }).persisted(), true);
  assert.equal(await mk({ persisted: async () => { throw new Error('x'); } }).persisted(), false);
  assert.equal(await mk().persisted(), false);
});

test('forget keeps the SEC2 pin unless asked; pins, displaySeen and the rotation opt-out persist', () => {
  const storage = KS.memoryStorage();
  const s = mk({ storage });
  s.promote('OD1', A); s.setDisplaySeen('OD1'); s.setNoRotate('OD1', true);
  const t = mk({ storage });
  assert.equal(t.isPinned('OD1'), true); assert.equal(t.displaySeen('OD1'), true); assert.equal(t.noRotate('OD1'), true);
  t.forget('OD1');
  assert.equal(t.hasAnyKey('OD1'), false); assert.equal(t.isPinned('OD1'), true);
  t.forget('OD1', { unpin: true });
  assert.equal(t.get('OD1'), null);
});

test('the 2.x key store is imported as a candidate and left untouched', () => {
  const storage = KS.memoryStorage();
  storage.setItem(KS.V1_STORE_KEY, JSON.stringify({ OD1: A.toUpperCase(), OD2: 'bad' }));
  const s = mk({ storage });
  assert.equal(s.importV1('OD1'), true);
  assert.equal(s.importV1('OD2'), false);
  assert.equal(s.get('OD1').candidates[0].source, 'v1-store');
  assert.equal(JSON.parse(storage.getItem(KS.V1_STORE_KEY)).OD1, A.toUpperCase());
});

test('a damaged store reads as empty; export text names the device and its keys', () => {
  const storage = KS.memoryStorage();
  storage.setItem(KS.STORE_KEY, '{not json');
  const s = mk({ storage });
  assert.deepEqual(s.names(), []);
  s.promote('OD1', A);
  assert.match(s.exportText('OD1'), new RegExp('Device: OD1[\\s\\S]*Key: ' + A));
  assert.equal(s.exportText('nope'), null);
});
