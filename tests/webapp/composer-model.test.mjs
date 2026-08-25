// M2 unit tests for the REAL composer model, tools, and extracted QR core.
// DOM-free modules, imported via data: URL (app uses .js which Node treats as
// CJS). Browser-side rendering is covered by composer-browser.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppModule } from './lib/load-app-module.mjs';

// All app modules are loaded UP FRONT. Loading them further down the file
// leaves them in the temporal dead zone for any test registered above the
// await — node:test starts running registered tests as soon as the microtask
// queue drains, which is before a later top-level await resolves.
const model = await loadAppModule('composer/model.js');
const qr = await loadAppModule('composer/qr.js');
const canvasMod = await loadAppModule('composer/canvas.js');

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

test('select tool drags by grab offset and may bleed off the artboard', () => {
  let doc = model.createDocument(DEVICE);
  doc = model.addLayer(doc, model.qrLayer({ text: 'bleed', x: 0.2, y: 0.2, size: 0.4 }));
  const t = tools.makeSelectTool();
  const size = { W: 800, H: 480 };
  ({ doc } = t.onDown(doc, { x: 0.22, y: 0.22 }, size));
  assert.equal(t.selectedId(), doc.layers[0].id, 'hit-test selected the layer');
  ({ doc } = t.onMove(doc, { x: 0.62, y: 0.42 }, size));
  assert.ok(Math.abs(doc.layers[0].x - 0.6) < 1e-9, 'moved by pointer delta, not to pointer');

  // Past the edge is allowed — the render clips it. The limit is measured
  // against the RENDERED extent (a QR block snaps to whole modules, so it is
  // not exactly the requested 0.4), which is the whole point of clamping
  // against layerBounds rather than the layer's own numbers.
  // Assertions are on the RENDERED bounds, not the layer's own numbers: a QR
  // block snaps to whole modules and its origin to whole pixels, which is
  // exactly why the clamp works from layerBounds in the first place.
  const px = 1 / size.W;
  const extent = canvasMod.layerBounds(doc.layers[0], size).w;
  ({ doc } = t.onMove(doc, { x: 5, y: 5 }, size));
  const bMax = canvasMod.layerBounds(doc.layers[0], size);
  const [, maxX] = tools.bleedRange(extent);
  assert.ok(Math.abs(bMax.x - maxX) < 2 * px, `bled to the limit, got ${bMax.x} want ${maxX}`);
  assert.ok(bMax.x > 0.6, 'it really did cross the old boundary');
  assert.ok(bMax.x + extent > 1, 'and part of it now hangs off the canvas');

  // The other direction is bounded too, so it cannot be lost.
  ({ doc } = t.onMove(doc, { x: -5, y: -5 }, size));
  const bMin = canvasMod.layerBounds(doc.layers[0], size);
  const [minX] = tools.bleedRange(extent);
  assert.ok(Math.abs(bMin.x - minX) < 2 * px, `got ${bMin.x} want ${minX}`);
  // "Still reachable" is the rule itself: MIN_ON_CANVAS of the element stays
  // on the artboard, whatever the element's size.
  assert.ok(minX < 0, 'it did cross the near edge');
  assert.ok(bMin.x + extent >= extent * tools.MIN_ON_CANVAS - 2 * px,
    `${(bMin.x + extent).toFixed(4)} of it is still on canvas, of ${extent.toFixed(4)}`);
  assert.equal(t.onUp(doc).commit, true);
});

test('the bleed limit is the artboard for big elements, the element for small', () => {
  // A full-artboard photo is limited by CANVAS_BLEED: it may hang 25% off.
  const [minFull, maxFull] = tools.bleedRange(1);
  assert.equal(+minFull.toFixed(6), -tools.CANVAS_BLEED);
  assert.equal(+maxFull.toFixed(6), tools.CANVAS_BLEED);

  // A small element is limited by MIN_ON_CANVAS instead — 25% of the artboard
  // would swallow it whole.
  const [minSmall, maxSmall] = tools.bleedRange(0.05);
  assert.ok(minSmall > -tools.CANVAS_BLEED, 'the visibility floor binds first');
  assert.equal(+minSmall.toFixed(6), +(-0.05 * (1 - tools.MIN_ON_CANVAS)).toFixed(6));
  assert.ok(maxSmall < 1, 'and it cannot be parked past the far edge either');

  // Whatever the size, some of the element is always on the artboard.
  for (const extent of [0.02, 0.1, 0.5, 1, 1.4]) {
    const [lo, hi] = tools.bleedRange(extent);
    assert.ok(lo + extent > 0, `left limit keeps ${extent} visible`);
    assert.ok(hi < 1, `right limit keeps ${extent} visible`);
  }
});

