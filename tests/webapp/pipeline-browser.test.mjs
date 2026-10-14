// M3 END-TO-END pipeline proof, in real Chromium:
//
//   composer document → worker (real wasm dither) → ideal-palette paint-back
//   → the REAL ble-common.js encoder → packed bytes
//
// and asserts those bytes equal what an INDEPENDENT reference produces for the
// same indices (the same JS port of py-opendisplay's packing used by the
// M-S(a) spike, whose fixtures are Python-generated). This is the M3 exit
// criterion: the composer's output is byte-identical to what py-opendisplay
// would have sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { ChromeCdp } from './lib/chrome-cdp.mjs';
import {
  refMono, refBwr, refBwy, refBwry, bwryCodes, refBwgbry, refBwgbrySplit,
  refGray4, gray4Codes, refGray16,
} from './lib/reference-encoders.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTTPDOCS = resolve(HERE, '../../httpdocs');

/** Indices produced by the PYTHON binding of the same Rust core — a different
 *  language binding, so agreement proves the dither itself, not just packing. */
const DITHER_GOLDEN = JSON.parse(readFileSync(join(HERE, 'fixtures/dither-golden.json'), 'utf8'));

const CHROME = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']
  .map((n) => `/usr/bin/${n}`)
  .find((p) => existsSync(p));

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.yaml': 'text/yaml', '.json': 'application/json',
};

// Panels chosen to cover every supported packing path plus both gray LUTs and
// the BWRY panel whose wire codes are swapped.
const PANELS = [
  { name: 'mono',        width: 61, height: 37, colorScheme: 0, panelIcType: 39, rot: 0 },
  { name: 'bwr',         width: 48, height: 24, colorScheme: 1, panelIcType: 33, rot: 0 },
  { name: 'bwy',         width: 48, height: 24, colorScheme: 2, panelIcType: null, rot: 0 },
  { name: 'bwry',        width: 40, height: 20, colorScheme: 3, panelIcType: 55, rot: 0 },
  { name: 'bwry_swap',   width: 40, height: 20, colorScheme: 3, panelIcType: 0x1d, rot: 0 },
  { name: 'bwgbry',      width: 61, height: 37, colorScheme: 4, panelIcType: 35, rot: 0 },
  { name: 'bwgbry_rot',  width: 61, height: 37, colorScheme: 4, panelIcType: 35, rot: 1 },
  { name: 'gray4',       width: 40, height: 20, colorScheme: 5, panelIcType: null, rot: 0 },
  { name: 'gray4_v2',    width: 40, height: 20, colorScheme: 5, panelIcType: 0x28, rot: 0 },
  { name: 'gray16',      width: 40, height: 20, colorScheme: 6, panelIcType: null, rot: 0 },
  { name: 'split',       width: 40, height: 20, colorScheme: 8, panelIcType: 66, rot: 0 },
];

const FIXTURE = `<!DOCTYPE html><html><body>
<script src="/js/js-yaml.min.js"></script>
<script src="/js/ble-common.js"></script>
<script type="module">
window.resultPromise = (async () => {
  const model = await import('/app/v1/js/composer/model.js');
  const { paintForSend } = await import('/app/v1/js/composer/dither.js');
  const { makeCanvas } = await import('/app/v1/js/composer/render.js');
  const { createDitherClient } = await import('/app/v1/js/composer/dither-client.js');

  const PANELS = ${JSON.stringify(PANELS)};
  const GOLDEN = ${JSON.stringify(DITHER_GOLDEN)};
  const out = { panels: {}, dither: {}, errors: [] };

  const client = createDitherClient({
    workerUrl: '/app/v1/js/composer/dither-worker.js',
    onResult: (m) => { pending.get(m.id)?.resolve(m); pending.delete(m.id); },
    onError: (e) => { for (const p of pending.values()) p.reject(e); pending.clear(); },
  });
  const pending = new Map();
  const renderOnce = (doc, options) => new Promise((resolve, reject) => {
    const id = client.request(doc, options);
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('dither timeout')); } }, 30000);
  });

  const ble = new OpenDisplayBLE();

  for (const panel of PANELS) {
    try {
      // A deterministic, colourful document: photo-like gradient plus shapes,
      // so the dither actually has work to do.
      let doc = model.createDocument({
        recordId: panel.name, width: panel.width, height: panel.height,
        rotationQuarterTurns: panel.rot, colorScheme: panel.colorScheme,
        panelIcType: panel.panelIcType,
      });
      doc = model.addLayer(doc, model.strokeLayer({
        points: [{x:0.05,y:0.2},{x:0.5,y:0.8},{x:0.95,y:0.3}], color: 0, width: 0.08 }));
      doc = model.addLayer(doc, model.textLayer({ text: 'OD', x: 0.1, y: 0.1, size: 0.3, color: 0 }));

      const res = await renderOnce(doc, { mode: 1, serpentine: true, useMeasured: true });

      // Paint the indices back as EXACT ideal palette RGB (plus the BWRY
      // panel swap) and hand that canvas to the REAL shared encoder.
      const rgba = paintForSend(res.indices.slice(), panel.colorScheme, panel.panelIcType);
      const { canvas, ctx } = makeCanvas(res.width, res.height);
      ctx.putImageData(new ImageData(rgba, res.width, res.height), 0, 0);

      const packed = ble.encodeCanvasToByteData(
        canvas, panel.colorScheme, panel.rot, panel.width, panel.height, panel.panelIcType);

      out.panels[panel.name] = {
        width: res.width, height: res.height, measured: res.measured,
        indices: Array.from(res.indices),
        packedHex: packed.map((b) => b.toString(16).padStart(2, '0')).join(''),
      };
    } catch (err) {
      out.errors.push(panel.name + ': ' + String(err && err.message || err));
    }
  }
  // --- cross-language dither check: the SAME image through the wasm binding
  // must produce the SAME indices the Python binding produced.
  try {
    const lib = await import('/app/v1/vendor/epaper-dithering.js');
    const { width: gw, height: gh } = GOLDEN;
    // Rebuild the reference image exactly as generate_dither_golden.py does.
    const rgba = new Uint8ClampedArray(gw * gh * 4);
    const put = (x, y, r, g, b) => {
      const i = (y * gw + x) * 4;
      rgba[i] = r; rgba[i+1] = g; rgba[i+2] = b; rgba[i+3] = 255;
    };
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        put(x, y,
          Math.floor((x * 255) / (gw - 1)),
          Math.floor((y * 255) / (gh - 1)),
          Math.floor(((x + y) * 255) / (gw + gh - 2)));
      }
    }
    for (let y = 2; y < 6; y++) for (let x = 2; x < 10; x++) put(x, y, 255, 40, 40);

    for (const c of GOLDEN.cases) {
      const target = c.measuredPalette ? lib[c.measuredPalette] : c.colorScheme;
      const res = lib.ditherImage({ data: rgba, width: gw, height: gh }, target,
        { mode: c.mode, serpentine: true });
      out.dither[c.name] = {
        indices: Array.from(res.indices),
        palette: res.palette.map((p) => [p.r, p.g, p.b]),
      };
    }
  } catch (err) {
    out.errors.push('dither-golden: ' + String(err && err.message || err));
  }

  client.terminate();
  out.ok = out.errors.length === 0;
  return out;
})();
</script></body></html>`;

