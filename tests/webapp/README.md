# Web OD App test suite

Dev-only; nothing here is deployed. `httpdocs/` stays build-free.

```bash
node --test tests/webapp/            # everything (Chrome-backed tests included)
OD_QR_DECODE_TEST=1 node --test tests/webapp/qr-decode.test.mjs
```

## Layers

| File | What it proves |
|---|---|
| `encoder-parity.test.mjs`, `golden.test.mjs`, `rotation-oracle.test.mjs` | The paint-back architecture: `ble-common.js` packs canvas pixels byte-identically to py-opendisplay across schemes {0–6,8} × 4 rotations × geometries. Goldens come from **executing** py-opendisplay (`tools/generate_golden.py`, revision recorded in the fixture). |
| `browser-roundtrip.test.mjs` | Real Chromium canvas round-trip; also proves the transparency hazard empirically (alpha-0 white reads back as black). |
| `adapter.test.mjs`, `adapter-lifecycle.test.mjs` | Schema readiness, per-connection isolation, deadlines, auth wrap-and-replay, and the connect/disconnect race invariants. |
| `flows.test.mjs` | Device-list controller sequences and every rollback branch, with injected deps (no Bluetooth chooser needed). |
| `store-browser.test.mjs` | `store.js`/`keys.js` against **real IndexedDB**, including persistence across a browser restart (two Chrome launches, one profile). |
| `composer-model.test.mjs`, `composer-session.test.mjs` | Composer model/tools/history/QR geometry, and session invariants (gesture-scoped undo, device-switch isolation, bitmap ownership). |
| `composer-browser.test.mjs` | Real canvas rendering: opaque pixels, crisp QR, three panel geometries, photo fit/adjustments, asset GC, and QR fidelity vs the shipped `/l/qrcode.js`. |
| `deploy-script.test.mjs` | `deploy-ftp-curl.sh` phase ordering and failure gating, driven with a fake `curl`. |
| `qr-decode.test.mjs` | **Independent decode round-trip** via OpenCV — proof the extracted QR core emits scannable codes. |

## Browser tests

Chrome is driven through `lib/chrome-cdp.mjs`, a dependency-free CDP client.
`--dump-dom` is unusable for anything touching IndexedDB: its virtual time never
services IDB callbacks (verified — 2000 polled timers fire before one
`indexedDB.open` completes), so tests use real-time CDP evaluation instead.

Browser tests **skip** when no Chrome binary is found, but **fail** instead when
`CI` or `OD_REQUIRE_BROWSER_TESTS` is set, so a green CI run can never mean the
load-bearing proofs silently didn't run.

## Fixture regeneration

```bash
# wire-packing goldens (needs the py-opendisplay checkout)
cd ../py-opendisplay && uv run python \
  ../opendisplay.org/tests/webapp/tools/generate_golden.py \
  > ../opendisplay.org/tests/webapp/fixtures/golden.json

# QR version/size reference (segno, independent implementation)
uvx --from segno python tests/webapp/tools/generate_qr_golden.py \
  > tests/webapp/fixtures/qr-golden.json
```

## Notes for future work

- The QR core is **extracted verbatim** from `httpdocs/l/qrcode.js` (hashes in
  its header). It prepends a UTF-8 BOM for non-ASCII payloads — an upstream
  quirk, confirmed by the decode round-trip and documented in `composer/qr.js`.
- Module patterns legitimately differ between conformant QR encoders (mask
  choice, padding, mode selection), so cross-library comparison asserts
  version/size only; decodability is proven by the OpenCV round-trip and
  fidelity by the in-browser comparison against the shipped library.