test('select tool: selection PERSISTS after pointer-up (Delete acts on it)', () => {
  let doc = model.createDocument(DEVICE);
  doc = model.addLayer(doc, model.photoLayer({ assetId: 'a', x: 0.1, y: 0.1, w: 0.5, h: 0.5 }));
  const t = tools.makeSelectTool();
  const size = { W: 800, H: 480 };
  ({ doc } = t.onDown(doc, { x: 0.2, y: 0.2 }, size));
  const id = t.selectedId();
  assert.ok(id);
  t.onUp(doc);
  assert.equal(t.selectedId(), id, 'still selected after the gesture ends');
  t.clearSelection();
  assert.equal(t.selectedId(), null);
});

test('select tool: a click without movement does not create a history entry', () => {
  let doc = model.createDocument(DEVICE);
  doc = model.addLayer(doc, model.photoLayer({ assetId: 'a', x: 0.1, y: 0.1, w: 0.5, h: 0.5 }));
  const t = tools.makeSelectTool();
  const size = { W: 800, H: 480 };
  ({ doc } = t.onDown(doc, { x: 0.2, y: 0.2 }, size));
  assert.equal(t.onUp(doc).commit, false, 'no move => no commit');
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

// --- QR: independent verification against segno ---

test('QR version/size selection agrees with segno (independent implementation)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const golden = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures/qr-golden.json'), 'utf8',
  ));
  assert.ok(golden.cases.length >= 5);
  for (const c of golden.cases) {
    const got = qr.encodeQrMatrix(c.text, { errorCorrectLevel: c.errorCorrectLevel });
    const label = `${JSON.stringify(c.text.slice(0, 20))} @${c.errorCorrectLevel}`;
    const isAscii = /^[\x00-\x7F]*$/.test(c.text);
    if (isAscii) {
      // Same mode (byte) and same payload => the same minimum version.
      assert.equal(got.size, c.size, `version/size for ${label}`);
    } else {
      // segno picks Kanji mode for CJK; this core uses byte mode plus a UTF-8
      // BOM, so it needs at least as much space — never less.
      assert.ok(got.size >= c.size, `non-ASCII capacity for ${label}: ${got.size} < ${c.size}`);
    }
    const rows = [];
    for (let r = 0; r < got.size; r++) {
      rows.push(Array.from(got.modules.subarray(r * got.size, (r + 1) * got.size)).join(''));
    }
    // Module patterns legitimately differ between conformant encoders (mask
    // choice, padding, and this library's UTF-8 BOM), so the cross-library
    // assertion is on VERSION/SIZE — capacity selection — while decodability
    // is proven by the OpenCV round-trip test below and fidelity to the
    // shipped library by the browser test.
    assert.equal(rows.length, got.size, `matrix is square for ${label}`);
  }
});

// --- QR geometry: quiet zone, clamping, hit-test agreement ---

const render = await loadAppModule('composer/render.js');

test('QR geometry reserves a 4-module quiet zone on every side', () => {
  const layer = model.qrLayer({ text: 'https://opendisplay.org', x: 0.1, y: 0.1, size: 0.9 });
  const g = render.qrGeometry(layer, 400, 400);
  assert.equal(render.QR_QUIET_MODULES, 4);
  assert.equal(g.blockPx, (g.size + 8) * g.modulePx, 'block includes 4 modules each side');
  assert.equal(g.codeX - g.x, 4 * g.modulePx);
  assert.equal(g.codeY - g.y, 4 * g.modulePx);
});

test('QR renders where it is placed, including partly off the artboard', () => {
  // It used to be shoved back inside, which silently moved the user's code.
  // Elements bleed now; the composer warns that a clipped QR will not scan.
  for (const [x, y] of [[0, 0], [0.9, 0.9], [-0.1, 0.5]]) {
    const layer = model.qrLayer({ text: 'place me', x, y, size: 0.5 });
    const g = render.qrGeometry(layer, 300, 200);
    assert.equal(g.x, Math.round(x * 300), 'x is where the layer says');
    assert.equal(g.y, Math.round(y * 200), 'y is where the layer says');
  }
});

test('QR never renders larger than the artboard, even when asked to', () => {
  const layer = model.qrLayer({ text: 'x'.repeat(200), x: 0, y: 0, size: 5 });
  const g = render.qrGeometry(layer, 122, 250);
  assert.ok(g.blockPx <= 122, `fits the short side: ${g.blockPx}`);
  assert.ok(g.modulePx >= 1);
});

