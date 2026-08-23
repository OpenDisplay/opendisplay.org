// Real-browser canvas round-trip (the M-S(a) criterion the Node fake canvas
// cannot cover): a REAL Chromium canvas + putImageData/getImageData + the real
// classic-script load of ble-common.js. Proves:
//  1. opaque canonical-palette pixels survive the canvas round-trip and encode
//     byte-identically to the reference (sRGB context, schemes 0 and 4),
//  2. the transparency hazard is REAL: alpha-0 white pixels come back RGB 0
//     from the premultiplied backing store and encode as BLACK — the empirical
//     basis for the plan's opaque-ImageData rule.
//
// Zero dependencies: headless Chrome renders a self-reporting page and
// --dump-dom returns its results. Skips (with a visible skip) if no Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { refMono, refBwgbry } from './lib/reference-encoders.mjs';
import { PAINT_PALETTES, makeIndices } from './lib/fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BLE_COMMON = resolve(HERE, '../../httpdocs/js/ble-common.js');

const CHROME = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']
  .map((n) => `/usr/bin/${n}`)
  .find((p) => existsSync(p));

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const W = 13;
const H = 7;
const monoIdx = makeIndices(W, H, 2, 31337);
const sixIdx = makeIndices(W, H, 6, 31338);

const fixtures = {
  width: W,
  height: H,
  mono: { indices: monoIdx, palette: PAINT_PALETTES[0], scheme: 0 },
  six: { indices: sixIdx, palette: PAINT_PALETTES[4], scheme: 4 },
};

const PAGE = `<!DOCTYPE html><html><body><script src="file://${BLE_COMMON}"></script>
<script>
const FIX = ${JSON.stringify(fixtures)};
function paint(ctx, indices, palette, alpha) {
  const img = ctx.createImageData(FIX.width, FIX.height);
  for (let i = 0; i < indices.length; i++) {
    const [r, g, b] = palette[indices[i]];
    img.data[i*4] = r; img.data[i*4+1] = g; img.data[i*4+2] = b; img.data[i*4+3] = alpha;
  }
  ctx.putImageData(img, 0, 0);
}
function run() {
  const out = {};
  try {
    const ble = new OpenDisplayBLE();
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = FIX.width; c.height = FIX.height;
      return c;
    };
    for (const [name, f] of [['mono', FIX.mono], ['six', FIX.six]]) {
      const c = mk();
      const ctx = c.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
      paint(ctx, f.indices, f.palette, 255);
      out[name] = ble.encodeCanvasToByteData(c, f.scheme, 0, FIX.width, FIX.height, null)
        .map(b => b.toString(16).padStart(2, '0')).join('');
    }
    // transparency hazard: all-white indices painted with alpha 0
    const c = mk();
    const ctx = c.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    paint(ctx, FIX.mono.indices.map(() => 1), FIX.mono.palette, 0);
    out.transparentWhite = ble.encodeCanvasToByteData(c, 0, 0, FIX.width, FIX.height, null)
      .map(b => b.toString(16).padStart(2, '0')).join('');
    out.ok = true;
  } catch (e) {
    out.ok = false; out.error = String(e && e.stack || e);
  }
  document.title = 'done';
  document.body.textContent = 'RESULT:' + JSON.stringify(out) + ':END';
}
run();
</script></body></html>`;

test('real Chromium canvas round-trip: opaque parity + transparency hazard', (t) => {
  if (!CHROME) {
    t.skip('no Chrome/Chromium binary found');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'od-webapp-spike-'));
  const page = join(dir, 'roundtrip.html');
  writeFileSync(page, PAGE);
  const dom = execFileSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--allow-file-access-from-files',
      `--user-data-dir=${join(dir, 'profile')}`,
      '--virtual-time-budget=10000',
      '--dump-dom',
      `file://${page}`,
    ],
    { encoding: 'utf8', timeout: 60000 },
  );
  const m = dom.match(/RESULT:(.*?):END/s);
  assert.ok(m, `no result marker in dumped DOM:\n${dom.slice(0, 500)}`);
  const result = JSON.parse(m[1]);
  assert.ok(result.ok, `page error: ${result.error}`);

  assert.equal(result.mono, toHex(refMono(monoIdx, W, H)), 'mono opaque round-trip');
  assert.equal(result.six, toHex(refBwgbry(sixIdx, W, H)), '6-color opaque round-trip');

  // White painted at alpha 0 must NOT encode as white — the premultiplied
  // backing store zeroes RGB, so it encodes as all-black. If this ever equals
  // the all-white encoding, the opaque-ImageData rule would be unnecessary;
  // its failure here is the point.
  const allWhite = toHex(refMono(monoIdx.map(() => 1), W, H));
  const allBlack = toHex(refMono(monoIdx.map(() => 0), W, H));
  assert.notEqual(result.transparentWhite, allWhite, 'transparency corrupted RGB as expected');
  assert.equal(result.transparentWhite, allBlack, 'alpha-0 pixels read back as black');
});
