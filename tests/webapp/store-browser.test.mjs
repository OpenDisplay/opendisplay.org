// M1 store tests against REAL IndexedDB in real Chromium, driven over CDP
// (lib/chrome-cdp.mjs) because --dump-dom's virtual time never lets IndexedDB
// callbacks run. The fixture page is served virtually at /__test__/ (never
// present in httpdocs, never deployed) and imports the REAL store.js/keys.js.
//
// Two sequential Chrome launches share one profile and one server port (same
// origin), so run 2 proves records and keys persist across a browser restart.
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
  const store = await import('/app/v1/js/store.js');
  const keys = await import('/app/v1/js/keys.js');
  const phase = new URL(location.href).searchParams.get('phase');
  const out = { phase, checks: {} };
  const ok = (name, cond) => { out.checks[name] = !!cond; };

  if (phase === '1') {
    const a = await store.createDevice({
      bleId: 'ble-A', name: 'OD-A', width: 800, height: 480,
      rotationQuarterTurns: 1, colorScheme: 4, resolutionConfirmed: true,
      authRequired: true,
    });
    const b = await store.createDevice({
      bleId: 'ble-B', name: 'OD-B', width: 122, height: 250, colorScheme: 0,
      resolutionConfirmed: true,
    });
    await keys.saveKey(a.recordId, new Uint8Array(16).fill(0xab));
    ok('created', (await store.listDevices()).length === 2);

    // Rebind A: key must follow recordId.
    await store.commitRebind(a.recordId, 'ble-A2');
    const a2 = await store.getDevice(a.recordId);
    ok('rebindBleId', a2.bleId === 'ble-A2');
    const keyAfter = await keys.getKey(a.recordId);
    ok('keyFollowsRecord', keyAfter && keyAfter[0] === 0xab);

    ok('unexportedNag', await keys.hasUnexportedKey(a.recordId));
    const hex = await keys.exportKey(a.recordId);
    ok('exportHex', hex === 'ab'.repeat(16));
    ok('exportedCleared', !(await keys.hasUnexportedKey(a.recordId)));

    const payload = await store.exportDevices();
    ok('exportStripsBleId', payload.devices.every((d) => d.bleId === undefined));

    await store.forgetDevice(b.recordId);
    const remaining = await store.listDevices();
    ok('forgetCascade', remaining.length === 1 && remaining[0].recordId === a.recordId);
  } else {
    const devices = await store.listDevices();
    ok('persistedDevice', devices.length === 1 && devices[0].name === 'OD-A'
       && devices[0].bleId === 'ble-A2' && devices[0].rotationQuarterTurns === 1);
    const key = devices.length ? await keys.getKey(devices[0].recordId) : null;
    ok('persistedKey', !!key && key.length === 16 && key[5] === 0xab);

    const payload = { format: 'od-app-devices', version: 1,
      devices: [{ ...devices[0], bleId: 'SHOULD-NOT-APPLY' }] };
    await store.importDevices(payload);
    const after = await store.getDevice(devices[0].recordId);
    ok('importKeepsBinding', after.bleId === 'ble-A2');
  }
  out.ok = Object.values(out.checks).every(Boolean);
  return out;
})();
</script></body></html>`;

function serve() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (path.startsWith('/__test__/store-fixture')) {
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

async function runPhase(profile, url) {
  const chrome = await ChromeCdp.launch(CHROME, { profileDir: profile });
  try {
    // Throws until the module has installed the promise, so evalOnPage polls.
    return await chrome.evalOnPage(
      url,
      "window.resultPromise || (() => { throw new Error('module not ready'); })()",
    );
  } finally {
    await chrome.close();
  }
}

test('store + keys against real IndexedDB, incl. restart persistence', async (t) => {
  if (!CHROME) {
    if (process.env.OD_REQUIRE_BROWSER_TESTS || process.env.CI) {
      assert.fail('no Chrome/Chromium binary found and browser tests are required');
    }
    t.skip('no Chrome/Chromium binary found');
    return;
  }
  const { server, port } = await serve();
  t.after(() => server.close());
  const profile = mkdtempSync(join(tmpdir(), 'od-store-profile-'));

  const r1 = await runPhase(profile, `http://127.0.0.1:${port}/__test__/store-fixture.html?phase=1`);
  assert.ok(r1?.ok, `phase 1 failed: ${JSON.stringify(r1)}`);

  const r2 = await runPhase(profile, `http://127.0.0.1:${port}/__test__/store-fixture.html?phase=2`);
  assert.ok(r2?.ok, `phase 2 (restart) failed: ${JSON.stringify(r2)}`);
});