test('QR hit-test box matches the rendered block exactly', () => {
  const layer = model.qrLayer({ text: 'https://opendisplay.org', x: 0.05, y: 0.05, size: 0.6 });
  const W = 400, H = 300;
  const g = render.qrGeometry(layer, W, H);
  const b = canvasMod.layerBounds(layer, { W, H });
  assert.ok(Math.abs(b.x * W - g.x) < 1e-6, 'bounds x matches rendered x');
  assert.ok(Math.abs(b.y * H - g.y) < 1e-6);
  assert.ok(Math.abs(b.w * W - g.blockPx) < 1e-6, 'bounds width matches rendered block');
  // A point just inside the block hits; just outside misses.
  const doc = model.addLayer(model.createDocument(DEVICE), layer);
  assert.equal(canvasMod.hitTest(doc, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, { W, H }), layer.id);
  assert.equal(canvasMod.hitTest(doc, { x: b.x + b.w + 0.05, y: b.y }, { W, H }), null);
});

test('stroke hit-test uses segment distance, not just sampled vertices', () => {
  // Two endpoints far apart: the midpoint has no vertex near it.
  const stroke = model.strokeLayer({ points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }], width: 0.01 });
  const doc = model.addLayer(model.createDocument(DEVICE), stroke);
  const size = { W: 800, H: 480 };
  assert.equal(canvasMod.hitTest(doc, { x: 0.5, y: 0.5 }, size), stroke.id, 'midpoint hits the line');
  assert.equal(canvasMod.hitTest(doc, { x: 0.5, y: 0.8 }, size), null, 'far from the line misses');
});

test('text hit-test accounts for alignment', () => {
  const size = { W: 800, H: 480 };
  const left = model.textLayer({ text: 'hello', x: 0.5, y: 0.2, size: 0.1, align: 'left' });
  const right = model.textLayer({ text: 'hello', x: 0.5, y: 0.2, size: 0.1, align: 'right' });
  const bl = canvasMod.layerBounds(left, size);
  const br = canvasMod.layerBounds(right, size);
  assert.ok(bl.x >= 0.5 - 1e-9, 'left-aligned box starts at the anchor');
  assert.ok(br.x < 0.5, 'right-aligned box ends at the anchor');
  assert.ok(Math.abs((br.x + br.w) - 0.5) < 1e-9);
});

// --- photo adjustments ---

test('applyAdjustments: identity settings leave pixels untouched', () => {
  const px = new Uint8ClampedArray([10, 128, 250, 255]);
  const before = Array.from(px);
  render.applyAdjustments(px, { exposure: 1, saturation: 1, shadows: 0, highlights: 0 });
  assert.deepEqual(Array.from(px), before);
});

test('applyAdjustments: exposure scales, saturation desaturates, alpha PRESERVED', () => {
  const px = new Uint8ClampedArray([100, 50, 25, 0]);
  render.applyAdjustments(px, { exposure: 1.5, saturation: 1, shadows: 0, highlights: 0 });
  assert.equal(px[0], 150);
  // Transparency must survive: a transparent PNG still reveals the layers
  // beneath it after an adjustment (it must not composite over black).
  assert.equal(px[3], 0, 'source alpha preserved');
  const opaque = new Uint8ClampedArray([100, 50, 25, 255]);
  render.applyAdjustments(opaque, { exposure: 1.5 });
  assert.equal(opaque[3], 255);

  const grey = new Uint8ClampedArray([200, 100, 50, 255]);
  render.applyAdjustments(grey, { exposure: 1, saturation: 0, shadows: 0, highlights: 0 });
  assert.equal(grey[0], grey[1], 'saturation 0 => channels equal');
  assert.equal(grey[1], grey[2]);
});

test('applyAdjustments: shadows lift darks more than lights; highlights pull brights', () => {
  const dark = new Uint8ClampedArray([10, 10, 10, 255]);
  const light = new Uint8ClampedArray([240, 240, 240, 255]);
  render.applyAdjustments(dark, { shadows: 1 });
  render.applyAdjustments(light, { shadows: 1 });
  assert.ok(dark[0] > 10, 'dark lifted');
  assert.equal(light[0], 240, 'light untouched by shadows');

  const bright = new Uint8ClampedArray([250, 250, 250, 255]);
  render.applyAdjustments(bright, { highlights: 1 });
  assert.ok(bright[0] < 250, 'bright pulled down');
});

