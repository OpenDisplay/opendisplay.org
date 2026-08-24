// Supply-chain guard for the vendored wasm bundle.
//
// The bundle is a 200 KB third-party artifact that runs on every send, so its
// provenance must be ENFORCED, not merely documented: this test fails if the
// checked-in file stops matching the hash recorded in vendor/README.md, or if
// the exports and palette ORDER the app depends on ever change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const VENDOR = resolve(dirname(fileURLToPath(import.meta.url)), '../../httpdocs/app/v1/vendor');
const BUNDLE = join(VENDOR, 'epaper-dithering.js');
const README = readFileSync(join(VENDOR, 'README.md'), 'utf8');

test('vendored bundle matches the SHA-256 recorded in vendor/README.md', () => {
  const actual = createHash('sha256').update(readFileSync(BUNDLE)).digest('hex');
  const documented = README.match(/File SHA-256 \| `([0-9a-f]{64})`/)?.[1];
  assert.ok(documented, 'README records a file hash');
  assert.equal(actual, documented,
    'the vendored file changed without its README hash being updated — ' +
    're-vendor deliberately and update vendor/README.md');
});

test('vendor README records the provenance the plan requires', () => {
  assert.match(README, /Version \| \*\*\d+\.\d+\.\d+\*\*/, 'version');
  assert.match(README, /Tarball SHA-256 \| `[0-9a-f]{64}`/, 'tarball hash');
  assert.match(README, /registry\.npmjs\.org/, 'source URL');
  assert.match(README, /Permission is hereby granted, free of charge/, 'MIT licence text');
});

test('the REAL bundle exposes the exports and palette order the app relies on', async () => {
  // Imported through a data: URL because the app ships .js (browser MIME
  // safety) which Node would otherwise treat as CommonJS.
  const src = readFileSync(BUNDLE, 'utf8');
  const lib = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);

  for (const name of ['ditherImage', 'ColorScheme', 'DitherMode']) {
    assert.equal(typeof lib[name] !== 'undefined', true, `exports ${name}`);
  }
  // Measured palettes the app maps panels onto (composer/dither.js).
  for (const name of [
    'SPECTRA_7_3_6COLOR', 'SPECTRA_7_3_6COLOR_V2', 'MONO_4_26', 'SOLUM_BWR', 'BWRY_3_97',
  ]) {
    assert.ok(lib[name], `exports measured palette ${name}`);
  }
  // Scheme numbering must stay wire-compatible.
  assert.equal(lib.ColorScheme.MONO, 0);
  assert.equal(lib.ColorScheme.BWR, 1);
  assert.equal(lib.ColorScheme.BWY, 2);
  assert.equal(lib.ColorScheme.BWRY, 3);
  assert.equal(lib.ColorScheme.BWGBRY, 4);
  assert.equal(lib.ColorScheme.GRAYSCALE_4, 5);
  assert.equal(lib.ColorScheme.GRAYSCALE_16, 6);
  assert.equal(lib.ColorScheme.BWGBRY_SPLIT, 8);
  assert.equal(lib.DitherMode.BURKES, 1);
});

test('palette ORDER matches the ideal wire palettes the paint-back assumes', async () => {
  const src = readFileSync(BUNDLE, 'utf8');
  const lib = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  const { IDEAL_PALETTES } = await import('./lib/load-app-module.mjs')
    .then((m) => m.loadAppModule('composer/palettes.js'));

  // A 2x1 probe is enough: what matters is the palette the library REPORTS,
  // since paint-back maps index -> IDEAL_PALETTES[scheme][index].
  const probe = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
  for (const scheme of [0, 1, 2, 3, 4, 6, 8]) {
    const res = lib.ditherImage({ data: probe, width: 2, height: 1 }, scheme, { mode: 0 });
    const got = res.palette.map((c) => [c.r, c.g, c.b]);
    assert.deepEqual(got, IDEAL_PALETTES[scheme],
      `scheme ${scheme}: library palette order must equal IDEAL_PALETTES ` +
      '(paint-back maps indices through it)');
  }
});