function serve() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (path.startsWith('/__test__/pipeline')) {
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

/** Independent packing of the SAME indices, in native panel orientation. */
function referencePack(panel, indices) {
  const { width: w, height: h, colorScheme: s, panelIcType: p } = panel;
  switch (s) {
    case 0: return refMono(indices, w, h);
    case 1: return refBwr(indices, w, h);
    case 2: return refBwy(indices, w, h);
    case 3: return refBwry(indices, w, h, bwryCodes(p));
    case 4: return refBwgbry(indices, w, h);
    case 5: return refGray4(indices, w, h, gray4Codes(p));
    case 6: return refGray16(indices, w, h);
    case 8: return refBwgbrySplit(indices, w, h);
    default: throw new Error(`unsupported scheme ${s}`);
  }
}

/** Undo the composer's rotated artboard: the dither output is in ARTBOARD
 *  orientation, while the reference packs NATIVE orientation. */
function artboardToNative(indices, panel, artW, artH) {
  if (!panel.rot) return indices;
  const native = new Array(panel.width * panel.height);
  for (let y = 0; y < artH; y++) {
    for (let x = 0; x < artW; x++) {
      let dstX; let dstY;
      if (panel.rot === 1) { dstX = artH - 1 - y; dstY = x; }
      else if (panel.rot === 2) { dstX = artW - 1 - x; dstY = artH - 1 - y; }
      else { dstX = y; dstY = artW - 1 - x; }
      native[dstY * panel.width + dstX] = indices[y * artW + x];
    }
  }
  return native;
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

test('composer → wasm dither → paint-back → encoder is byte-identical to the reference', async (t) => {
  if (!CHROME) {
    if (process.env.OD_REQUIRE_BROWSER_TESTS || process.env.CI) {
      assert.fail('no Chrome/Chromium binary found and browser tests are required');
    }
    t.skip('no Chrome/Chromium binary found');
    return;
  }
  const { server, port } = await serve();
  t.after(() => server.close());
  const profile = mkdtempSync(join(tmpdir(), 'od-pipeline-'));
  const chrome = await ChromeCdp.launch(CHROME, { profileDir: profile });
  t.after(() => chrome.close());

  const result = await chrome.evalOnPage(
    `http://127.0.0.1:${port}/__test__/pipeline.html`,
    "window.resultPromise || (() => { throw new Error('module not ready'); })()",
    { timeoutMs: 120000 },
  );
  assert.deepEqual(result.errors, [], 'every panel dithered and packed');

  for (const panel of PANELS) {
    const got = result.panels[panel.name];
    assert.ok(got, `${panel.name} produced a result`);

    const nativeIndices = artboardToNative(got.indices, panel, got.width, got.height);
    const expected = referencePack(panel, nativeIndices);
    assert.equal(got.packedHex, toHex(expected),
      `${panel.name}: encoder output must match the py-opendisplay reference packing`);
  }

  // --- the dither itself matches the Python binding of the same Rust core ---
  for (const c of DITHER_GOLDEN.cases) {
    const got = result.dither[c.name];
    assert.ok(got, `${c.name} was dithered in the browser`);
    assert.deepEqual(got.palette, c.palette,
      `${c.name}: palette (and its ORDER) must match the Python binding`);
    assert.deepEqual(got.indices, c.indices,
      `${c.name}: wasm indices must match epaper_dithering@${DITHER_GOLDEN.version} (python)`);
  }

  // The measured-palette path must actually have been taken where one exists.
  assert.equal(result.panels.bwgbry.measured, true, '7.3" Spectra uses its measured palette');
  assert.equal(result.panels.gray16.measured, false, 'unmeasured panel falls back to ideal');
});