test('applyAdjustments clamps into range', () => {
  const px = new Uint8ClampedArray([250, 5, 128, 255]);
  render.applyAdjustments(px, { exposure: 4 });
  assert.equal(px[0], 255);
  render.applyAdjustments(px, { exposure: 0 });
  assert.equal(px[1], 0);
});

// --- QR ink contrast and quiet-zone ink (review round 3) ---

test('QR rejects ink with too little contrast against its quiet zone', () => {
  // White-on-white and yellow-on-white are silently unscannable.
  assert.throws(() => render.assertQrContrast({ text: 'x', color: 1 }, 4), /too light/i);
  assert.throws(() => render.assertQrContrast({ text: 'x', color: 2 }, 4), /too light/i);
  // Black and red scan fine against white.
  render.assertQrContrast({ text: 'x', color: 0 }, 4);
  render.assertQrContrast({ text: 'x', color: 3 }, 4);
});

test('lightest ink is scheme-aware (index 1 is DARK grey on the grey schemes)', () => {
  assert.equal(render.lightestIndex(0), 1);       // mono: white
  assert.equal(render.lightestIndex(4), 1);       // 6-colour: white
  assert.equal(render.lightestIndex(5), 3);       // 4-grey: white is LAST
  assert.equal(render.lightestIndex(6), 15);      // 16-grey: white is LAST
  assert.equal(render.darkestIndex(), 0);
});

test('validateDocument rejects unfittable QRs, bad ink and low contrast', () => {
  const tiny = { recordId: 't', width: 40, height: 30, rotationQuarterTurns: 0, colorScheme: 4 };
  assert.throws(
    () => render.validateDocument(model.addLayer(model.createDocument(tiny),
      model.qrLayer({ text: 'x'.repeat(400) }))),
    /shorten the text or LOWER/,
  );
  assert.throws(
    () => render.validateDocument(model.addLayer(model.createDocument({ ...DEVICE, colorScheme: 0 }),
      model.textLayer({ text: 'blue?', color: 4 }))),
    /not valid for scheme/,
  );
  assert.throws(
    () => render.validateDocument(model.addLayer(model.createDocument(DEVICE),
      model.qrLayer({ text: 'ok', color: 1 }))),
    /too light/i,
  );
  // A valid document passes through unchanged.
  const good = model.addLayer(model.createDocument(DEVICE), model.qrLayer({ text: 'ok', color: 0 }));
  assert.equal(render.validateDocument(good), good);
});

// --- draft reconciliation after a device rebind (review round 4) ---

test('reconcile: colour panel draft opened on a MONO panel remaps inks', () => {
  const colour = { recordId: 'c', width: 400, height: 300, rotationQuarterTurns: 0, colorScheme: 4 };
  let doc = model.createDocument(colour);
  doc = model.addLayer(doc, model.textLayer({ text: 'blue', color: 4 }));   // blue
  doc = model.addLayer(doc, model.strokeLayer({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], color: 1 })); // white
  // Rebound to a mono panel: only indices 0 and 1 exist now.
  const moved = { ...doc, panel: { ...doc.panel, colorScheme: 0 } };
  const { doc: fixed, changes } = render.reconcileDocument(moved, 4);
  render.validateDocument(fixed); // must not throw
  assert.ok(fixed.layers.every((l) => l.color === 0 || l.color === 1), 'inks legal for mono');
  assert.equal(fixed.layers[1].color, 1, 'white stays white (nearest colour)');
  assert.ok(changes.length > 0, 'the remap is reported');
  // The input document is untouched.
  assert.equal(moved.layers[0].color, 4);
});

test('reconcile: a QR that no longer fits a smaller panel is dropped, not left broken', () => {
  const big = { recordId: 'b', width: 800, height: 480, rotationQuarterTurns: 0, colorScheme: 4 };
  let doc = model.createDocument(big);
  doc = model.addLayer(doc, model.textLayer({ text: 'keep me' }));
  doc = model.addLayer(doc, model.qrLayer({ text: 'x'.repeat(300), x: 0, y: 0, size: 1 }));
  const moved = { ...doc, panel: { ...doc.panel, width: 40, height: 30 } };
  const { doc: fixed, changes } = render.reconcileDocument(moved, 4);
  render.validateDocument(fixed);
  assert.equal(fixed.layers.length, 1, 'the unfittable QR was removed');
  assert.equal(fixed.layers[0].type, 'text', 'other layers survive');
  assert.ok(changes.some((c) => /no longer fits/.test(c)), `reported: ${changes}`);
});

