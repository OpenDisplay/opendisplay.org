// The composer's editing SURFACE, driven the way a user drives it.
//
// This covers the three things the UI rework changed, all of which are easy to
// break silently from the model side:
//   1. tool chips reveal exactly one panel (od-app's ComposerView shape);
//   2. elements may be dragged off the edge of the canvas and are cropped by
//      the render, rather than being pinned inside it;
//   3. selection handles stay reachable when an element has been pushed off,
//      because the overlay canvas is exactly panel-sized and cannot draw
//      outside it.
//
// Real Chromium over CDP, real IndexedDB, real pointer events — the geometry
// is unit-tested elsewhere, so what is worth proving here is that the wiring
// actually delivers it.
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
  '.yaml': 'text/yaml', '.json': 'application/json', '.ico': 'image/x-icon',
};

function serve() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    let file = join(HTTPDOCS, path);
    if (path.endsWith('/')) file = join(file, 'index.html');
    if (!file.startsWith(HTTPDOCS) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

test('composer UI: chips, off-canvas movement, handles, fit modes', async (t) => {
  if (!CHROME) {
    if (process.env.OD_REQUIRE_BROWSER_TESTS || process.env.CI) {
      assert.fail('no Chrome/Chromium binary found and browser tests are required');
    }
    t.skip('no Chrome/Chromium binary found');
    return;
  }
  const { server, port } = await serve();
  t.after(() => server.close());
  const chrome = await ChromeCdp.launch(CHROME, {
    profileDir: mkdtempSync(join(tmpdir(), 'od-ui-')),
  });
  t.after(() => chrome.close());

  const profileUrl = `http://127.0.0.1:${port}/app/`;

  const seeded = await chrome.evalOnPage(profileUrl, `(async () => {
    if (!location.origin || location.origin === 'null') throw new Error('not navigated');
    if (document.body.dataset.odSchema !== 'ready') throw new Error('schema not ready');
    const store = await import(location.origin + '/app/v1/js/store.js');
    // Scheme 4 (6-colour) so the ink swatches have something to show.
    const rec = await store.createDevice({
      bleId: 'ui-tag', name: 'Studio', width: 400, height: 300,
      rotationQuarterTurns: 0, colorScheme: 4, panelIcType: 35, resolutionConfirmed: true,
    });
    return rec.recordId;
  })()`, { timeoutMs: 40000 });
  assert.ok(seeded, 'device record seeded');

  const result = await chrome.evalOnPage(profileUrl, `(async () => {
    if (document.body.dataset.odSchema !== 'ready') throw new Error('schema not ready');
    if (!document.querySelector('#deviceList button')) throw new Error('device list not rendered');

    const out = { checks: {} };
    const ok = (n, c) => { out.checks[n] = !!c; };
    const $ = (id) => document.getElementById(id);
    const settle = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 200)));

    const canvasEl = () => $('composerCanvas');
    const at = (nx, ny) => {
      const r = canvasEl().getBoundingClientRect();
      return { clientX: r.left + nx * r.width, clientY: r.top + ny * r.height };
    };
    const pointer = (type, nx, ny) => canvasEl().dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...at(nx, ny),
    }));
    const drag = (fromX, fromY, toX, toY) => {
      pointer('pointerdown', fromX, fromY);
      pointer('pointermove', (fromX + toX) / 2, (fromY + toY) / 2);
      pointer('pointermove', toX, toY);
      pointer('pointerup', toX, toY);
    };

    const composer = await import(location.origin + '/app/v1/js/composer/index.js');
    [...document.querySelectorAll('#deviceList button')]
      .find((b) => b.textContent.trim() === 'Composer').click();
    await settle();
    ok('opened', composer.hasSession());

    // --- 1. chips reveal exactly one panel ---------------------------------
    const PANELS = ['panelSelect', 'panelDraw', 'panelText', 'panelQr', 'panelPhoto', 'panelDither'];
    // COMPUTED style, not the hidden property: .composer__panel sets display,
    // which outranks the UA's [hidden] rule, so the attribute alone proved
    // nothing — every panel rendered at once while this test was green.
    const visible = () => PANELS.filter((p) => getComputedStyle($(p)).display !== 'none');
    ok('opensOnMove', visible().join() === 'panelSelect'
       && $('toolSelect').classList.contains('composer__chip--active'));
    let oneAtATime = true;
    for (const chip of ['toolDraw', 'toolText', 'toolQr', 'toolPhoto', 'toolDither', 'toolSelect']) {
      $(chip).click();
      const v = visible();
      if (v.length !== 1 || v[0] !== $(chip).dataset.panel) oneAtATime = false;
      if ($(chip).getAttribute('aria-selected') !== 'true') oneAtATime = false;
    }
    ok('onePanelAtATime', oneAtATime);

    // --- 2. ink swatches come from the panel's own palette -----------------
    $('toolDraw').click();
    const swatches = [...$('drawInk').children];
    ok('swatchesForScheme', swatches.length === 6);   // scheme 4 = 6 inks
    ok('swatchIsTheColour',
       swatches[0].style.background.replace(/\\s/g, '') === 'rgb(0,0,0)');
    ok('oneSwatchActive',
       swatches.filter((s) => s.classList.contains('composer__swatch--active')).length === 1);

    // --- 3. place a QR by tapping the canvas -------------------------------
    $('toolQr').click();
    $('qrContent').value = 'https://opendisplay.org';
    $('qrSize').value = '0.4';
    pointer('pointerdown', 0.3, 0.3);
    pointer('pointerup', 0.3, 0.3);
    await settle();
    const model = await import(location.origin + '/app/v1/js/composer/model.js');
    ok('qrPlaced', $('composerPanelInfo').textContent.includes('1 layer'));
    ok('returnedToMove', $('toolSelect').classList.contains('composer__chip--active'));

    // --- 4. drag it OFF the canvas ----------------------------------------
    const canvasMod = await import(location.origin + '/app/v1/js/composer/canvas.js');
    const size = { W: canvasEl().width, H: canvasEl().height };
    const before = composer._doc().layers[0];
    const b0 = canvasMod.layerBounds(before, size);
    // Grab its middle and yank far past the right edge.
    drag(b0.x + b0.w / 2, b0.y + b0.h / 2, 3, 0.5);
    await settle();
    const after = composer._doc().layers[0];
    const b1 = canvasMod.layerBounds(after, size);
    ok('movedOffCanvas', b1.x + b1.w > 1);
    ok('notLostEntirely', b1.x < 1);
    ok('clipWarningShown', $('composerWarning').hidden === false);

    // The render must CROP it, not grow: the canvas is still panel-sized and
    // nothing threw while drawing an element that crosses the edge.
    ok('canvasStillPanelSized', canvasEl().width === 400 && canvasEl().height === 300);

    // --- 5. handles stay inside the artboard so it can be dragged back -----
    const pts = canvasMod.handlePoints(after, size);
    const inside = Object.values(pts).every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
    ok('handlesReachable', inside);
    // And grabbing the pulled-back handle really does resize.
    const sizeBefore = after.size;
    drag(pts.sw.x, pts.sw.y, pts.sw.x - 0.15, pts.sw.y + 0.15);
    await settle();
    ok('handleStillResizes', composer._doc().layers[0].size !== sizeBefore);

    // Drag it back on and the warning clears.
    const b2 = canvasMod.layerBounds(composer._doc().layers[0], size);
    drag(Math.min(0.95, b2.x + 0.02), b2.y + b2.h / 2, 0.4, 0.5);
    await settle();
    ok('warningClears', $('composerWarning').hidden === true);

    // --- 6. photo fit modes ------------------------------------------------
    const c = new OffscreenCanvas(40, 20);
    const cx = c.getContext('2d');
    cx.fillStyle = 'rgb(200,40,40)'; cx.fillRect(0, 0, 40, 20);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'p.png', { type: 'image/png' }));
    $('toolPhoto').click();
    $('photoFile').files = dt.files;
    $('photoFile').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    await settle();

    const photo = composer._doc().layers.find((l) => l.type === 'photo');
    ok('photoImported', !!photo);
    ok('defaultsToCover', photo?.fit === 'cover');
    ok('naturalSizeRecorded', photo?.srcW === 40 && photo?.srcH === 20);
    ok('fitOptions',
       [...$('photoFit').options].map((o) => o.value).join() === 'cover,contain,none');
    ok('photoPanelShown', getComputedStyle($('photoControls')).display !== 'none');
    ok('photoHintHidden', getComputedStyle($('photoEmptyHint')).display === 'none');

    $('photoFit').value = 'none';
    $('photoFit').dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    ok('fitApplied', composer._doc().layers.find((l) => l.type === 'photo').fit === 'none');

    // --- 7. canvas VIEW rotation ------------------------------------------
    const wrap = () => canvasEl().parentElement;
    // View coordinates must be measured against the WRAPPER: under a rotation
    // the canvas's own bounding rect is the axis-aligned box of the rotated
    // element, which is exactly the trap this feature has to avoid.
    const atView = (u, v) => {
      const r = wrap().getBoundingClientRect();
      return { clientX: r.left + u * r.width, clientY: r.top + v * r.height };
    };
    const vPointer = (type, u, v) => canvasEl().dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...atView(u, v),
    }));
    const vDrag = (u0, v0, u1, v1) => {
      vPointer('pointerdown', u0, v0);
      vPointer('pointermove', (u0 + u1) / 2, (v0 + v1) / 2);
      vPointer('pointermove', u1, v1);
      vPointer('pointerup', u1, v1);
    };

    const beforeRot = wrap().getBoundingClientRect();
    document.getElementById('viewRotateRight').click();
    await settle();
    await new Promise((r) => setTimeout(r, 250));   // the preference is persisted first
    await settle();
    ok('viewRotApplied', wrap().dataset.viewRot === '1');
    const afterRot = wrap().getBoundingClientRect();
    // Not a literal swap: the box is re-fitted into the stage, so the SCALE
    // changes too. What must hold is that the aspect inverted.
    ok('viewFootprintTurned',
       Math.abs((afterRot.width / afterRot.height) - (beforeRot.height / beforeRot.width)) < 0.02
       && afterRot.height > afterRot.width);
    // The BACKING STORE is untouched: the turn is presentation only.
    ok('backingStoreUnturned', canvasEl().width === 400 && canvasEl().height === 300);
    ok('panelInfoSaysViewing', /viewing at 90/.test($('composerPanelInfo').textContent));
    ok('panelInfoDistinguishes', !/· rot /.test($('composerPanelInfo').textContent));

    // renderDocument must be blind to it: same document, same pixels.
    const renderMod = await import(location.origin + '/app/v1/js/composer/render.js');
    const sig = (d) => {
      const r = renderMod.renderDocument(d, new Map());
      const px = r.ctx.getImageData(0, 0, r.width, r.height).data;
      let h = 2166136261;
      for (let i = 0; i < px.length; i += 4) { h ^= px[i]; h = Math.imul(h, 16777619); }
      return r.width + 'x' + r.height + ':' + (h >>> 0);
    };
    const docNow = composer._doc();
    const sigRotated = sig(docNow);
    document.getElementById('viewRotateLeft').click();
    await settle();
    await new Promise((r) => setTimeout(r, 250));
    await settle();
    ok('viewRotBack', wrap().dataset.viewRot === '0');
    ok('renderIsBlindToTheView', sig(composer._doc()) === sigRotated);

    // A drag under rotation must follow the FINGER. Turn right, then drag the
    // photo's centre to a known point in view space and check it landed there.
    document.getElementById('viewRotateRight').click();
    await settle();
    await new Promise((r) => setTimeout(r, 250));
    await settle();
    const photoId = composer._doc().layers.find((l) => l.type === 'photo').id;
    const boundsOf = (id) => {
      const l = composer._doc().layers.find((x) => x.id === id);
      return canvasMod.layerBounds(l, { W: canvasEl().width, H: canvasEl().height });
    };
    const pb0 = boundsOf(photoId);
    const startView = canvasMod.panelToView(pb0.x + pb0.w / 2, pb0.y + pb0.h / 2, 1);
    vDrag(startView.u, startView.v, 0.65, 0.7);
    await settle();
    const pb1 = boundsOf(photoId);
    const endView = canvasMod.panelToView(pb1.x + pb1.w / 2, pb1.y + pb1.h / 2, 1);
    ok('dragFollowsTheFinger',
       Math.abs(endView.u - 0.65) < 0.06 && Math.abs(endView.v - 0.7) < 0.06);
    out.dragEnded = endView;

    out.ok = Object.values(out.checks).every(Boolean);
    return out;
  })()`, { timeoutMs: 90000 });

  assert.ok(result?.ok, `composer UI failed: ${JSON.stringify(result, null, 1)}`);

  // The preference is per DEVICE and must survive a reload — including one that
  // reopens the composer from a freshly rendered (and therefore freshly read)
  // device card.
  const persisted = await chrome.evalOnPage(profileUrl, `(async () => {
    if (document.body.dataset.odSchema !== 'ready') throw new Error('schema not ready');
    if (!document.querySelector('#deviceList button')) throw new Error('device list not rendered');
    const composer = await import(location.origin + '/app/v1/js/composer/index.js');
    const settle = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 250)));
    [...document.querySelectorAll('#deviceList button')]
      .find((b) => b.textContent.trim() === 'Composer').click();
    await settle();
    const wrap = document.getElementById('composerCanvas').parentElement;
    return { rot: wrap.dataset.viewRot, opened: composer.hasSession() };
  })()`, { timeoutMs: 60000 });
  assert.equal(persisted?.opened, true, 'composer reopened after reload');
  assert.equal(persisted?.rot, '1', 'the canvas view rotation persisted per device');

});
