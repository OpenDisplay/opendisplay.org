// M0/M1 boot smoke test over CDP: serve httpdocs/ (so the absolute
// /firmware/toolbox/config.yaml schema path resolves) and boot the real
// app/index.html in real Chromium. Asserts the app reaches a deterministic
// state: schema ready (through the real fetch + js-yaml + validation path,
// asserted regardless of Bluetooth availability), then either the full ready
// state with the device view or an explicit gate — never a half-boot.
// CDP is required because M1's device list touches IndexedDB, which
// --dump-dom's virtual time never services.
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

function serveHttpdocs() {
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
  return new Promise((resolvePort) => {
    server.listen(0, '127.0.0.1', () => resolvePort({ server, port: server.address().port }));
  });
}

test('app boots: schema ready, then full-ready or explicit gate — never a half-boot', async (t) => {
  if (!CHROME) {
    if (process.env.OD_REQUIRE_BROWSER_TESTS || process.env.CI) {
      assert.fail('no Chrome/Chromium binary found and browser tests are required');
    }
    t.skip('no Chrome/Chromium binary found');
    return;
  }
  const { server, port } = await serveHttpdocs();
  t.after(() => server.close());
  const profile = mkdtempSync(join(tmpdir(), 'od-boot-profile-'));

  const chrome = await ChromeCdp.launch(CHROME, { profileDir: profile });
  t.after(() => chrome.close());

  // Poll (via throw) until boot() reached a terminal state.
  const state = await chrome.evalOnPage(
    `http://127.0.0.1:${port}/app/index.html`,
    `(() => {
      const schema = document.body.dataset.odSchema;
      const gate = document.body.dataset.odGate;
      const status = document.getElementById('statusLine')?.textContent ?? '';
      const gateEl = document.getElementById('gateBanner');
      const terminal = (schema === 'ready' && (gate !== undefined)) || schema === 'failed';
      if (!terminal) throw new Error('boot still in progress: ' + JSON.stringify({schema, gate, status}));
      return {
        schema, gate, status,
        gateHidden: gateEl.hidden,
        gateText: gateEl.textContent.trim(),
        emptyHidden: document.getElementById('emptyState').hidden,
        addDisabled: document.getElementById('btnAddDevice').disabled,
      };
    })()`,
  );

  // Schema must load through the real path regardless of Bluetooth.
  assert.equal(state.schema, 'ready', `schema state: ${JSON.stringify(state)}`);

  if (state.gate === 'none') {
    assert.equal(state.status, 'Ready.');
    assert.equal(state.gateHidden, true);
    assert.equal(state.emptyHidden, false, 'empty state visible with no records');
    assert.equal(state.addDisabled, false, 'Add device enabled');
  } else {
    assert.ok(state.gateText.length > 10, `gate shown but empty: ${JSON.stringify(state)}`);
    assert.equal(state.gateHidden, false);
    assert.notEqual(state.status, 'Loading…');
    // Device list still initialised (records viewable while gated).
    assert.equal(state.emptyHidden, false, 'empty state visible even when gated');
  }
});