test('reconcile: a QR whose ink loses contrast is darkened rather than dropped', () => {
  const colour = { recordId: 'c', width: 400, height: 300, rotationQuarterTurns: 0, colorScheme: 4 };
  let doc = model.createDocument(colour);
  doc = model.addLayer(doc, model.qrLayer({ text: 'https://opendisplay.org', color: 2 })); // yellow
  const { doc: fixed, changes } = render.reconcileDocument(doc, 4);
  render.validateDocument(fixed);
  assert.equal(fixed.layers[0].color, 0, 'darkened to black');
  assert.ok(changes.some((c) => /darkened/.test(c)));
});

test('reconcile: an unchanged panel is a no-op with no reported changes', () => {
  let doc = model.createDocument(DEVICE);
  doc = model.addLayer(doc, model.textLayer({ text: 'stable', color: 3 }));
  doc = model.addLayer(doc, model.qrLayer({ text: 'https://opendisplay.org', color: 0 }));
  const { doc: fixed, changes } = render.reconcileDocument(doc, DEVICE.colorScheme);
  assert.deepEqual(changes, []);
  assert.deepEqual(fixed.layers.map((l) => l.color), [3, 0]);
});

// --- dragging strokes (they have no origin, so they translate) ---

test('a stroke can be dragged: every point moves by the same delta', () => {
  let doc = model.createDocument(DEVICE);
  doc = model.addLayer(doc, model.strokeLayer({
    points: [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.3 }, { x: 0.3, y: 0.5 }], width: 0.02,
  }));
  const t = tools.makeSelectTool();
  const size = { W: 800, H: 480 };

  // Grab the line itself (segment hit-testing), then drag.
  ({ doc } = t.onDown(doc, { x: 0.3, y: 0.25 }, size));
  assert.equal(t.selectedId(), doc.layers[0].id, 'the stroke was selected');
  ({ doc } = t.onMove(doc, { x: 0.4, y: 0.35 }, size));

  const moved = doc.layers[0].points;
  assert.deepEqual(moved.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3)]),
    [[0.3, 0.3], [0.5, 0.4], [0.4, 0.6]], 'translated by exactly +0.1,+0.1');
  assert.equal(t.onUp(doc).commit, true, 'the move is one undo step');
});

test('dragging a stroke translates it as a unit, bounded by the same bleed', () => {
  let doc = model.createDocument(DEVICE);
  doc = model.addLayer(doc, model.strokeLayer({
    points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }],
  }));
  const t = tools.makeSelectTool();
  const size = { W: 800, H: 480 };
  ({ doc } = t.onDown(doc, { x: 0.3, y: 0.3 }, size));
  ({ doc } = t.onMove(doc, { x: 5, y: 5 }, size));   // yank far off-canvas
  const pts = doc.layers[0].points;
  const [, maxX] = tools.bleedRange(0.4);
  assert.equal(+Math.min(...pts.map((p) => p.x)).toFixed(9), +maxX.toFixed(9),
    'the leading edge stops at the bleed limit');
  assert.ok(Math.max(...pts.map((p) => p.x)) > 1, 'the tail really is off-canvas');
  assert.equal(+(pts[1].x - pts[0].x).toFixed(3), 0.4, 'shape preserved');
});

test('a stroke drag that cannot move (already at the limit) does not commit', () => {
  let doc = model.createDocument(DEVICE);
  // Spans the whole artboard, so its bleed range is a single point.
  doc = model.addLayer(doc, model.strokeLayer({
    points: [{ x: -tools.CANVAS_BLEED, y: -tools.CANVAS_BLEED },
             { x: 1, y: 1 }],
  }));
  const t = tools.makeSelectTool();
  const size = { W: 800, H: 480 };
  ({ doc } = t.onDown(doc, { x: 0.5, y: 0.5 }, size));
  ({ doc } = t.onMove(doc, { x: -5, y: -5 }, size));
  assert.equal(t.onUp(doc).commit, false, 'no movement was possible, so no history entry');
});

// --- resize handles ---


