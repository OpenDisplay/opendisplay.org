"""Generate tests/fixtures/py-opendisplay.json from py-opendisplay, the reference sender.

The website's protocol code must produce the same bytes as py-opendisplay (the Home
Assistant integration). This script records what py-opendisplay does for fixed inputs;
the Vitest suite replays the inputs through the website code and compares.

Run after bumping requirements.txt:

    python3 -m venv .venv && .venv/bin/pip install -r tests/fixtures/requirements.txt
    .venv/bin/python tests/fixtures/gen.py
"""

from __future__ import annotations

import json
import random
from importlib.metadata import version
from pathlib import Path

from epaper_dithering import ColorScheme
from PIL import Image

from opendisplay import crypto, display_palettes, partial
from opendisplay.encoding.bitplanes import encode_bitplanes, encode_gray4_bitplanes
from opendisplay.encoding.images import encode_2bpp, encode_image
from opendisplay.models.config import (
    DisplayConfig,
    GlobalConfig,
    ManufacturerData,
    PowerOption,
    SystemConfig,
)
from opendisplay.protocol import commands
from opendisplay.protocol.config_serializer import serialize_config

OUT = Path(__file__).with_name("py-opendisplay.json")
rng = random.Random(20261003)


def rand_bytes(n: int) -> bytes:
    return bytes(rng.randrange(256) for _ in range(n))


def crypto_cases() -> list[dict]:
    cases = []
    for _ in range(3):
        master, client, server = rand_bytes(16), rand_bytes(16), rand_bytes(16)
        session_key = crypto.derive_session_key(master, client, server)
        session_id = crypto.derive_session_id(session_key, client, server)
        commands_out = []
        for counter, cmd, payload in [(0, b"\x00\x40", b""), (1, b"\x00\x41", rand_bytes(20)), (2**33 + 5, b"\x00\x70", rand_bytes(100))]:
            wire = crypto.encrypt_command(session_key, session_id, counter, cmd, payload)
            commands_out.append({"counter": counter, "cmd": cmd.hex(), "payload": payload.hex(), "wire": wire.hex()})
        cases.append(
            {
                "masterKey": master.hex(),
                "clientNonce": client.hex(),
                "serverNonce": server.hex(),
                "sessionKey": session_key.hex(),
                "sessionId": session_id.hex(),
                "commands": commands_out,
            }
        )
    return cases


# Panels with a quirk in display_palettes, plus None and an ordinary panel.
PANELS = [None, 0x08, 0x1D, 0x1E, 0x21, 0x23, 0x27, 0x28, 0x37, 0x48, 0x99]

MEASURED_NAMES = {
    id(getattr(display_palettes, name)): name
    for name in ("SPECTRA_7_3_6COLOR", "MONO_4_26", "SOLUM_BWR", "BWRY_3_97")
}


def palette_cases() -> dict:
    measured = []
    for panel in PANELS:
        for scheme in range(9):
            result = display_palettes.get_palette_for_display(panel, scheme)
            measured.append({"panel": panel, "scheme": scheme, "measured": MEASURED_NAMES.get(id(result))})
    return {
        "gray4Codes": [{"panel": p, "codes": list(display_palettes.get_gray4_codes(p))} for p in PANELS],
        "bwryCodes": [{"panel": p, "codes": list(display_palettes.get_bwry_codes(p))} for p in PANELS],
        "panels4Gray": sorted(display_palettes.PANELS_4GRAY),
        "measured": measured,
    }


# Number of palette indices per firmware color scheme.
COLORS = {0: 2, 1: 3, 2: 3, 3: 4, 4: 6, 5: 4, 6: 16, 7: 7, 8: 6}


def encode(image: Image.Image, scheme: int, panel: int | None) -> bytes:
    """Mirror OpenDisplayDevice's encoder routing (device.py)."""
    cs = ColorScheme.from_value(scheme)
    if cs in (ColorScheme.BWR, ColorScheme.BWY):
        return b"".join(encode_bitplanes(image, cs))
    if cs == ColorScheme.GRAYSCALE_4:
        return b"".join(encode_gray4_bitplanes(image, display_palettes.get_gray4_codes(panel)))
    if cs == ColorScheme.BWRY:
        return encode_2bpp(image, codes=display_palettes.get_bwry_codes(panel))
    return encode_image(image, cs)


