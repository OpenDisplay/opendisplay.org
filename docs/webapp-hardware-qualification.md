# Web OD App — hardware qualification

Plan reference: `DESIGN_WEB_OD_APP_PLAN.md` §10. **No results are recorded
yet** — the software pipeline is proven byte-identical to py-opendisplay in
automated tests, but nothing here has touched a physical tag.

**M3 is therefore software-complete, not qualified.** Nobody should treat the
app as release-ready for a panel/transport combination until its row below is
filled in with a date and a result.

## Why automated tests are not enough

The suite proves the bytes are right (`pipeline-browser.test.mjs` compares the
whole composer → wasm dither → paint-back → encoder chain against a
Python-generated reference, and `dither-golden` compares the wasm dither
against the Python binding of the same Rust core). What it cannot prove:

- that a real panel accepts and displays those bytes;
- BLE behaviour under real MTUs, PIPE negotiation and retransmission;
- deep-sleep wake, reconnect timing and permission persistence on Android;
- that measured palettes actually look right on the physical ink.

## Mandatory smoke set — blocking for every release

| # | Case | Browser | Tag | Result | Date | Notes |
|---|------|---------|-----|--------|------|-------|
| 1 | Mono, compressed, PIPE | Chrome desktop | nRF52840 | ☐ | | |
| 2 | 6-colour, uncompressed, direct-write | Chrome desktop | ESP32-S3 | ☐ | | |
| 3 | Locked device upload (key entry + auth) | Chrome desktop | either | ☐ | | |
| 4 | Rotated panel (`rotationQuarterTurns` ≠ 0) | Chrome desktop | either | ☐ | | |
| 5 | Deep-sleep wake, then silent reconnect | Chrome Android | either | ☐ | | |

## Extended matrix — before the first release, and after protocol-adjacent changes

| Scheme | Panel | Result | Date | Notes |
|---|---|---|---|---|
| 0 mono | | ☐ | | |
| 1 BWR | | ☐ | | |
| 2 BWY | | ☐ | | |
| 3 BWRY (standard codes) | | ☐ | | |
| 3 BWRY (panel 0x1D/0x1E, swapped codes) | | ☐ | | **paint-swap path** — verify yellow/red are not transposed on the panel |
| 4 6-colour Spectra | | ☐ | | |
| 5 4-grey (base LUT) | | ☐ | | |
| 5 4-grey (v2 LUT, panel 0x28/0x48) | | ☐ | | |
| 6 16-grey | | ☐ | | |
| 8 BWGBRY split (dual-CS) | | ☐ | | |

Also: Edge desktop; {locked, unlocked} × {PIPE, legacy direct-write}.

**A scheme with no qualified panel is not shipped as supported.** If a scheme
cannot be tested, remove it from `SUPPORTED_COLOR_SCHEMES` in
`ble-adapter.js` rather than shipping it untested.

## How to run a case

1. Serve the site over HTTPS (or `localhost`) in Chrome or Edge.
2. Open `/app/`, add the device, and confirm the card shows the panel's real
   size, scheme and rotation (these come from a live config read).
3. Open the composer, add a photo plus text and a QR code, and check the
   dithered preview.
4. Send. Confirm: the progress bar advances, "Transfer complete — the panel is
   refreshing…" appears at the data-phase boundary, and "Done — the panel has
   refreshed." appears only once the panel finishes.
5. Compare the panel against the on-screen **measured-palette** preview.
6. Record the result, the firmware version, and anything surprising.

## Known software-side risks worth watching on hardware

- **Transfer/refresh reporting** relies on the shared library's status string
  (`"…refreshing display…"`); if a firmware or library change alters that
  wording, the transfer notice silently stops appearing (the final completion
  is unaffected).
- **BWRY 0x1D/0x1E paint swap** compensates for the web encoder ignoring
  `panelIcType`; case 5 in the extended matrix is the only real check that the
  compensation is in the right direction.
- **Measured palettes** are borrowed in one case (panel 66 reuses the 7.3"
  Spectra measurement), so its colours may be slightly off.
