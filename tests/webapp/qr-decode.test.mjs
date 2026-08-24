// Independent DECODE round-trip for the extracted QR core (plan §6/§10):
// render each matrix to an image and decode it with OpenCV's QRCodeDetector —
// a completely separate implementation — asserting the decoded text matches.
//
// This is the correctness proof that the cross-encoder comparison cannot give:
// conformant encoders legitimately differ in mask choice, padding and mode
// selection, but a decoder either reads the payload back or it does not.
//
// OpenCV is fetched on demand with uvx, so the test is skipped unless
// OD_QR_DECODE_TEST=1 (or CI) is set — see tests/webapp/README.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAppModule } from './lib/load-app-module.mjs';

const execFileAsync = promisify(execFile);
const qr = await loadAppModule('composer/qr.js');

const CASES = [
  ['hi', 'L'],
  ['https://opendisplay.org', 'M'],
  ['https://opendisplay.org/firmware/toolbox/', 'Q'],
  ['OD-2F41 kitchen tag', 'H'],
  ['日本語テキスト', 'L'], // non-ASCII: expect the documented UTF-8 BOM prefix
];

const DECODER_PY = `
import json, sys
import numpy as np, cv2
data = json.load(open(sys.argv[1]))
det = cv2.QRCodeDetector()
out = []
for c in data:
    n = c['size']; q = 4; scale = 8   # 4-module quiet zone, 8px modules
    img = np.ones(((n + 2*q) * scale, (n + 2*q) * scale), dtype=np.uint8) * 255
    for r, row in enumerate(c['rows']):
        for col, ch in enumerate(row):
            if ch == '1':
                y = (r + q) * scale; x = (col + q) * scale
                img[y:y+scale, x:x+scale] = 0
    txt, _, _ = det.detectAndDecode(img)
    out.append({'text': c['text'], 'decoded': txt})
json.dump(out, sys.stdout)
`;

test('QR matrices decode back to their payload (OpenCV, independent decoder)', async (t) => {
  if (!process.env.OD_QR_DECODE_TEST && !process.env.CI) {
    t.skip('set OD_QR_DECODE_TEST=1 to run (downloads OpenCV via uvx)');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'od-qr-decode-'));
  const matrices = CASES.map(([text, ecl]) => {
    const g = qr.encodeQrMatrix(text, { errorCorrectLevel: ecl });
    const rows = [];
    for (let r = 0; r < g.size; r++) {
      rows.push(Array.from(g.modules.subarray(r * g.size, (r + 1) * g.size)).join(''));
    }
    return { text, ecl, size: g.size, rows };
  });
  const dataPath = join(dir, 'matrices.json');
  const scriptPath = join(dir, 'decode.py');
  writeFileSync(dataPath, JSON.stringify(matrices));
  writeFileSync(scriptPath, DECODER_PY);

  const { stdout } = await execFileAsync(
    'uvx',
    ['--with', 'numpy', '--from', 'opencv-python-headless', 'python', scriptPath, dataPath],
    { encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 },
  );
  const results = JSON.parse(stdout);
  assert.equal(results.length, CASES.length);
  for (const { text, decoded } of results) {
    // Non-ASCII payloads come back with the upstream library's UTF-8 BOM
    // (documented in composer/qr.js); everything else must be exact.
    const normalised = decoded.replace(/^﻿/, '');
    assert.equal(normalised, text, `decode mismatch for ${JSON.stringify(text.slice(0, 24))}`);
  }
});
