"""Generate golden DITHER INDICES with the Python epaper_dithering binding —
the same Rust core the vendored wasm bundle wraps, reached through a different
language binding.

This is what proves the dither itself is right. Comparing packed bytes only
proves the packing: a broken dither, a wrong measured palette, or ignored
tone/gamut would still pack "correctly".

    cd ../py-opendisplay && uv run python \\
        ../opendisplay.org/tests/webapp/tools/generate_dither_golden.py \\
        > ../opendisplay.org/tests/webapp/fixtures/dither-golden.json
"""

from __future__ import annotations

import json
import sys

import epaper_dithering as ed
import numpy as np
from PIL import Image

WIDTH, HEIGHT = 24, 16


def make_image() -> Image.Image:
    """A deterministic, genuinely colourful test image: horizontal hue ramp,
    vertical brightness ramp, plus a saturated block the dither must resolve."""
    img = Image.new("RGB", (WIDTH, HEIGHT))
    px = img.load()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            r = (x * 255) // (WIDTH - 1)
            g = (y * 255) // (HEIGHT - 1)
            b = ((x + y) * 255) // (WIDTH + HEIGHT - 2)
            px[x, y] = (r, g, b)
    for y in range(2, 6):
        for x in range(2, 10):
            px[x, y] = (255, 40, 40)
    return img


CASES = [
    ("mono_ideal", ed.ColorScheme.MONO, None, ed.DitherMode.BURKES),
    ("bwr_ideal", ed.ColorScheme.BWR, None, ed.DitherMode.BURKES),
    ("bwry_ideal", ed.ColorScheme.BWRY, None, ed.DitherMode.FLOYD_STEINBERG),
    ("bwgbry_ideal", ed.ColorScheme.BWGBRY, None, ed.DitherMode.BURKES),
    ("gray4_ideal", ed.ColorScheme.GRAYSCALE_4, None, ed.DitherMode.ATKINSON),
    ("gray16_ideal", ed.ColorScheme.GRAYSCALE_16, None, ed.DitherMode.BURKES),
    # Measured palettes — the values the app picks per panel.
    ("bwgbry_measured", None, "SPECTRA_7_3_6COLOR", ed.DitherMode.BURKES),
    ("mono_measured", None, "MONO_4_26", ed.DitherMode.BURKES),
    ("bwr_measured", None, "SOLUM_BWR", ed.DitherMode.BURKES),
    ("bwry_measured", None, "BWRY_3_97", ed.DitherMode.BURKES),
]


def main() -> None:
    img = make_image()
    cases = []
    for name, scheme, palette_name, mode in CASES:
        target = getattr(ed, palette_name) if palette_name else scheme
        # The Python binding returns a PIL palette image ("P" mode); the JS
        # binding returns {indices, palette}. Same Rust core, different shape.
        result = ed.dither_image(img, target, mode=mode, serpentine=True)
        indices = np.asarray(result).ravel().tolist()
        flat = result.getpalette() or []
        palette = [flat[i:i + 3] for i in range(0, len(flat), 3)]
        cases.append(
            {
                "name": name,
                "colorScheme": None if scheme is None else int(scheme.value),
                "measuredPalette": palette_name,
                "mode": int(mode.value),
                "indices": indices,
                "palette": palette,
            }
        )

    json.dump(
        {
            "source": "epaper_dithering (python binding)",
            "version": ed.__version__,
            "generator": "tests/webapp/tools/generate_dither_golden.py",
            "width": WIDTH,
            "height": HEIGHT,
            "image": "hue ramp x brightness ramp + saturated red block (see make_image)",
            "cases": cases,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