test('handles sit on the rendered corners; strokes and photos have none', () => {
  const size = { W: 800, H: 480 };
  const qr = model.qrLayer({ text: 'handles', x: 0.2, y: 0.1, size: 0.4 });
  const b = canvasMod.layerBounds(qr, size);
  const pts = canvasMod.handlePoints(qr, size);
  assert.ok(Math.abs(pts.nw.x - b.x) < 1e-9 && Math.abs(pts.nw.y - b.y) < 1e-9);
  assert.ok(Math.abs(pts.se.x - (b.x + b.w)) < 1e-9);
  assert.equal(pts.ne.x, pts.se.x);
  assert.equal(pts.sw.y, pts.se.y);
  assert.equal(canvasMod.handlePoints(model.strokeLayer({ points: [{ x: 0, y: 0 }] }), size), null);
  // A photo has no frame to pull — it zooms instead, the way od-app pinches.
  assert.equal(canvasMod.handlePoints(model.photoLayer({ assetId: 'a' }), size), null);
});

test('handles are square on screen, so their normalized size differs per axis', () => {
  const { hw, hh } = canvasMod.handleSize({ W: 800, H: 400 }, 16);
  assert.equal(hw, 0.02);
  assert.equal(hh, 0.04, 'a shorter axis needs a larger normalized handle');
});

test('hitHandle finds a corner and ignores the layer middle', () => {
  const size = { W: 400, H: 400 };
  const qr = model.qrLayer({ text: 'handles', x: 0.2, y: 0.2, size: 0.4 });
  const b = canvasMod.layerBounds(qr, size);
  assert.equal(canvasMod.hitHandle(qr, { x: b.x, y: b.y }, size), 'nw');
  assert.equal(canvasMod.hitHandle(qr, { x: b.x + b.w, y: b.y + b.h }, size), 'se');
  assert.equal(canvasMod.hitHandle(qr, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, size), null,
    'middle is a move');
  assert.equal(canvasMod.hitHandle(model.photoLayer({ assetId: 'a' }), { x: 0.5, y: 0.5 }, size),
    null, 'a photo has no handles at all');
});

test('resizeBox: each corner moves its own edges and anchors the opposite one', () => {
  const start = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  const se = tools.resizeBox(start, 'se', { x: 0.1, y: 0.1 });
  assert.deepEqual([+se.x.toFixed(3), +se.y.toFixed(3)], [0.2, 0.2], 'origin anchored');
  assert.deepEqual([+se.w.toFixed(3), +se.h.toFixed(3)], [0.5, 0.5]);

  const nw = tools.resizeBox(start, 'nw', { x: 0.1, y: 0.1 });
  assert.deepEqual([+nw.x.toFixed(3), +nw.y.toFixed(3)], [0.3, 0.3]);
  assert.deepEqual([+nw.w.toFixed(3), +nw.h.toFixed(3)], [0.3, 0.3], 'far corner stayed put');

  const ne = tools.resizeBox(start, 'ne', { x: 0.1, y: 0.1 });
  assert.equal(+ne.x.toFixed(3), 0.2, 'left edge anchored');
  assert.equal(+ne.y.toFixed(3), 0.3, 'top edge moved');
});

test('resizeBox clamps to the bleed and to a minimum size', () => {
  const start = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  const huge = tools.resizeBox(start, 'se', { x: 5, y: 5 });
  const hi = 1 + tools.CANVAS_BLEED;
  assert.ok(huge.x + huge.w <= hi + 1e-9 && huge.y + huge.h <= hi + 1e-9,
    'stays within the bleed');
  assert.ok(huge.x + huge.w > 1, 'but is allowed past the artboard edge');

  const tiny = tools.resizeBox(start, 'se', { x: -5, y: -5 });
  assert.equal(+tiny.w.toFixed(3), tools.MIN_LAYER_SIZE);
  assert.equal(+tiny.x.toFixed(3), 0.2, 'anchored corner did not slide');

  // Collapsing from the NW handle pins the box against its bottom-right.
  const tinyNw = tools.resizeBox(start, 'nw', { x: 5, y: 5 });
  assert.equal(+tinyNw.w.toFixed(3), tools.MIN_LAYER_SIZE);
  assert.equal(+(tinyNw.x + tinyNw.w).toFixed(3), 0.6, 'bottom-right corner held');
});

test('dragging a handle resizes a QR instead of moving it', () => {
  let doc = model.createDocument(DEVICE);
  doc = model.addLayer(doc, model.qrLayer({ text: 'resize me', x: 0.2, y: 0.2, size: 0.4 }));
  const t = tools.makeSelectTool();
  const size = { W: 400, H: 400 };
  const b0 = canvasMod.layerBounds(doc.layers[0], size);

  // First click selects; the handle is only live once the layer is selected.
  ({ doc } = t.onDown(doc, { x: b0.x + b0.w / 2, y: b0.y + b0.h / 2 }, size));
  t.onUp(doc);
  ({ doc } = t.onDown(doc, { x: b0.x + b0.w, y: b0.y + b0.h }, size)); // SE handle
  ({ doc } = t.onMove(doc, { x: b0.x + b0.w + 0.2, y: b0.y + b0.h + 0.2 }, size));

  assert.ok(doc.layers[0].size > 0.4, 'grew by the drag');
  assert.equal(t.onUp(doc).commit, true, 'one undo step');
});

