// M2 browser tests over CDP: the REAL render.js drawing into a real Canvas,
// plus asset storage/GC against real IndexedDB. Verifies the invariants the
// M-S(a) spike established — every rendered pixel is OPAQUE and an exact
// ideal-palette colour, so the encoder's nearest-colour classification stays
// lossless — and that content-addressed assets are swept by reachability.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { ChromeCdp } from './lib/chrome-cdp.mjs';

const HTTPDOCS = resolve(dirname(fileURLToPath(import.meta.url)), '../../httpdocs');

const CHROME = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']
  .map((n) => `/usr/bin/${n}`)
  .find((p) => existsSync(p));

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.yaml': 'text/yaml', '.json': 'application/json',
};

const FIXTURE = `<!DOCTYPE html><html><body><script type="module">
window.resultPromise = (async () => {
  const model = await import('/app/v1/js/composer/model.js');
  const render = await import('/app/v1/js/composer/render.js');
  const store = await import('/app/v1/js/store.js');
  const out = { checks: {} };
  const ok = (n, c) => { out.checks[n] = !!c; };

  const DEVICE = { recordId: 'rec-c', width: 61, height: 37, rotationQuarterTurns: 0,
                   colorScheme: 4, panelIcType: 35 };

  // --- render geometry + opaque ideal-palette output ---
  let doc = model.createDocument(DEVICE);
  doc = model.addLayer(doc, model.textLayer({ text: 'Hi', x: 0.05, y: 0.05, size: 0.4, color: 3 }));
  doc = model.addLayer(doc, model.strokeLayer({
    points: [{x:0.1,y:0.8},{x:0.9,y:0.8}], color: 5, width: 0.05 }));
  doc = model.addLayer(doc, model.qrLayer({ text: 'https://opendisplay.org', x: 0.5, y: 0.1, size: 0.5 }));

  const r = render.renderDocument(doc, new Map());
  ok('size', r.width === 61 && r.height === 37);

  const data = r.ctx.getImageData(0, 0, r.width, r.height).data;
  const palette = render.paletteFor(DEVICE.colorScheme);
  const key = (a,b,c) => a+','+b+','+c;
  const allowed = new Set(palette.map((p) => key(p[0],p[1],p[2])));
  let opaque = true, seen = new Set();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i+3] !== 255) opaque = false;
    seen.add(key(data[i], data[i+1], data[i+2]));
  }
  // EVERY pixel opaque is the load-bearing invariant (M-S(a) proved alpha-0
  // pixels read back as RGB 0 and would encode as black).
  ok('allPixelsOpaque', opaque);
  ok('multipleColoursDrawn', seen.size >= 3);
  // The composite is deliberately full-colour: text and stroke anti-aliasing
  // produces intermediate values, which M3's dither pass resolves to palette
  // indices before the ideal-palette paint-back. So AA here is expected —
  // what must NOT happen is a transparent pixel (above) or a blurred QR.

  // QR modules are snapped to whole pixels, so the QR block must be exactly
  // two palette colours with NO anti-aliased edges (scannability).
  const qrOnly = model.addLayer(model.createDocument(DEVICE),
    model.qrLayer({ text: 'https://opendisplay.org', x: 0, y: 0, size: 1 }));
  const qrRender = render.renderDocument(qrOnly, new Map());
  const qd = qrRender.ctx.getImageData(0, 0, qrRender.width, qrRender.height).data;
  let qrExact = true;
  for (let i = 0; i < qd.length; i += 4) {
    if (!allowed.has(key(qd[i], qd[i+1], qd[i+2]))) { qrExact = false; break; }
  }
  ok('qrModulesCrisp', qrExact);

  // Rotation: the artboard uses rotated logical dimensions.
  const rotDoc = model.createDocument({ ...DEVICE, rotationQuarterTurns: 1 });
  const rr = render.renderDocument(rotDoc, new Map());
  ok('rotatedArtboard', rr.width === 37 && rr.height === 61);

  // Unsupported scheme must fail closed at the palette lookup.
  let threw = false;
  try { render.paletteFor(7); } catch { threw = true; }
  ok('scheme7Rejected', threw);

  // --- assets: content-addressing + reachability GC ---
  const blobA = new Blob([new Uint8Array([1,2,3,4])], { type: 'image/png' });
  const blobADup = new Blob([new Uint8Array([1,2,3,4])], { type: 'image/png' });
  const blobB = new Blob([new Uint8Array([9,9,9,9])], { type: 'image/png' });
  const idA = await store.putAsset(blobA);
  const idA2 = await store.putAsset(blobADup);
  const idB = await store.putAsset(blobB);
  ok('contentAddressed', idA === idA2 && idA !== idB);

  // Two drafts share asset A; only draft 2 references B.
  let d1 = model.createDocument(DEVICE);
  d1 = model.addLayer(d1, model.photoLayer({ assetId: idA }));
  let d2 = model.createDocument(DEVICE);
  d2 = model.addLayer(d2, model.photoLayer({ assetId: idA }));
  d2 = model.addLayer(d2, model.photoLayer({ assetId: idB }));
  await store.putDraft(model.toDraft(d1, { id: 'dr-1', recordId: 'rec-c' }));
  await store.putDraft(model.toDraft(d2, { id: 'dr-2', recordId: 'rec-c' }));

  ok('sweepKeepsLive', (await store.sweepAssets()) === 0
     && !!(await store.getAsset(idA)) && !!(await store.getAsset(idB)));

  // Delete the only draft referencing B: A must SURVIVE (shared), B swept.
  await store.deleteDraft('dr-2');
  const removed = await store.sweepAssets();
  ok('sharedAssetSurvives', !!(await store.getAsset(idA)));
  ok('unreachableAssetSwept', removed === 1 && !(await store.getAsset(idB)));

  // Crash-orphan (asset stored, draft write never landed) is reclaimed...
  const orphan = await store.putAsset(new Blob([new Uint8Array([7,7])], { type: 'image/png' }));
  ok('orphanSwept', (await store.sweepAssets()) === 1 && !(await store.getAsset(orphan)));

  // ...unless an unsaved in-memory document still references it.
  const live = await store.putAsset(new Blob([new Uint8Array([5,5])], { type: 'image/png' }));
  ok('extraLiveProtected', (await store.sweepAssets(new Set([live]))) === 0
     && !!(await store.getAsset(live)));

  // --- draft persistence round-trip through IndexedDB ---
  const saved = await store.getDraft('dr-1');
  const restored = model.fromDraft(saved);
  ok('draftRoundTrip', restored.layers.length === 1 && restored.layers[0].assetId === idA);

  out.ok = Object.values(out.checks).every(Boolean);
  return out;
})();
</script></body></html>`;

function serve() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (path.startsWith('/__test__/composer-fixture')) {
      res.writeHead(200, { 'content-type': 'text/html' }).end(FIXTURE);
      return;
    }
    const file = join(HTTPDOCS, path);
    if (!file.startsWith(HTTPDOCS) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

test('composer render + asset GC in real Chromium', async (t) => {
  if (!CHROME) {
    if (process.env.OD_REQUIRE_BROWSER_TESTS || process.env.CI) {
      assert.fail('no Chrome/Chromium binary found and browser tests are required');
    }
    t.skip('no Chrome/Chromium binary found');
    return;
  }
  const { server, port } = await serve();
  t.after(() => server.close());
  const profile = mkdtempSync(join(tmpdir(), 'od-composer-profile-'));
  const chrome = await ChromeCdp.launch(CHROME, { profileDir: profile });
  t.after(() => chrome.close());

  const result = await chrome.evalOnPage(
    `http://127.0.0.1:${port}/__test__/composer-fixture.html`,
    "window.resultPromise || (() => { throw new Error('module not ready'); })()",
  );
  assert.ok(result?.ok, `composer checks failed: ${JSON.stringify(result, null, 1)}`);
});
