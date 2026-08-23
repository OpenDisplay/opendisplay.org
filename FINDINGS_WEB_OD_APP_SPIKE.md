# Findings: Web OD App M-S spike (a) — encoder byte-parity proof

*2026-08-23. Harness: `tests/webapp/` (Node built-in test runner, `node --test tests/webapp/`, zero dependencies, dev-only — not deployed). The plan is `DESIGN_WEB_OD_APP_PLAN.md` §9 M-S(a).*

## Result: PROVEN — the paint-back architecture is sound

Painting palette indices onto a canvas as exact ideal-palette RGB and calling the **unmodified** `ble-common.js` `encodeCanvasToByteData()` produces bytes **identical to py-opendisplay's packing** (the Python sender real devices already accept) for every supported case:

- **Schemes {0, 1, 2, 3, 4, 5, 6, 8}** — all match byte-for-byte.
- **All four rotations (quarter-turns 0–3)** — the canvas-from-native inverse transform round-trips exactly, including non-square panels.
- **Row padding** — byte-aligned (16-wide), odd (13-wide), and the real EP213 case (122-wide) all match; both implementations row-pad identically (`np.packbits(axis=1)` semantics).
- **Both 4-gray LUTs** — base `[3,1,2,0]` and v2 `[3,2,1,0]` (panels 0x28/0x48), with a guard test proving the LUTs actually diverge on the fixture.
- **Alpha** — the encoder reads RGB only (alpha 0 encodes identically to alpha 255). The transparency hazard is *canvas compositing* (transparent pixels leaving RGB black/undefined), confirming the plan's opaque-ImageData rule; the encoder itself is not the risk.

102/102 tests green. The mono/BWRY/16-gray packing ambiguity from earlier notes is settled: **everything is row-padded**; od-app's continuous-packing description in its inventory doc was imprecise, not a wire difference.

## Finding 1 — BWRY panels 0x1D/0x1E: real parity gap in the web encoder (pre-existing)

py-opendisplay swaps yellow/red wire codes for panels `0x1D`/`0x1E` (bb_epaper `u8Colors_4clr`: native 2=red, 3=yellow — `display_palettes.get_bwry_codes`), but `ble-common.js`'s scheme-3 encoder ignores `panelIcType` and always stores yellow=2/red=3. **The existing Display Tool therefore renders yellow/red swapped on those two panels today.** This is a pre-existing website bug, out of this project's scope to fix in the library.

**App-side remedy (verified byte-exact):** for `panelIcType` 0x1D/0x1E, paint indices 2 and 3 with each other's color — the fixed encoder then classifies the swapped names and emits the panel-native codes, matching the Python reference exactly. `dither.js` owns this swap table.

## Finding 2 — scheme 7 fail-open confirmed empirically

`encodeCanvasToByteData(canvas, 7, …)` silently produces **monochrome** output (falls through to the mono branch). The adapter's hard-reject rule is not defensive paranoia; without it a 7-color panel would receive a valid-looking mono payload.

## Consequences for the plan

- M-S(a) exit criterion met with the architecture unchanged — no fallback needed, nothing dropped from the supported set.
- The harness (`tests/webapp/lib/load-ble-common.mjs` vm loader, `reference-encoders.mjs`, `fixtures.mjs`) is the seed of the §10 integration suite; the fixture generator and reference encoders carry forward as-is.
- New requirement for `dither.js`: the BWRY 0x1D/0x1E paint-swap table (Finding 1).
- M-S(b) (saved-device/auth proof) requires a real browser + device and remains open — it needs the M0 scratch context to run.
