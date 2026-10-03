# Where the website and py-opendisplay disagree

`tests/legacy/py-agreement.test.js` checks that the website's protocol code produces the
same bytes as py-opendisplay for the cases in `py-opendisplay.json`. Neither sender is
ground truth: **the firmware is**. When they disagree, the case is settled here against the
firmware source, and the test pins the website's current behavior through `KNOWN` until
the fix lands on whichever side is wrong (or both).

Fixtures were generated with py-opendisplay 7.14.1 and epaper-dithering 6.0.0 on 2026-10-03.

## D1: measured palette for split Spectra 6 (scheme 8)

- **Case:** panel 35 (EP73 Spectra 800x480) with color scheme 8 (BWGBRY_SPLIT).
- **Website:** uses the measured `SPECTRA_7_3_6COLOR` palette (`dither.js` maps scheme 8 to 4 before the lookup).
- **py-opendisplay:** has no `(35, BWGBRY_SPLIT)` entry, so it falls back to the ideal BWGBRY palette.
- **Firmware:** has no opinion; palettes only affect dithering quality on the host. Both outputs are valid on the wire.
- **Assessment:** the website looks better. py-opendisplay's own comments say split mode uses the same inks as BWGBRY. Low stakes: split mode is used by reTerminal E1004 (a 13.3" panel), so panel 35 with scheme 8 may not occur in practice.
- **Status:** open. Suggest proposing the mapping to py-opendisplay.

## D2: partial rectangle at the right edge of a panel whose width isn't a multiple of 8

- **Case:** 13 px wide, change at x=12 → bounding box x 12..13.
- **Website (`alignPartialRect`):** returns x=5, w=5. Bug: the width is computed from the x before it was shifted left.
- **py-opendisplay (`align_rect`):** returns x=5, w=8 (self-consistent).
- **Firmware (`Firmware/src/display_service.cpp`, 0x76 handler):** rejects unless `x % 8 == 0`, `w % 8 == 0` and `x + w <= width` (`OD_ERR_PARTIAL_RECT_ALIGN` / `RECT_OOB`). **Both answers are rejected**, and no valid 8-aligned rectangle covers x=12 on a 13 px panel.
- **Correct behavior:** fall back to a full refresh when no aligned rectangle fits (instead of a round trip that ends in a NACK).
- **Affects:** mono panels with partial support whose width isn't a multiple of 8 (e.g. 122 px wide 2.13" panels), only when the change touches the last partial byte column.
- **Status:** open. Fix on both sides: when shifting x0 left would break the 8-pixel alignment, return `fallback_full`.
