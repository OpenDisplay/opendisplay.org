// Composing must work with NO device connected.
//
// OpenDisplay tags are battery-powered and sleep between updates, so a live
// BLE link is the exception, not the norm. The product model is therefore
// compose-offline, connect-only-to-send: everything the composer needs (panel
// size, rotation, colour scheme, panel IC) comes from the SAVED record,
// captured when the device was added. Only Send may require a connection.
//
// This test exists because that property is easy to break silently — a stray
// `disabled` or an over-broad control refresh would gate the canvas on a
// connection and nobody would notice until a user with a sleeping tag tried.
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

test('the composer works with no device connected, and Send explains why it is off', async (t) => {
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
    profileDir: mkdtempSync(join(tmpdir(), 'od-offline-')),
  });
  t.after(() => chrome.close());

  const profileUrl = `http://127.0.0.1:${port}/app/`;

  // 1. Seed a saved device — as if it had been added days ago and the tag has
  //    since gone to sleep. Nothing stays connected.
  const seeded = await chrome.evalOnPage(profileUrl, `(async () => {
    if (!location.origin || location.origin === 'null') throw new Error('not navigated');
    if (document.readyState !== 'complete') throw new Error('loading');
    if (document.body.dataset.odSchema !== 'ready') throw new Error('schema not ready');
    const store = await import(location.origin + '/app/v1/js/store.js');
    const rec = await store.createDevice({
      bleId: 'sleeping-tag', name: 'Kitchen', width: 400, height: 300,
      rotationQuarterTurns: 0, colorScheme: 4, panelIcType: 35, resolutionConfirmed: true,
    });
    return rec.recordId;
  })()`, { timeoutMs: 40000 });
  assert.ok(seeded, 'device record seeded');

  // 2. Load the app FRESH (same profile, so same IndexedDB) and drive the real
  //    UI: the card's Composer button, with no connection at any point.
  const result = await chrome.evalOnPage(profileUrl, `(async () => {
    if (!location.origin || location.origin === 'null') throw new Error('not navigated');
    if (document.readyState !== 'complete') throw new Error('loading');
    if (document.body.dataset.odSchema !== 'ready') throw new Error('schema not ready');
    if (!document.querySelector('#deviceList button')) throw new Error('device list not rendered');

    const out = { checks: {} };
    const ok = (n, c) => { out.checks[n] = !!c; };
    // paint() coalesces to an animation frame, so settle before reading the DOM.
    const settle = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 250)));

    const adapter = await import(location.origin + '/app/v1/js/ble-adapter.js');
    const composer = await import(location.origin + '/app/v1/js/composer/index.js');
    ok('notConnected', adapter.getState() !== 'connected');

    // The card's Composer button must be usable with no connection; Connect is
    // the one that may be gated.
    const cardButtons = [...document.querySelectorAll('#deviceList button')]
      .map((b) => ({ text: b.textContent.trim(), disabled: b.disabled, el: b }));
    const composerBtn = cardButtons.find((b) => b.text === 'Composer');
    ok('cardHasComposer', !!composerBtn);
    ok('cardComposerEnabled', composerBtn && composerBtn.disabled === false);

    // Open it exactly as a user would.
    composerBtn.el.click();
    await settle();
    ok('composerOpened', composer.hasSession());
    ok('composerViewShown', document.getElementById('viewComposer').hidden === false);

    // Panel geometry comes from the SAVED record, so the canvas is real.
    const canvas = document.getElementById('composerCanvas');
    ok('canvasSized', canvas.width === 400 && canvas.height === 300);
    ok('panelInfoFromRecord',
       document.getElementById('composerPanelInfo').textContent.includes('400×300'));

    // Editing works offline.
    const origPrompt = window.prompt;
    window.prompt = () => 'https://opendisplay.org';
    document.getElementById('toolQr').click();
    window.prompt = origPrompt;
    await settle();
    await new Promise((r) => setTimeout(r, 600)); // debounced dither
    ok('layerAdded',
       document.getElementById('composerPanelInfo').textContent.includes('1 layer'));

    // The dithered preview renders with no radio involved.
    const px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const seen = new Set();
    for (let i = 0; i < px.length; i += 4) seen.add(px[i] + ',' + px[i+1] + ',' + px[i+2]);
    ok('previewRendered', seen.size >= 2);

    // Only SEND is gated — and it says why.
    const send = document.getElementById('sendBtn');
    ok('sendDisabled', send.disabled === true);
    ok('sendExplains', /connect/i.test(send.title));

    out.ok = Object.values(out.checks).every(Boolean);
    return out;
  })()`, { timeoutMs: 60000 });

  assert.ok(result?.ok, `offline compose failed: ${JSON.stringify(result, null, 1)}`);
});
