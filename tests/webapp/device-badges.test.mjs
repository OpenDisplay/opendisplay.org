// The badge on a device card.
//
// It used to read "Permission missing" for three unrelated situations, none of
// which is a fault and all of which still connect. The one that mattered most
// is the third: where getDevices() is unavailable or slow, the permission sweep
// returns nothing and EVERY saved device was labelled as though its permission
// had been revoked — when in truth the browser never answered. This test runs
// in exactly that environment (headless Chrome has no Bluetooth backend), so it
// pins the rule directly: when we cannot tell, say nothing.
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

test('a device card never claims a permission problem it cannot verify', async (t) => {
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
    profileDir: mkdtempSync(join(tmpdir(), 'od-badge-')),
  });
  t.after(() => chrome.close());
  const profileUrl = `http://127.0.0.1:${port}/app/`;

  await chrome.evalOnPage(profileUrl, `(async () => {
    if (document.body.dataset.odSchema !== 'ready') throw new Error('schema not ready');
    const store = await import(location.origin + '/app/v1/js/store.js');
    // BOUND: matched to a radio in this browser at some point.
    await store.createDevice({
      bleId: 'bound-tag', name: 'Kitchen', width: 400, height: 300,
      rotationQuarterTurns: 0, colorScheme: 4, panelIcType: 35, resolutionConfirmed: true,
    });
    // IMPORTED: a saved record that has never been matched to anything here.
    await store.importDevices({ format: 'od-app-devices', version: 1, devices: [{
      recordId: 'imported-1', name: 'Hallway', width: 296, height: 128,
      rotationQuarterTurns: 0, colorScheme: 1, transmissionModes: 0,
      partialUpdateSupport: 0, panelIcType: 35, resolutionConfirmed: true,
    }] });
    return 1;
  })()`, { timeoutMs: 40000 });

  const badges = await chrome.evalOnPage(profileUrl, `(async () => {
    if (document.body.dataset.odSchema !== 'ready') throw new Error('schema not ready');
    if (!document.querySelector('#deviceList .odapp-card')) throw new Error('list not rendered');
    await new Promise((r) => setTimeout(r, 500));   // let the permission sweep settle
    return [...document.querySelectorAll('.odapp-card')].map((card) => {
      const chip = card.querySelector('.odapp-chip');
      return {
        name: card.querySelector('.odapp-card__name').textContent.trim(),
        text: chip ? chip.textContent.trim() : null,
        title: chip ? chip.title : null,
      };
    });
  })()`, { timeoutMs: 60000 });

  assert.equal(badges.length, 2, `expected two cards, got ${JSON.stringify(badges)}`);
  const byName = Object.fromEntries(badges.map((b) => [b.name, b]));

  // getDevices() cannot answer in this environment. The BOUND device must
  // therefore carry NO badge — the old code said "Permission missing" here,
  // which was a guess dressed up as a fact.
  assert.equal(byName.Kitchen?.text, null,
    'a bound device must show nothing when the sweep could not answer');

  // The imported record is a different case entirely, and is stated as such:
  // nothing was ever granted, so nothing can be missing.
  assert.equal(byName.Hallway?.text, 'Not linked yet');
  assert.match(byName.Hallway.title, /never matched to a physical tag/);

  // Whatever any badge says, it must not imply a fault or a blocker.
  for (const b of badges) {
    if (!b.text) continue;
    assert.doesNotMatch(b.text, /missing|denied|error|fail/i,
      `badge "${b.text}" reads as a fault, but none of these states is one`);
  }
});
