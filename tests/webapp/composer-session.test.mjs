// M2 session tests: the REAL session.js, covering the two invariants that
// review round 1 found broken — gesture-scoped undo, and session isolation
// across device switches (autosave capture + async generation guards).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppModule } from './lib/load-app-module.mjs';

const model = await loadAppModule('composer/model.js');
const tools = await loadAppModule('composer/tools.js');
const { createSession, AUTOSAVE_MS } = await loadAppModule('composer/session.js');

const DEVICE_A = { recordId: 'rec-A', width: 800, height: 480, rotationQuarterTurns: 0, colorScheme: 4 };
const DEVICE_B = { recordId: 'rec-B', width: 122, height: 250, rotationQuarterTurns: 0, colorScheme: 0 };

function makeStore() {
  const drafts = new Map();
  const calls = [];
  return {
    drafts, calls,
    putDraft: async (d) => { calls.push(['putDraft', d.id, d.doc.layers.length]); drafts.set(d.id, d); },
    getDraft: async (id) => drafts.get(id) ?? null,
  };
}

function open(device, store, doc = model.createDocument(device), onSaveError) {
  return createSession({
    device,
    draftId: `draft-${device.recordId}`,
    document: doc,
    store,
    onChange: () => {},
    onSaveError,
  });
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// --- blocker 1: gesture-scoped undo ---

test('a drag gesture creates ONE history entry, and undo restores the PRE-gesture state', () => {
  const store = makeStore();
  let doc = model.createDocument(DEVICE_A);
  doc = model.addLayer(doc, model.photoLayer({ assetId: 'a', x: 0.1, y: 0.1, w: 0.3, h: 0.3 }));
  const s = open(DEVICE_A, store, doc);
  const layerId = doc.layers[0].id;
  const t = tools.makeSelectTool();
  const size = { W: 800, H: 480 };

  s.beginGesture();
  let r = t.onDown(s.doc(), { x: 0.15, y: 0.15 }, size);
  s.updateGesture(r.doc);
  // Several intermediate moves — none of which may become history entries.
  for (const x of [0.3, 0.4, 0.5]) {
    r = t.onMove(s.doc(), { x, y: 0.2 }, size);
    s.updateGesture(r.doc);
  }
  const beforeUp = s.doc().layers[0].x;
  assert.ok(beforeUp > 0.1, 'layer moved during the gesture');
  r = t.onUp(s.doc());
  s.endGesture(r.doc, r.commit);

  assert.equal(s.canUndo(), true);
  s.undo();
  assert.equal(s.doc().layers[0].x, 0.1, 'undo restored the pre-gesture position');
  s.redo();
  assert.ok(Math.abs(s.doc().layers[0].x - beforeUp) < 1e-9, 'redo restores the final position');
});

test('a draw gesture is one undo step regardless of how many points it has', () => {
  const store = makeStore();
  const s = open(DEVICE_A, store);
  const t = tools.makeDrawTool();
  const size = { W: 800, H: 480 };

  s.beginGesture();
  let r = t.onDown(s.doc(), { x: 0.1, y: 0.1 }, size);
  s.updateGesture(r.doc);
  for (let i = 1; i <= 20; i++) {
    r = t.onMove(s.doc(), { x: 0.1 + i * 0.04, y: 0.5 }, size);
    s.updateGesture(r.doc);
  }
  r = t.onUp(s.doc());
  s.endGesture(r.doc, r.commit);

  assert.equal(s.doc().layers.length, 1);
  s.undo();
  assert.equal(s.doc().layers.length, 0, 'one undo removes the whole stroke');
  assert.equal(s.canUndo(), false, 'and nothing else was recorded');
});

test('an abandoned gesture (stray tap) leaves no history entry and no layer', () => {
  const store = makeStore();
  const s = open(DEVICE_A, store);
  const t = tools.makeDrawTool();
  s.beginGesture();
  const down = t.onDown(s.doc(), { x: 0.2, y: 0.2 }, { W: 800, H: 480 });
  s.updateGesture(down.doc);
  const up = t.onUp(s.doc());
  s.endGesture(up.doc, up.commit);
  assert.equal(s.doc().layers.length, 0);
  assert.equal(s.canUndo(), false);
});

// --- blocker 2: session isolation ---

test('switching devices within the autosave window saves A to A, not to B', async () => {
  const store = makeStore();
  const a = open(DEVICE_A, store);
  a.apply(model.addLayer(a.doc(), model.textLayer({ text: 'A-edit' })));

  // Switch immediately — well inside the debounce window.
  await a.flush();
  a.release();
  const b = open(DEVICE_B, store);
  b.apply(model.addLayer(b.doc(), model.textLayer({ text: 'B-edit' })));
  await b.flush();

  const draftA = await store.getDraft('draft-rec-A');
  const draftB = await store.getDraft('draft-rec-B');
  assert.equal(draftA.doc.layers[0].text, 'A-edit', "A's edit landed in A's draft");
  assert.equal(draftB.doc.layers[0].text, 'B-edit');
  assert.equal(draftA.recordId, 'rec-A');
  assert.equal(draftB.recordId, 'rec-B');
});

test('a released session never writes: its pending timer is cancelled', async () => {
  const store = makeStore();
  const a = open(DEVICE_A, store);
  a.apply(model.addLayer(a.doc(), model.textLayer({ text: 'A' })));
  a.release(); // e.g. the composer was closed straight after an edit
  await tick(AUTOSAVE_MS + 60);
  assert.equal(store.calls.length, 0, `no writes after release: ${JSON.stringify(store.calls)}`);
});

test('generation advances on release, so in-flight async work can be discarded', () => {
  const store = makeStore();
  const s = open(DEVICE_A, store);
  const gen = s.generation();
  s.release();
  assert.notEqual(s.generation(), gen);
});

test('autosave fires after the debounce and records the captured draft id', async () => {
  const store = makeStore();
  const s = open(DEVICE_A, store);
  s.apply(model.addLayer(s.doc(), model.textLayer({ text: 'x' })));
  await tick(AUTOSAVE_MS + 80);
  assert.deepEqual(store.calls.at(-1), ['putDraft', 'draft-rec-A', 1]);
});

test('save failures are surfaced, never swallowed', async () => {
  const store = makeStore();
  store.putDraft = async () => { throw new Error('QuotaExceededError'); };
  let seen = null;
  const s = open(DEVICE_A, store, undefined, (err) => { seen = err; });
  s.apply(model.addLayer(s.doc(), model.textLayer({ text: 'x' })));
  await s.flush();
  assert.match(String(seen?.message), /Quota/);
});

// --- bitmap ownership ---

test('replacing a bitmap closes the old one; release closes them all', () => {
  const store = makeStore();
  const s = open(DEVICE_A, store);
  const made = [];
  const fake = (tag) => {
    const b = { tag, closed: false, close() { this.closed = true; } };
    made.push(b);
    return b;
  };
  const first = fake('first');
  s.setBitmap('asset-1', first);
  const second = fake('second');
  s.setBitmap('asset-1', second);
  assert.equal(first.closed, true, 'replaced bitmap closed');
  assert.equal(second.closed, false);
  s.setBitmap('asset-2', fake('other'));
  s.release();
  assert.ok(made.every((b) => b.closed), 'release closed every owned bitmap');
});

test('setting the same bitmap object twice does not close it', () => {
  const store = makeStore();
  const s = open(DEVICE_A, store);
  const b = { closed: false, close() { this.closed = true; } };
  s.setBitmap('a', b);
  s.setBitmap('a', b);
  assert.equal(b.closed, false);
});

// --- session identity (review round 2): captured generation is not enough ---

test('two sessions never share an identity: ids are globally unique', () => {
  const store = makeStore();
  const a = open(DEVICE_A, store);
  const b = open(DEVICE_B, store);
  assert.notEqual(a.id, b.id, 'a fresh session is distinguishable from a released one');
  // Both start at generation 0 — which is exactly why the owner OBJECT must be
  // compared too (composer/index.js isCurrent()).
  assert.equal(a.generation(), b.generation());
});

test('an async result captured on A is rejected for B by owner identity', () => {
  const store = makeStore();
  let current = open(DEVICE_A, store);
  const owner = current;
  const captured = owner.generation();
  // Mirror composer/index.js isCurrent(): identity AND generation.
  const isCurrent = (o, g) => current === o && o.generation() === g;
  assert.equal(isCurrent(owner, captured), true);

  owner.release();
  current = open(DEVICE_B, store);
  assert.equal(current.generation(), 0, 'fresh session also starts at 0');
  assert.equal(isCurrent(owner, captured), false,
    "A's in-flight result must not be applied to B");
});

test('a save snapshot captured before release is never written', async () => {
  const store = makeStore();
  const s = open(DEVICE_A, store);
  s.apply(model.addLayer(s.doc(), model.textLayer({ text: 'pre-release' })));
  s.release();
  await s.flush(); // an explicit late flush must also be refused
  assert.equal(store.calls.length, 0, `no writes: ${JSON.stringify(store.calls)}`);
});

test('overlapping saves are serialized and land in order', async () => {
  const store = makeStore();
  const order = [];
  store.putDraft = async (d) => {
    const n = d.doc.layers.length;
    await tick(n === 1 ? 30 : 1); // make the first save slower than the second
    order.push(n);
  };
  const s = open(DEVICE_A, store);
  s.apply(model.addLayer(s.doc(), model.textLayer({ text: 'one' })));
  const first = s.flush();
  s.apply(model.addLayer(s.doc(), model.textLayer({ text: 'two' })));
  const second = s.flush();
  await Promise.all([first, second]);
  assert.deepEqual(order, [1, 2], 'newer save must not be overtaken by an older one');
});

// --- commit poisoning (review round 3): invalid edits must not enter history ---

test('a rejected discrete edit leaves history, document and draft untouched', async () => {
  const store = makeStore();
  const s = createSession({
    device: DEVICE_A,
    draftId: 'draft-rec-A',
    document: model.createDocument(DEVICE_A),
    store,
    onChange: () => {},
    validate: (d) => {
      if (d.layers.some((l) => l.type === 'qr')) throw new Error('QR does not fit');
    },
  });
  s.apply(model.addLayer(s.doc(), model.textLayer({ text: 'ok' })));
  const before = s.doc();

  assert.throws(() => s.apply(model.addLayer(s.doc(), model.qrLayer({ text: 'too big' }))),
    /does not fit/);
  assert.equal(s.doc(), before, 'document unchanged');
  assert.equal(s.doc().layers.length, 1, 'invalid layer not present');
  await s.flush();
  const saved = await store.getDraft('draft-rec-A');
  assert.equal(saved.doc.layers.length, 1, 'invalid layer never autosaved');
  s.undo();
  assert.equal(s.doc().layers.length, 0, 'history holds only the valid edit');
});

test('a gesture whose result is invalid is discarded wholesale', () => {
  const store = makeStore();
  let doc = model.createDocument(DEVICE_A);
  doc = model.addLayer(doc, model.photoLayer({ assetId: 'a', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }));
  const s = createSession({
    device: DEVICE_A, draftId: 'd', document: doc, store, onChange: () => {},
    validate: (d) => { if (d.layers[0].x > 0.5) throw new Error('out of bounds'); },
  });
  s.beginGesture();
  s.updateGesture(model.updateLayer(s.doc(), doc.layers[0].id, { x: 0.9 }));
  assert.throws(() => s.endGesture(s.doc(), true), /out of bounds/);
  assert.equal(s.doc().layers[0].x, 0.1, 'reverted to the pre-gesture state');
  assert.equal(s.canUndo(), false, 'nothing recorded');
});

// --- clean sessions must not overwrite stored drafts (review round 5) ---

test('opening and leaving WITHOUT editing writes nothing', async () => {
  const store = makeStore();
  const s = open(DEVICE_A, store);
  assert.equal(s.isDirty(), false);
  await s.flush();          // e.g. the user clicked Devices straight away
  s.release();
  assert.equal(store.calls.length, 0,
    `a clean session must not persist: ${JSON.stringify(store.calls)}`);
});

test('a reconciled draft is not written back until the user edits it', async () => {
  const store = makeStore();
  // Simulate a reconciled document differing from what is stored.
  const stored = model.addLayer(model.createDocument(DEVICE_A), model.textLayer({ text: 'orig' }));
  store.drafts.set('draft-rec-A', { id: 'draft-rec-A', recordId: 'rec-A', doc: stored });
  const reconciled = model.createDocument(DEVICE_A); // e.g. layers dropped
  const s = open(DEVICE_A, store, reconciled);

  await s.flush();
  assert.equal(store.calls.length, 0, 'reconciliation alone persists nothing');
  assert.equal((await store.getDraft('draft-rec-A')).doc.layers.length, 1, 'stored draft intact');

  // The first real edit makes it dirty, and then it does save.
  s.apply(model.addLayer(s.doc(), model.textLayer({ text: 'user edit' })));
  assert.equal(s.isDirty(), true);
  await s.flush();
  assert.equal(store.calls.length, 1);
});

test('undo counts as an edit (it changes what should be stored)', async () => {
  const store = makeStore();
  const s = open(DEVICE_A, store);
  s.apply(model.addLayer(s.doc(), model.textLayer({ text: 'a' })));
  await s.flush();
  const afterFirst = store.calls.length;
  s.undo();
  await s.flush();
  assert.ok(store.calls.length > afterFirst, 'undo is persisted');
});
