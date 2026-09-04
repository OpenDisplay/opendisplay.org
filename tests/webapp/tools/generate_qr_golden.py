"""Generate golden QR matrices with segno — an INDEPENDENT implementation —
to verify the QR core extracted from the site's MIT library.

Matching an independent encoder module-for-module proves both correctness and
decodability (segno output is spec-conformant), which a decoder round-trip
alone would not.

    uvx --from segno python tests/webapp/tools/generate_qr_golden.py \
        > tests/webapp/fixtures/qr-golden.json
"""

from __future__ import annotations

import json
import sys

import segno

CASES = [
    ("hi", "L"),
    ("https://opendisplay.org", "M"),
    ("https://opendisplay.org/firmware/toolbox/", "Q"),
    ("finder", "M"),
    ("日本語テキスト", "L"),
    ("x" * 300, "L"),
    ("OD-2F41 kitchen tag", "H"),
]


def main() -> None:
    out = []
    for text, ecl in CASES:
        # micro=False: the app never emits Micro QR (many scanners reject it).
        qr = segno.make(text, error=ecl.lower(), micro=False)
        # The QR spec lets a conformant encoder pick any of the 8 data masks
        # (it should pick the lowest-penalty one, but implementations differ in
        # their scoring). Emit ALL eight so a comparison can assert our matrix
        # equals one of them: same version, same codewords, same ECC — proving
        # the encoding is correct and decodable regardless of mask choice.
        variants = {}
        for mask in range(8):
            m = segno.make(text, error=ecl.lower(), micro=False, mask=mask)
            variants[mask] = ["".join("1" if v else "0" for v in row) for row in m.matrix]
        out.append(
            {
                "text": text,
                "errorCorrectLevel": ecl,
                "version": qr.version,
                "size": len(qr.matrix),
                "preferredMask": qr.mask,
                "maskVariants": variants,
            }
        )
    json.dump(
        {
            "source": "segno",
            "version": segno.__version__,
            "generator": "tests/webapp/tools/generate_qr_golden.py",
            "cases": out,
        },
        sys.stdout,
        indent=1,
        ensure_ascii=False,
    )


if __name__ == "__main__":
    main()
