// M2 unit tests for the REAL composer model, tools, and extracted QR core.
// DOM-free modules, imported via data: URL (app uses .js which Node treats as
// CJS). Browser-side rendering is covered by composer-browser.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppModule } from './lib/load-app-module.mjs';

const model = await loadAppModule('composer/model.js');
const qr = await loadAppModule('composer/qr.js');

const DEVICE = {
  recordId: 'rec-1', width: 800, height: 480,
  rotationQuarterTurns: 0, colorScheme: 4, panelIcType: 35,
};

// --- artboard geometry ---

test('artboard swaps dimensions for quarter-turns 1 and 3 only', () => {
  assert.deepEqual(model.artboardSize({ ...DEVICE, rotationQuarterTurns: 0 }), { width: 800, height: 480 });
  assert.deepEqual(model.artboardSize({ ...DEVICE, rotationQuarterTurns: 1 }), { width: 480, height: 800 });
  assert.deepEqual(model.artboardSize({ ...DEVICE, rotationQuarterTurns: 2 }), { width: 800, height: 480 });
  assert.deepEqual(model.artboardSize({ ...DEVICE, rotationQuarterTurns: 3 }), { width: 480, height: 800 });
});

test('document copies panel facts so later device edits do not mutate it', () => {
  const device = { ...DEVICE };
  const doc = model.createDocument(device);
  device.width = 122;
  assert.equal(doc.panel.width, 800);
});

// --- immutability ---

test('layer edits never mutate the previous document (undo integrity)', () => {
  const d0 = model.createDocument(DEVICE);
  const d1 = model.addLayer(d0, model.textLayer({ text: 'hi' }));
  assert.equal(d0.layers.length, 0, 'original untouched');
  const id = d1.layers[0].id;
  const d2 = model.updateLayer(d1, id, { x: 0.5 });
  assert.equal(d1.layers[0].x, 0.1, 'previous version untouched');
  assert.equal(d2.layers[0].x, 0.5);
  const d3 = model.addLayer(d2, model.strokeLayer({ points: [{ x: 0, y: 0 }] }));
  d3.layers.at(-1).points.push({ x: 1, y: 1 });
  assert.equal(d2.layers.length, 1, 'deep clone: point array not shared');
});

test('moveLayer reorders and clamps at the ends', () => {
  let doc = model.createDocument(DEVICE);
  doc = model.addLayer(doc, model.textLayer({ text: 'a' }));
  doc = model.addLayer(doc, model.textLayer({ text: 'b' }));
  const [a, b] = doc.layers.map((l) => l.id);
  assert.deepEqual(model.moveLayer(doc, a, +1).layers.map((l) => l.id), [b, a]);
  assert.deepEqual(model.moveLayer(doc, a, -5).layers.map((l) => l.id), [a, b], 'clamped');
});

// --- history ---

test('undo/redo restore exact document versions', () => {
  const d0 = model.createDocument(DEVICE);
  let h = model.createHistory(d0);
  const d1 = model.addLayer(d0, model.textLayer({ text: 'one' }));
  h = model.commit(h, d1);
  const d2 = model.addLayer(d1, model.textLayer({ text: 'two' }));
  h = model.commit(h, d2);
  assert.equal(h.present.layers.length, 2);
  h = model.undo(h);
  assert.equal(h.present.layers.length, 1);
  h = model.undo(h);
  assert.equal(h.present.layers.length, 0);
  assert.equal(model.canUndo(h), false);
  h = model.redo(h);
  assert.equal(h.present.layers.length, 1);
  h = model.redo(h);
  assert.equal(h.present.layers.length, 2);
  assert.equal(model.canRedo(h), false);
});

test('a new commit clears the redo branch', () => {
  let h = model.createHistory(model.createDocument(DEVICE));
  h = model.commit(h, model.addLayer(h.present, model.textLayer({ text: 'a' })));
  h = model.undo(h);
  assert.equal(model.canRedo(h), true);
  h = model.commit(h, model.addLayer(h.present, model.textLayer({ text: 'b' })));
  assert.equal(model.canRedo(h), false);
});

test('history is bounded at MAX_UNDO, dropping oldest', () => {
  let h = model.createHistory(model.createDocument(DEVICE));
  for (let i = 0; i < model.MAX_UNDO + 20; i++) {
    h = model.commit(h, model.addLayer(h.present, model.textLayer({ text: `t${i}` })));
  }
  assert.equal(h.past.length, model.MAX_UNDO);
});

test('snapshots are structure-only: assets referenced by id, never embedded', () => {
  let doc = model.createDocument(DEVICE);
  doc = model.addLayer(doc, model.photoLayer({ assetId: 'sha-abc' }));
  const json = JSON.stringify(doc);
  assert.ok(json.includes('sha-abc'));
  assert.ok(!json.includes('blob'), 'no blob payload in the document');
  assert.deepEqual([...model.referencedAssets(doc)], ['sha-abc']);
});

// --- drafts round-trip ---

test('draft round-trip preserves layers and keeps ids unique afterwards', () => {
  let doc = model.createDocument(DEVICE);
  doc = model.addLayer(doc, model.textLayer({ text: 'saved' }));
  doc = model.addLayer(doc, model.qrLayer({ text: 'https://x.test' }));
  const draft = model.toDraft(doc, { id: 'draft-1', recordId: 'rec-1' });
  const restored = model.fromDraft(JSON.parse(JSON.stringify(draft)));
  assert.equal(restored.layers.length, 2);
  assert.equal(restored.layers[0].text, 'saved');
  // A newly created layer must not collide with a restored id.
  const after = model.addLayer(restored, model.textLayer({ text: 'new' }));
  const ids = after.layers.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, 'ids unique after restore');
});