def encoding_cases() -> list[dict]:
    cases = []
    for scheme, count in COLORS.items():
        panels = {3: [None, 0x1D], 5: [None, 0x28, 0x48]}.get(scheme, [None])
        for panel in panels:
            for width, height in [(16, 2), (13, 3), (1, 1)]:
                indices = [rng.randrange(count) for _ in range(width * height)]
                image = Image.frombytes("P", (width, height), bytes(indices))
                cases.append(
                    {
                        "scheme": scheme,
                        "panel": panel,
                        "width": width,
                        "height": height,
                        "indices": indices,
                        "bytes": encode(image, scheme, panel).hex(),
                    }
                )
    return cases


def partial_cases() -> list[dict]:
    cases = []
    for width, height, changes in [(32, 4, [(9, 1), (20, 2)]), (13, 3, [(12, 2)]), (16, 2, [])]:
        old = [rng.randrange(2) for _ in range(width * height)]
        new = list(old)
        for x, y in changes:
            new[y * width + x] ^= 1
        bbox = partial.compute_bounding_rect(bytes(old), bytes(new), width, height)
        case = {"width": width, "height": height, "old": old, "new": new, "bbox": list(bbox) if bbox else None}
        if bbox:
            rx, ry, rw, rh = partial.align_rect(*bbox, width, height, pixels_per_byte=8)
            image = Image.frombytes("P", (width, height), bytes(new))
            case["aligned"] = [rx, ry, rw, rh]
            case["segment"] = partial.encode_segment_wire(image, rx, ry, rw, rh, ColorScheme.MONO).hex()
        cases.append(case)
    return cases


def config_case() -> dict:
    display = DisplayConfig(
        instance_number=0, display_technology=1, panel_ic_type=39, pixel_width=800, pixel_height=480,
        active_width_mm=94, active_height_mm=56, tag_type=0, rotation=1, reset_pin=3, busy_pin=4,
        dc_pin=5, cs_pin=6, data_pin=7, partial_update_support=2, color_scheme=0, transmission_modes=0x13,
        clk_pin=8, reserved_pins=b"", full_update_mC=0, reserved=b"",
    )
    config = GlobalConfig(
        system=SystemConfig(ic_type=1, communication_modes=1, device_flags=0, pwr_pin=255, reserved=b""),
        manufacturer=ManufacturerData(manufacturer_id=1, board_type=2, board_revision=0, reserved=b""),
        power=PowerOption(
            power_mode=1, battery_capacity_mah=2000, sleep_timeout_ms=0, tx_power=0, sleep_flags=0,
            battery_sense_pin=255, battery_sense_enable_pin=255, battery_sense_flags=0, capacity_estimator=1,
            voltage_scaling_factor=0, deep_sleep_current_ua=12, deep_sleep_time_seconds=0, charge_enable_pin=255,
            charge_state_pin=255, charger_flags=0, min_wake_time_seconds=30, screen_timeout_seconds=0, reserved=b"",
        ),
        displays=[display],
        version=1,
    )
    return {
        "bytes": serialize_config(config).hex(),
        "display": {
            "panelIcType": 39, "pixelWidth": 800, "pixelHeight": 480, "rotation": 1,
            "partialUpdateSupport": 2, "colorScheme": 0, "transmissionModes": 0x13,
        },
        "power": {"powerMode": 1, "batteryCapacity": 2000},
    }


def command_cases() -> list[dict]:
    return [
        {"refreshMode": mode, "etag": etag, "wire": commands.build_direct_write_end_with_etag(mode, etag).hex()}
        for mode, etag in [(0, 1), (2, 0xDEADBEEF), (1, 0x00010203)]
    ] + [{"refreshMode": mode, "etag": None, "wire": commands.build_direct_write_end_command(mode).hex()} for mode in (0, 1)]


fixtures = {
    "_generated_by": f"tests/fixtures/gen.py with py-opendisplay {version('py-opendisplay')}, "
    f"epaper-dithering {version('epaper-dithering')}",
    "crypto": crypto_cases(),
    "palettes": palette_cases(),
    "encoding": encoding_cases(),
    "partial": partial_cases(),
    "config": config_case(),
    "directWriteEnd": command_cases(),
}
OUT.write_text(json.dumps(fixtures, indent=1) + "\n")
print(f"wrote {OUT}")
