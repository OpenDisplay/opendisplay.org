// M0 boot smoke test: serve httpdocs/ over local HTTP (so the absolute
// /firmware/toolbox/config.yaml schema path resolves) and boot the real
// app/index.html in real headless Chromium. Asserts the skeleton reaches a
// deterministic state: either schema-ready ("Ready.") with the empty state
// visible, or the capability gate showing a real message — never a silent
// half-boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Chrome must run ASYNCHRONOUSLY: the fixture HTTP server lives in this same
// process, and a sync exec would block the event loop and deadlock the fetch.
const execFileAsync = promisify(execFile);
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';

const HTTPDOCS = resolve(dirname(fileURLToPath(import.meta.url)), '../../httpdocs');

const CHROME = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']
  .map((n) => `/usr/bin/${n}`)
  .find((p) => existsSync(p));

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.yaml': 'text/yaml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
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

test('app skeleton boots: schema ready or explicit gate, never a half-boot', async (t) => {
  if (!CHROME) {
    if (process.env.OD_REQUIRE_BROWSER_TESTS || process.env.CI) {
      assert.fail('no Chrome/Chromium binary found and browser tests are required');
    }
    t.skip('no Chrome/Chromium binary found');
    return;
  }
  const { server, port } = await serveHttpdocs();
  t.after(() => server.close());

  const dir = mkdtempSync(join(tmpdir(), 'od-webapp-boot-'));
  const { stdout: dom } = await execFileAsync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      `--user-data-dir=${join(dir, 'profile')}`,
      '--virtual-time-budget=15000',
      '--dump-dom',
      `http://127.0.0.1:${port}/app/index.html`,
    ],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 },
  );

  const status = dom.match(/id="statusLine"[^>]*>([^<]*)</)?.[1] ?? '';
  const gateHidden = /id="gateBanner"[^>]*\bhidden\b/.test(dom);
  const gateText = dom.match(/id="gateBanner"[^>]*>([^<]*)</)?.[1]?.trim() ?? '';
  const schemaState = dom.match(/data-od-schema="([^"]*)"/)?.[1] ?? '';

  // Boot is schema-FIRST: the schema must reach "ready" through the real
  // fetch + js-yaml + validation path regardless of Bluetooth availability.
  assert.equal(schemaState, 'ready', `schema state "${schemaState}" (status "${status}")`);

  if (gateHidden) {
    // Full boot path: device view rendered.
    assert.equal(status, 'Ready.', `expected Ready, got status "${status}"`);
    assert.ok(!/id="emptyState"[^>]*\bhidden\b/.test(dom), 'empty state should be visible');
  } else {
    // Gated path (e.g. no BT adapter in the CI runner): a real message, and the
    // status line must reflect the gate — not the initial "Loading…".
    assert.ok(gateText.length > 10, `gate shown but empty: "${gateText}"`);
    assert.notEqual(status, 'Loading…', 'status line stuck at initial state');
  }
});