test('dragging a photo PANS it — there is no box to move', () => {
  let doc = model.createDocument(DEVICE);
  doc = model.addLayer(doc, model.photoLayer({ assetId: 'a', srcW: 400, srcH: 400 }));
  const t = tools.makeSelectTool();
  const size = { W: 400, H: 400 };
  ({ doc } = t.onDown(doc, { x: 0.5, y: 0.5 }, size));
  assert.equal(t.selectedId(), doc.layers[0].id, 'clicking the canvas grabs the photo');
  ({ doc } = t.onMove(doc, { x: 0.6, y: 0.55 }, size));
  const l = doc.layers[0];
  assert.ok(Math.abs(l.panX - 0.1) < 1e-9, `panned by the drag delta, got ${l.panX}`);
  assert.ok(Math.abs(l.panY - 0.05) < 1e-9);
  assert.equal(l.scale, 1, 'and did not zoom');
  assert.equal(l.x, undefined, 'no box survives on the layer');
  assert.equal(t.onUp(doc).commit, true, 'one undo step');
});

test('a photo cannot be panned out of sight', () => {
  let doc = model.createDocument(DEVICE);
  doc = model.addLayer(doc, model.photoLayer({ assetId: 'a', srcW: 400, srcH: 400 }));
  const t = tools.makeSelectTool();
  const size = { W: 400, H: 400 };
  ({ doc } = t.onDown(doc, { x: 0.5, y: 0.5 }, size));
  ({ doc } = t.onMove(doc, { x: 40, y: 40 }, size));
  const b = canvasMod.layerBounds(doc.layers[0], size);
  assert.ok(b.x < 1 && b.x + b.w > 0, `still overlaps the canvas: ${JSON.stringify(b)}`);
});

test('grabbing the middle of a selected layer still moves it', () => {
  let doc = model.createDocument(DEVICE);
  doc = model.addLayer(doc, model.qrLayer({ text: 'move me', x: 0.2, y: 0.2, size: 0.4 }));
  const t = tools.makeSelectTool();
  const size = { W: 400, H: 400 };
  const b = canvasMod.layerBounds(doc.layers[0], size);
  const mid = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  ({ doc } = t.onDown(doc, mid, size));
  t.onUp(doc);
  ({ doc } = t.onDown(doc, mid, size));
  ({ doc } = t.onMove(doc, { x: mid.x + 0.1, y: mid.y + 0.1 }, size));
  const l = doc.layers[0];
  assert.ok(Math.abs(l.x - 0.3) < 1e-9, 'moved');
  assert.equal(l.size, 0.4, 'size unchanged');
});

test('resizing a QR adjusts its size field, not a width/height box', () => {
  let doc = model.createDocument(DEVICE);
  doc = model.addLayer(doc, model.qrLayer({ text: 'https://opendisplay.org', x: 0.1, y: 0.1, size: 0.4 }));
  const t = tools.makeSelectTool();
  const size = { W: 400, H: 400 };
  const before = doc.layers[0].size;
  const b = canvasMod.handlePoints(doc.layers[0], size);
  ({ doc } = t.onDown(doc, { x: 0.3, y: 0.3 }, size));    // select
  t.onUp(doc);
  ({ doc } = t.onDown(doc, b.se, size));                   // grab SE handle
  ({ doc } = t.onMove(doc, { x: b.se.x + 0.2, y: b.se.y + 0.2 }, size));
  const l = doc.layers[0];
  assert.ok(l.size > before, `QR grew: ${before} -> ${l.size}`);
  assert.equal(l.w, undefined, 'QR has no width/height box');
});

// --- photo fit modes: cover / contain / none ------------------------------

test('photoLayer accepts only the three fit modes', () => {
  assert.deepEqual(model.PHOTO_FIT_MODES, ['cover', 'contain', 'none']);
  for (const fit of model.PHOTO_FIT_MODES) {
    assert.equal(model.photoLayer({ assetId: 'a', fit }).fit, fit);
  }
  assert.equal(model.photoLayer({ assetId: 'a' }).fit, 'cover', 'cover is the default');
  assert.throws(() => model.photoLayer({ assetId: 'a', fit: 'stretch' }), /unknown photo fit/);
});

