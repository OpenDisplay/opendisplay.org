---
title: "Reference firmware variants"
lead: "Both trees speak the same GATT command set over service <code>0x2446</code>. This page lists where <a href=\"https://github.com/OpenDisplay/Firmware\">main Firmware</a> (ESP32 / nRF52840) and <a href=\"https://github.com/OpenDisplay/Firmware-silabs-bg22\">Firmware-silabs-bg22</a> differ."
---

## Capability matrix

| Capability | Main Firmware | BG22 firmware |
| --- | --- | --- |
| GATT service `0x2446` | Yes | Yes |
| Flex config `0x0040`–`0x0042` | Yes | Yes (+ NFC / flash packets parsed) |
| AES-CCM `0x0050` | Yes | Yes |
| Direct write `0x0070`–`0x0072` | Yes | Yes |
| [Streaming decompression](/protocol/ble-flow.html#streaming-decompression) (`streaming_decompression` + `zip` bits) | Yes | Yes (only compression mode) |
| Legacy large-window zlib (32 KB DEFLATE window) | v1.x ESP32/nRF only — removed in **firmware v2** | Never supported (512 B window only) |
| [Partial region](/protocol/ble-flow.html#partial-update) `0x0076` | Yes (1 bpp panels) | Not implemented |
| LED `0x0073` / `0x0075` | Yes | Yes |
| Buzzer `0x0077` | Yes | No |
| [NFC endpoint](/protocol/ble-flow.html#nfc-endpoint) `0x0083` | No | Yes |
| Wi‑Fi / LAN TCP port 2446 | ESP32 only | No |
| Multi-display | Up to 4 panels | Display \[0\] only |
| Max pipe payload (BLE) | ~230 B typical (MTU 512) | 244 B |
| DFU `0x0051` | Platform-specific | Yes |

## Sender guidance

**New senders must not use legacy large-window zlib.** Read Flex `transmission_modes` from config (or presets). If `streaming_decompression` and `zip` are both set, compress with `window_bits = 9` (512-byte DEFLATE window). Otherwise send an **uncompressed** direct write — do not fall back to legacy compression.

Firmware **version 1.x** (high byte of `0x0043`) on existing ESP32/nRF builds still accepts legacy streams for backward compatibility. **Version 2** drops that path entirely.

Wire protocol details: [Communication protocol](/protocol/ble-flow.html).

## Source code entry points

-   **Main:** `Firmware/src/communication.cpp`, `display_service.cpp`, `structs.h`
-   **BG22:** `Firmware-silabs-bg22/opendisplay_pipe.c`, `opendisplay_display.cpp`, `opendisplay_structs.h`
-   **Shared config schema:** `web/firmware/toolbox/config.yaml`