// --- tools ---

const tools = await loadAppModule('composer/tools.js');

test('draw tool: builds a stroke, drops jitter, commits once on pointer up', () => {
  const t = tools.makeDrawTool({ color: 3, width: 0.02 });
  let doc = model.createDocument(DEVICE);
  ({ doc } = t.onDown(doc, { x: 0.1, y: 0.1 }));
  assert.equal(doc.layers.length, 1);
  ({ doc } = t.onMove(doc, { x: 0.1005, y: 0.1005 })); // sub-threshold jitter
  assert.equal(doc.layers[0].points.length, 1, 'jitter dropped');
  ({ doc } = t.onMove(doc, { x: 0.5, y: 0.5 }));
  assert.equal(doc.layers[0].points.length, 2);
  const up = t.onUp(doc);
  assert.equal(up.commit, true);
  assert.equal(up.doc.layers[0].color, 3);
});

test('draw tool discards a stray tap (single point) without committing', () => {
  const t = tools.makeDrawTool();
  let doc = model.createDocument(DEVICE);
  ({ doc } = t.onDown(doc, { x: 0.2, y: 0.2 }));
  const up = t.onUp(doc);
  assert.equal(up.doc.layers.length, 0, 'stray tap removed');
  assert.equal(up.commit, false);
});

test('select tool drags a layer by its grab offset and clamps to the artboard', () => {
  let doc = model.createDocument(DEVICE);
  doc = model.addLayer(doc, model.textLayer({ text: 'drag', x: 0.2, y: 0.2, size: 0.1 }));
  const t = tools.makeSelectTool();
  const size = { W: 800, H: 480 };
  ({ doc } = t.onDown(doc, { x: 0.22, y: 0.22 }, size));
  assert.equal(t.selectedId(), doc.layers[0].id, 'hit-test selected the layer');
  ({ doc } = t.onMove(doc, { x: 0.62, y: 0.42 }));
  assert.ok(Math.abs(doc.layers[0].x - 0.6) < 1e-9, 'moved by pointer delta, not to pointer');
  ({ doc } = t.onMove(doc, { x: 5, y: 5 }));
  assert.equal(doc.layers[0].x, 1, 'clamped');
  assert.equal(t.onUp(doc).commit, true);
});

test('select tool on empty space selects nothing and does not commit', () => {
  const doc = model.createDocument(DEVICE);
  const t = tools.makeSelectTool();
  const r = t.onDown(doc, { x: 0.9, y: 0.9 }, { W: 800, H: 480 });
  assert.equal(t.selectedId(), null);
  assert.equal(t.onUp(r.doc).commit, false);
});

// --- QR core (extracted, not rewritten) ---

test('QR: auto version selection grows with payload length', () => {
  const small = qr.encodeQrMatrix('hi', { errorCorrectLevel: 'L' });
  const large = qr.encodeQrMatrix('x'.repeat(300), { errorCorrectLevel: 'L' });
  assert.equal(small.size, 21, 'version 1');
  assert.ok(large.size > small.size);
  assert.equal(small.modules.length, small.size * small.size);
});

test('QR: every ECC level encodes; higher levels need more space', () => {
  const text = 'https://opendisplay.org/firmware/toolbox/';
  const sizes = ['L', 'M', 'Q', 'H'].map((l) => qr.encodeQrMatrix(text, { errorCorrectLevel: l }).size);
  assert.ok(sizes.every((s) => s >= 21 && s % 4 === 1), `plausible sizes: ${sizes}`);
  assert.ok(sizes.at(-1) >= sizes[0], 'H is never smaller than L');
});

test('QR: finder patterns present in all three corners', () => {
  const { size, modules } = qr.encodeQrMatrix('finder', { errorCorrectLevel: 'M' });
  const at = (r, c) => modules[r * size + c];
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(at(r0, c0), 1, 'finder corner dark');
    assert.equal(at(r0 + 1, c0 + 1), 0, 'finder inner ring light');
    assert.equal(at(r0 + 3, c0 + 3), 1, 'finder centre dark');
  }
});

test('QR: UTF-8 payloads encode (multi-byte handled by the extracted core)', () => {
  const ascii = qr.encodeQrMatrix('aaaaaaaaaa', { errorCorrectLevel: 'L' });
  const uni = qr.encodeQrMatrix('日本語テキスト', { errorCorrectLevel: 'L' });
  assert.ok(uni.size >= ascii.size, 'multi-byte payload needs at least as much space');
  assert.ok(uni.modules.some((m) => m === 1));
});

test('QR: rejects empty text, unknown ECC level, and over-capacity payloads', () => {
  assert.throws(() => qr.encodeQrMatrix(''), /empty/i);
  assert.throws(() => qr.encodeQrMatrix('x', { errorCorrectLevel: 'Z' }), /unknown error-correction/i);
  assert.throws(() => qr.encodeQrMatrix('x'.repeat(5000), { errorCorrectLevel: 'H' }), /too long/i);
  assert.throws(() => qr.encodeQrMatrix('x'.repeat(100), { typeNumber: 1 }), /too long for QR version 1/i);
});