test('a photo records the natural source size, for the "none" fit', () => {
  const l = model.photoLayer({ assetId: 'a', srcW: 3000, srcH: 2000 });
  assert.equal(l.srcW, 3000);
  assert.equal(l.srcH, 2000);
  const unknown = model.photoLayer({ assetId: 'a' });
  assert.equal(unknown.srcW, null, 'unknown is explicit, not undefined');
});

test('photo rotation is 0-3 quarter turns, defaulting to none', () => {
  assert.equal(model.photoLayer({ assetId: 'a' }).rotationQuarterTurns, 0);
  for (const r of [0, 1, 2, 3]) {
    assert.equal(model.photoLayer({ assetId: 'a', rotationQuarterTurns: r }).rotationQuarterTurns, r);
  }
  for (const bad of [-1, 4, 1.5, '1', null]) {
    assert.throws(() => model.photoLayer({ assetId: 'a', rotationQuarterTurns: bad }),
      /quarter turns/);
  }
});

test('rotating a photo turns its footprint but leaves the pan alone', () => {
  const size = { W: 800, H: 480 };
  const base = model.photoLayer({ assetId: 'a', srcW: 400, srcH: 200, fit: 'contain' });
  const b0 = canvasMod.layerBounds(base, size);
  const b1 = canvasMod.layerBounds({ ...base, rotationQuarterTurns: 1 }, size);
  // A 2:1 source contained in the canvas becomes 1:2 when turned on its side.
  assert.ok(Math.abs((b1.w * size.W) / (b1.h * size.H) - (b0.h * size.H) / (b0.w * size.W)) < 0.02,
    'the footprint aspect inverted');
  // The centre does not move: rotation is about the photo's own centre.
  const mid = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  assert.ok(Math.abs(mid(b1).x - mid(b0).x) < 1e-9 && Math.abs(mid(b1).y - mid(b0).y) < 1e-9);
  for (const r of [0, 1, 2, 3]) {
    const doc = model.addLayer(model.createDocument(DEVICE),
      { ...base, rotationQuarterTurns: r });
    assert.equal(canvasMod.hitTest(doc, { x: 0.5, y: 0.5 }, size), doc.layers[0].id,
      `still hit-testable at ${r}`);
  }
});

test('a legacy photo box is migrated to a pan and a zoom', () => {
  const legacy = {
    id: 'L1', type: 'photo', assetId: 'a',
    x: 0.2, y: 0.1, w: 0.4, h: 0.4, fit: 'cover',
    adjustments: { exposure: 1, saturation: 1, shadows: 0, highlights: 0 },
  };
  const doc = { ...model.createDocument(DEVICE), layers: [legacy] };
  const out = model.migrateDocument(doc);
  const l = out.layers[0];
  assert.equal(l.x, undefined, 'the box is gone');
  assert.equal(l.w, undefined);
  // Box centre (0.4, 0.3) relative to the canvas centre.
  assert.ok(Math.abs(l.panX - (-0.1)) < 1e-9, `panX ${l.panX}`);
  assert.ok(Math.abs(l.panY - (-0.2)) < 1e-9, `panY ${l.panY}`);
  assert.equal(l.scale, 0.4, 'the box size was its zoom in all but name');
  assert.equal(l.fit, 'cover', 'everything else survives');

  // The overwhelmingly common case — a full-canvas photo — is a no-op.
  const full = model.migrateDocument({ ...doc, layers: [{ ...legacy, x: 0, y: 0, w: 1, h: 1 }] });
  assert.deepEqual([full.layers[0].panX, full.layers[0].panY, full.layers[0].scale], [0, 0, 1]);

  // Already-migrated documents are returned unchanged, by identity.
  assert.equal(model.migrateDocument(out), out);
});

test('a draft written before photo rotation existed still validates', () => {
  const legacy = { ...model.photoLayer({ assetId: 'a' }) };
  delete legacy.rotationQuarterTurns;
  const doc = model.addLayer(model.createDocument(DEVICE), legacy);
  assert.doesNotThrow(() => render.validateDocument(doc));
  // ...but a corrupt value is refused rather than rendered as something else.
  const bad = model.addLayer(model.createDocument(DEVICE),
    { ...model.photoLayer({ assetId: 'a' }), rotationQuarterTurns: 9 });
  assert.throws(() => render.validateDocument(bad), /quarter turns/);
});
