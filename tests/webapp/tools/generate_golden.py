"""Generate golden wire-packing fixtures by executing py-opendisplay's actual
encoders. Run from the py-opendisplay checkout so its venv provides numpy/PIL:

    cd ../py-opendisplay && uv run python \
        ../opendisplay.org/tests/webapp/tools/generate_golden.py \
        > ../opendisplay.org/tests/webapp/fixtures/golden.json

The JSON records the py-opendisplay git revision so fixtures are traceable.
"""

from __future__ import annotations

import json
import subprocess
import sys

import numpy as np
from PIL import Image

from opendisplay.encoding.bitplanes import encode_bitplanes, encode_gray4_bitplanes
from opendisplay.encoding.images import encode_1bpp, encode_2bpp, encode_4bpp
from opendisplay.display_palettes import get_bwry_codes, get_gray4_codes
from epaper_dithering import ColorScheme


def lcg_indices(w: int, h: int, palette_size: int, seed: int) -> list[int]:
    """Mirror of tests/webapp/lib/fixtures.mjs makeRng/makeIndices."""
    s = seed & 0xFFFFFFFF
    out = []
    for _ in range(w * h):
        s = (s * 1664525 + 1013904223) & 0xFFFFFFFF
        out.append(s % palette_size)
    return out


def p_image(indices: list[int], w: int, h: int) -> Image.Image:
    arr = np.array(indices, dtype=np.uint8).reshape(h, w)
    img = Image.fromarray(arr, mode="P")
    return img


def main() -> None:
    cases = []
    w, h = 13, 7  # odd width: row padding exercised everywhere

    def add(name: str, palette_size: int, seed: int, encode) -> None:
        idx = lcg_indices(w, h, palette_size, seed)
        data = encode(p_image(idx, w, h))
        cases.append(
            {
                "name": name,
                "width": w,
                "height": h,
                "paletteSize": palette_size,
                "seed": seed,
                "bytesHex": data.hex(),
            }
        )

    add("mono", 2, 9001, encode_1bpp)
    add(
        "bwr",
        3,
        9002,
        lambda im: b"".join(encode_bitplanes(im, ColorScheme.BWR)),
    )
    add(
        "bwy",
        3,
        9003,
        lambda im: b"".join(encode_bitplanes(im, ColorScheme.BWY)),
    )
    add("bwry_default", 4, 9004, lambda im: encode_2bpp(im, codes=get_bwry_codes(None)))
    add("bwry_0x1d", 4, 9005, lambda im: encode_2bpp(im, codes=get_bwry_codes(0x1D)))
    add("bwry_0x1e", 4, 9006, lambda im: encode_2bpp(im, codes=get_bwry_codes(0x1E)))
    add("bwgbry", 6, 9007, lambda im: encode_4bpp(im, bwgbry_mapping=True))
    add(
        "bwgbry_split",
        6,
        9008,
        lambda im: encode_4bpp(im, bwgbry_mapping=True, half_planes=True),
    )
    add(
        "gray4_base",
        4,
        9009,
        lambda im: b"".join(encode_gray4_bitplanes(im, get_gray4_codes(None))),
    )
    add(
        "gray4_v2",
        4,
        9010,
        lambda im: b"".join(encode_gray4_bitplanes(im, get_gray4_codes(0x28))),
    )
    add("gray16", 16, 9011, encode_4bpp)

    # rev of py-opendisplay (cwd when run per the docstring)
    py_rev = subprocess.run(
        ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True
    ).stdout.strip()

    json.dump(
        {
            "source": "py-opendisplay",
            "revision": py_rev,
            "generator": "tests/webapp/tools/generate_golden.py",
            "cases": cases,
        },
        sys.stdout,
        indent=1,
    )


if __name__ == "__main__":
    main()
