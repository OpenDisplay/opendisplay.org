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

const FIXTURE = `<!DOCTYPE html><html><body>
<script src="/l/qrcode.js"></script>
<script type="module">
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
  // A 25-module code + 8 quiet modules needs 33px; the 37px-tall test panel
  // fits it exactly at one pixel per module.
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
  // Drafts are only accepted for devices that still exist (cross-tab orphan
  // guard), so create the owning record first.
  const dev = await store.createDevice({
    bleId: 'ble-c', name: 'OD-C', width: 61, height: 37,
    colorScheme: 4, resolutionConfirmed: true,
  });
  const REC = dev.recordId;
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
  await store.putDraft(model.toDraft(d1, { id: 'dr-1', recordId: REC }));
  await store.putDraft(model.toDraft(d2, { id: 'dr-2', recordId: REC }));

  ok('sweepKeepsLive', (await store.sweepAssets(new Set(), { graceMs: 0 })) === 0
     && !!(await store.getAsset(idA)) && !!(await store.getAsset(idB)));

  // Delete the only draft referencing B: A must SURVIVE (shared), B swept.
  await store.deleteDraft('dr-2');
  const removed = await store.sweepAssets(new Set(), { graceMs: 0 });
  ok('sharedAssetSurvives', !!(await store.getAsset(idA)));
  ok('unreachableAssetSwept', removed === 1 && !(await store.getAsset(idB)));

  // Crash-orphan (asset stored, draft write never landed) is reclaimed...
  const orphan = await store.putAsset(new Blob([new Uint8Array([7,7])], { type: 'image/png' }));
  ok('orphanSwept', (await store.sweepAssets(new Set(), { graceMs: 0 })) === 1 && !(await store.getAsset(orphan)));

  // A just-imported asset is protected by the grace window even before its
  // draft reference lands (another tab's sweep must not race an import).
  const fresh = await store.putAsset(new Blob([new Uint8Array([3,3,3])], { type: 'image/png' }));
  ok('graceWindowProtectsImport', (await store.sweepAssets()) === 0 && !!(await store.getAsset(fresh)));
  await store.sweepAssets(new Set(), { graceMs: 0 }); // clean it up for later checks

  // ...unless an unsaved in-memory document still references it.
  const live = await store.putAsset(new Blob([new Uint8Array([5,5])], { type: 'image/png' }));
  ok('extraLiveProtected', (await store.sweepAssets(new Set([live]), { graceMs: 0 })) === 0
     && !!(await store.getAsset(live)));

  // Re-importing identical content refreshes its claim, so a concurrent sweep
  // cannot reclaim it during the asset->draft window. The entry is aged past
  // the grace window first — otherwise the test would pass without the fix.
  const oldBlob = new Blob([new Uint8Array([4,4,4,4])], { type: 'image/png' });
  const oldish = await store.putAsset(oldBlob);
  await (async () => {
    // Age createdAt AND lastClaimedAt well beyond the 5-minute grace window.
    const db = await new Promise((res, rej) => {
      const rq = indexedDB.open('od-app');
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
    await new Promise((res, rej) => {
      const t = db.transaction(['assets'], 'readwrite');
      const st = t.objectStore('assets');
      const g = st.get(oldish);
      g.onsuccess = () => {
        const rec = g.result;
        const ancient = Date.now() - 60 * 60 * 1000;
        st.put({ ...rec, createdAt: ancient, lastClaimedAt: ancient });
      };
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
    db.close();
  })();
  // Sanity: without a refresh this asset WOULD be swept.
  const aged = await store.getAsset(oldish);
  ok('assetAged', (Date.now() - aged.lastClaimedAt) > 5 * 60 * 1000);
  await store.putAsset(oldBlob); // dedup hit -> must refresh the claim
  ok('reimportRefreshesClaim',
     (await store.sweepAssets()) === 0 && !!(await store.getAsset(oldish)));
  await store.sweepAssets(new Set(), { graceMs: 0 });

  // --- fidelity: extracted QR core vs the shipped MIT library ---
  const qrmod = await import('/app/v1/js/composer/qr.js');
  let fidelity = true;
  for (const [text, lvl] of [['hi','L'], ['https://opendisplay.org','M'], ['OD-2F41 tag','Q']]) {
    const holder = document.createElement('div');
    const orig = new QRCode(holder, { text, correctLevel: QRCode.CorrectLevel[lvl] })._oQRCode;
    const n = orig.getModuleCount();
    const mine = qrmod.encodeQrMatrix(text, { errorCorrectLevel: lvl });
    if (mine.size !== n) { fidelity = false; break; }
    for (let r = 0; r < n && fidelity; r++) {
      for (let c = 0; c < n; c++) {
        if ((orig.isDark(r, c) ? 1 : 0) !== mine.modules[r * n + c]) { fidelity = false; break; }
      }
    }
  }
  ok('qrMatchesShippedLibrary', fidelity);

  // --- three panel geometries render at the right size (M2 exit) ---
  const GEOMETRIES = [
    { width: 800, height: 480, rotationQuarterTurns: 0, colorScheme: 4 },   // 7.3" 6-colour
    { width: 122, height: 250, rotationQuarterTurns: 0, colorScheme: 0 },   // EP213 mono
    { width: 400, height: 300, rotationQuarterTurns: 1, colorScheme: 1 },   // 4.2" BWR, rotated
  ];
  let geomOk = true;
  for (const g of GEOMETRIES) {
    let gd = model.createDocument({ recordId: 'g', ...g });
    gd = model.addLayer(gd, model.textLayer({ text: 'Panel', x: 0.05, y: 0.05, size: 0.2 }));
    gd = model.addLayer(gd, model.qrLayer({ text: 'https://opendisplay.org', x: 0.4, y: 0.4, size: 0.5 }));
    const rendered = render.renderDocument(gd, new Map());
    const expect = model.artboardSize(gd.panel);
    if (rendered.width !== expect.width || rendered.height !== expect.height) geomOk = false;
    // Every pixel opaque on every geometry.
    const px = rendered.ctx.getImageData(0, 0, rendered.width, rendered.height).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) { geomOk = false; break; }
  }
  ok('threeGeometries', geomOk);

  // --- photo rendering: proxy bitmap, fit modes, adjustments ---
  const photoCanvas = new OffscreenCanvas(40, 20);
  const pctx = photoCanvas.getContext('2d');
  pctx.fillStyle = 'rgb(200,40,40)'; pctx.fillRect(0, 0, 40, 20);
  const photoBitmap = await createImageBitmap(photoCanvas);

  let pdoc = model.createDocument(DEVICE);
  pdoc = model.addLayer(pdoc, model.photoLayer({ assetId: 'p1', x: 0, y: 0, w: 1, h: 1, fit: 'contain' }));
  const pr = render.renderDocument(pdoc, new Map([['p1', photoBitmap]]));
  const ppx = pr.ctx.getImageData(0, 0, pr.width, pr.height).data;
  let sawPhoto = false, photoOpaque = true;
  for (let i = 0; i < ppx.length; i += 4) {
    if (ppx[i] > 100 && ppx[i+1] < 120) sawPhoto = true;
    if (ppx[i+3] !== 255) photoOpaque = false;
  }
  ok('photoDrawn', sawPhoto);
  ok('photoOpaque', photoOpaque);

  // Cover fills the whole box; contain letterboxes (background visible).
  const containBg = pr.ctx.getImageData(0, pr.height - 1, 1, 1).data;
  let cdoc = model.updateLayer(pdoc, pdoc.layers[0].id, { fit: 'cover' });
  const cr = render.renderDocument(cdoc, new Map([['p1', photoBitmap]]));
  const coverBg = cr.ctx.getImageData(0, cr.height - 1, 1, 1).data;
  ok('fitModesDiffer', containBg[0] !== coverBg[0] || containBg[1] !== coverBg[1]);

  // Adjustments change output pixels (exposure down => darker).
  let adoc = model.updateLayer(pdoc, pdoc.layers[0].id, {
    fit: 'cover', adjustments: { exposure: 0.4, saturation: 1, shadows: 0, highlights: 0 },
  });
  const ar = render.renderDocument(adoc, new Map([['p1', photoBitmap]]));
  const mid = (c) => c.ctx.getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 1, 1).data;
  ok('adjustmentsApplied', mid(ar)[0] < mid(cr)[0]);
  photoBitmap.close();

  // A QR that cannot fit (with its quiet zone) must FAIL, not clip.
  let qrTooBig = false;
  try {
    render.renderDocument(model.addLayer(
      model.createDocument({ ...DEVICE, width: 40, height: 30 }),
      model.qrLayer({ text: 'x'.repeat(400), x: 0, y: 0, size: 1 })), new Map());
  } catch { qrTooBig = true; }
  ok('oversizeQrRejected', qrTooBig);

  // Invalid ink for the scheme must throw, not silently draw another colour.
  let badInk = false;
  try {
    render.renderDocument(model.addLayer(
      model.createDocument({ ...DEVICE, colorScheme: 0 }),
      model.textLayer({ text: 'blue?', color: 4 })), new Map());
  } catch { badInk = true; }
  ok('invalidInkRejected', badInk);

  // Adjusted TRANSPARENT photo must still reveal the layer beneath it.
  const tCanvas = new OffscreenCanvas(20, 20);
  const tctx2 = tCanvas.getContext('2d');
  tctx2.clearRect(0, 0, 20, 20);
  tctx2.fillStyle = 'rgb(0,0,255)';
  tctx2.fillRect(0, 0, 20, 10);       // top half blue, bottom half transparent
  const transparentBitmap = await createImageBitmap(tCanvas);
  let tdoc = model.createDocument({ ...DEVICE, colorScheme: 4 });
  tdoc = model.addLayer(tdoc, model.strokeLayer({
    points: [{ x: 0, y: 0.9 }, { x: 1, y: 0.9 }], color: 3, width: 0.4 })); // red band
  tdoc = model.addLayer(tdoc, model.photoLayer({
    assetId: 't1', x: 0, y: 0, w: 1, h: 1, fit: 'cover',
    adjustments: { exposure: 1.4, saturation: 1, shadows: 0, highlights: 0 },
  }));
  const tr = render.renderDocument(tdoc, new Map([['t1', transparentBitmap]]));
  const bottom = tr.ctx.getImageData(Math.floor(tr.width / 2), tr.height - 2, 1, 1).data;
  ok('transparentPhotoDoesNotBlackOut', !(bottom[0] < 40 && bottom[1] < 40 && bottom[2] < 40));
  transparentBitmap.close();

  // --- bounded decode: dimensions come from the HEADER, never a full decode ---
  const sizeMod = await import('/app/v1/js/composer/image-size.js');
  const big = new OffscreenCanvas(1200, 300);
  const bctx = big.getContext('2d');
  bctx.fillStyle = 'rgb(10,120,200)';
  bctx.fillRect(0, 0, 1200, 300);
  let sizeOk = true;
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
    const blob = await big.convertToBlob({ type });
    const read = await sizeMod.readImageSize(blob);
    if (!read || read.width !== 1200 || read.height !== 300) { sizeOk = false; break; }
    // A bounded decode must respect the cap and keep the aspect ratio.
    const bmp = await sizeMod.decodeBounded(blob, 100);
    if (Math.max(bmp.width, bmp.height) !== 100 || bmp.height !== 25) sizeOk = false;
    bmp.close();
    // Under the cap: untouched.
    const small = await sizeMod.decodeBounded(blob, 5000);
    if (small.width !== 1200) sizeOk = false;
    small.close();
    if (!sizeOk) break;
  }
  ok('headerSizeAndBoundedDecode', sizeOk);

  // An unmeasurable format must FAIL CLOSED, not decode hopefully: a
  // single-axis cap cannot bound a tall image and would upscale a narrow one.
  let refusedUnknown = false;
  try {
    await sizeMod.decodeBounded(new Blob([new Uint8Array([1,2,3,4,5,6,7,8])],
      { type: 'image/avif' }), 100);
  } catch (e) { refusedUnknown = e.name === 'UnsupportedImageError'; }
  ok('unknownFormatRefused', refusedUnknown);
  // The picker's accept list must be exactly what the decoder supports.
  // The bounded decode must hold even where createImageBitmap ignores resize
  // options (WebKit/Bluefy): verify-and-fallback, not trust.
  const origCIB = self.createImageBitmap;
  let fallbackOk = false;
  try {
    self.createImageBitmap = (src, opts) => origCIB(src); // pretend resize is ignored
    const blob = await big.convertToBlob({ type: 'image/png' });
    const bmp = await sizeMod.decodeBounded(blob, 100);
    fallbackOk = Math.max(bmp.width, bmp.height) === 100 && bmp.height === 25;
    bmp.close?.();
  } catch { fallbackOk = false; } finally { self.createImageBitmap = origCIB; }
  ok('resizeIgnoredFallback', fallbackOk);

  // The capability probe must use the BLOB overload production uses, and its
  // verdict must drive the pre-decode limit.
  sizeMod._resetResizeSupport();
  ok('probeDetectsWorkingResize', (await sizeMod.supportsBitmapResize()) === true);

  sizeMod._resetResizeSupport();
  let probeDetectsBroken = false;
  let strictLimitApplied = false;
  const wide = new OffscreenCanvas(4200, 3200);           // ~13.4 MP > 12 MP
  wide.getContext('2d').fillRect(0, 0, 4200, 3200);
  const bigBlob = await wide.convertToBlob({ type: 'image/png' });
  try {
    self.createImageBitmap = (src, opts) => origCIB(src); // resize ignored
    probeDetectsBroken = (await sizeMod.supportsBitmapResize()) === false;
    try {
      const b = await sizeMod.decodeBounded(bigBlob, 800);
      b.close?.();
    } catch (e) {
      strictLimitApplied = e.name === 'ImageTooLargeError';
    }
  } finally {
    self.createImageBitmap = origCIB;
    sizeMod._resetResizeSupport();
  }
  ok('probeDetectsBrokenResize', probeDetectsBroken);
  ok('strictLimitWhenResizeUnavailable', strictLimitApplied);

  // The SAME image is accepted when resize works: the limit is conditional,
  // not a blanket refusal.
  let acceptedWhenBounded = false;
  try {
    const b = await sizeMod.decodeBounded(bigBlob, 800);
    acceptedWhenBounded = Math.max(b.width, b.height) === 800;
    b.close?.();
  } catch { acceptedWhenBounded = false; }
  ok('sameImageAcceptedWhenResizeWorks', acceptedWhenBounded);

  // A document referencing a MISSING asset must never produce a frame (so Send
  // stays disabled), and removing the broken layer must unblock rendering.
  const { createDitherClient } = await import('/app/v1/js/composer/dither-client.js');
  let sawFrameForMissing = false;
  let unblockResolve = null;
  const blockedClient = createDitherClient({
    workerUrl: '/app/v1/js/composer/dither-worker.js',
    onResult: () => { sawFrameForMissing = true; unblockResolve?.(true); },
    onError: () => { unblockResolve?.(false); },
  });
  let withPhoto = model.createDocument(DEVICE);
  withPhoto = model.addLayer(withPhoto, model.photoLayer({ assetId: 'never-loaded' }));
  blockedClient.request(withPhoto, { mode: 0 });
  await new Promise((r) => setTimeout(r, 400));
  ok('missingAssetNeverProducesFrame', sawFrameForMissing === false);

  // Recovery must work on the SAME client that was blocked — that is the real
  // path a user takes after deleting the broken layer.
  const cleaned = model.removeLayer(withPhoto, withPhoto.layers[0].id);
  const unblocked = await new Promise((resolve) => {
    unblockResolve = resolve;
    blockedClient.request(cleaned, { mode: 0 });
    setTimeout(() => resolve(false), 8000);
  });
  ok('removingBrokenLayerUnblocksSameClient', unblocked);
  blockedClient.terminate();

  ok('acceptListMatchesDecoder',
     JSON.stringify(sizeMod.SUPPORTED_IMAGE_TYPES) ===
     JSON.stringify(['image/png', 'image/jpeg', 'image/gif', 'image/webp']));

  // --- draft persistence round-trip through IndexedDB ---
  const saved = await store.getDraft('dr-1');
  const restored = model.fromDraft(saved);
  ok('draftRoundTrip', restored.layers.length === 1 && restored.layers[0].assetId === idA);

  // Reconciliation must not rewrite the stored draft: open a draft authored
  // for a colour panel on a MONO panel, reconcile, and confirm storage is
  // byte-identical afterwards.
  const monoDev = await store.createDevice({
    bleId: 'ble-m', name: 'OD-M', width: 122, height: 250,
    colorScheme: 0, resolutionConfirmed: true,
  });
  let colourDoc = model.createDocument({ recordId: monoDev.recordId, width: 400, height: 300,
                                         rotationQuarterTurns: 0, colorScheme: 4 });
  colourDoc = model.addLayer(colourDoc, model.textLayer({ text: 'blue', color: 4 }));
  await store.putDraft(model.toDraft(colourDoc, { id: 'dr-mono', recordId: monoDev.recordId }));
  const savedBefore = JSON.stringify(await store.getDraft('dr-mono'));

  const reopened = model.fromDraft(await store.getDraft('dr-mono'));
  const priorScheme = reopened.panel.colorScheme;
  reopened.panel = model.createDocument(monoDev).panel;
  const { doc: fixedDoc, changes: reconChanges } = render.reconcileDocument(reopened, priorScheme);
  render.validateDocument(fixedDoc);
  ok('reconcileRemapped', reconChanges.length > 0 && fixedDoc.layers[0].color < 2);
  ok('storedDraftUntouchedByReconcile',
     JSON.stringify(await store.getDraft('dr-mono')) === savedBefore);

  // Grey-scheme background must be WHITE (last index), not index 1.
  const greyDoc = model.createDocument({ recordId: 'g', width: 100, height: 100,
                                         rotationQuarterTurns: 0, colorScheme: 5 });
  ok('greyBackgroundIsWhite', greyDoc.background === 3);
  const greyRender = render.renderDocument(greyDoc, new Map());
  const corner = greyRender.ctx.getImageData(0, 0, 1, 1).data;
  ok('greyBackgroundRendersWhite', corner[0] === 255 && corner[1] === 255 && corner[2] === 255);

  // A draft for a FORGOTTEN device must be refused, not resurrected — run
  // last, since forgetting cascades the drafts other checks rely on.
  await store.forgetDevice(REC);
  let orphanRefused = false;
  try {
    await store.putDraft(model.toDraft(d1, { id: 'dr-1', recordId: REC }));
  } catch { orphanRefused = true; }
  ok('orphanDraftRefused', orphanRefused);

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
