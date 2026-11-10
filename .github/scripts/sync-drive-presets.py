#!/usr/bin/env python3
"""Vendor Firmware_Unified's panel drive database into the toolbox.

Source:  <Firmware_Unified>/panels/generated/drive_presets.json
         (schema "opendisplay.drive_presets" v1, contract in panels/README.md there)
Output:  httpdocs/firmware/toolbox/drive-presets.json

The output is the same document with the fields the website never reads removed
(framed_hex duplicates packets[].body_hex; the per-mode replay `equivalence`
detail and the bb_epaper `sources` block are for the firmware's own gate), so the
browser downloads about a third of the bytes. Nothing is renamed or recomputed:
a consumer of the vendored copy sees the upstream schema.

Usage:
    python3 .github/scripts/sync-drive-presets.py /path/to/Firmware_Unified
    python3 .github/scripts/sync-drive-presets.py --src path/to/drive_presets.json
    python3 .github/scripts/sync-drive-presets.py /path/to/Firmware_Unified --check   # exit 1 if stale

Run it whenever Firmware_Unified's panels/generated/drive_presets.json changes
(after `python3 panels/tools/gen_all.py` there), commit the result, and mention
the Firmware_Unified commit in the message. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "httpdocs" / "firmware" / "toolbox" / "drive-presets.json"
SCHEMA = "opendisplay.drive_presets"
DROP_PANEL_FIELDS = ("framed_hex", "equivalence", "bbep_flags")


def slim(doc: dict) -> dict:
    if doc.get("schema") != SCHEMA:
        raise SystemExit(f"unexpected schema {doc.get('schema')!r}, want {SCHEMA!r}")
    if doc.get("schema_version") != 1:
        raise SystemExit(f"unsupported schema_version {doc.get('schema_version')!r}; update httpdocs/js/od-v3.js first")
    out = {k: doc[k] for k in ("schema", "schema_version", "schema_minor", "caps", "names") if k in doc}
    src = doc.get("sources") or {}
    out["sources"] = {k: src[k] for k in ("bb_epaper", "panels_yaml_sha256") if k in src}
    panels = {}
    for key, entry in sorted((doc.get("panels") or {}).items()):
        e = {k: v for k, v in entry.items() if k not in DROP_PANEL_FIELDS}
        for p in e.get("packets", []):
            if not isinstance(p.get("id"), int) or not isinstance(p.get("body_hex"), str):
                raise SystemExit(f"{key}: packet without int id / body_hex")
        panels[key] = e
    out["panels"] = panels
    return out


def render(doc: dict) -> str:
    return json.dumps(doc, indent=1, ensure_ascii=False, sort_keys=False) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("firmware_unified", nargs="?", help="Firmware_Unified checkout")
    ap.add_argument("--src", help="drive_presets.json path (instead of a checkout)")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--check", action="store_true", help="do not write; exit 1 if the vendored copy is stale")
    a = ap.parse_args()
    if a.src:
        src = Path(a.src)
    elif a.firmware_unified:
        src = Path(a.firmware_unified) / "panels" / "generated" / "drive_presets.json"
    else:
        ap.error("give a Firmware_Unified checkout or --src")
    text = render(slim(json.loads(src.read_text(encoding="utf-8"))))
    out = Path(a.out)
    if a.check:
        current = out.read_text(encoding="utf-8") if out.exists() else ""
        if current != text:
            print(f"{out} is stale relative to {src}; re-run without --check", file=sys.stderr)
            return 1
        print(f"{out} is up to date")
        return 0
    out.write_text(text, encoding="utf-8")
    n = len(json.loads(text)["panels"])
    print(f"wrote {out} ({len(text.encode())} bytes, {n} panels) from {src}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
