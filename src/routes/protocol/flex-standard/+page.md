---
title: "OpenDisplay Flex"
lead: "Configuration extension for the <strong>reference firmware</strong> — not a separate communication protocol."
---

<script>
  import Button from '#lib/ui/Button.svelte';
</script>

## What Flex is

**OpenDisplay Flex** is a YAML-based configuration schema. Tools compile it into a binary TLV blob that describes a specific board: host MCU, display panel(s), pin wiring, power options, optional Wi‑Fi credentials, encryption keys, sensors, and other peripherals.

The [reference firmware](https://github.com/OpenDisplay/Firmware) uses Flex so one firmware binary can support many development boards and e-paper panels. Flash a preset from the [Toolbox](/firmware/toolbox/) (a Flex tool), and the device advertises the correct capabilities to any OpenDisplay client.

Clients still speak the **[OpenDisplay communication protocol](/protocol/ble-flow.html)** for configuration read/write, image transfer, and encryption. Flex only defines *what* is stored in the configuration blob — see the [YAML schema](/protocol/yaml-config/) for field detail.

## Who needs Flex

| You are… | Read this |
| --- | --- |
| Building with reference firmware on a dev board | Flex config + [Flex tools](/protocol/flex-tools/) |
| Adding a new panel to reference firmware | [Adding a new panel](/protocol/adding-displays/) + [YAML schema](/protocol/yaml-config/) |
| Implementing OpenDisplay on a fixed product | [OpenDisplay spec](/protocol/basic-standard.html) only — Flex is optional |
| Writing a sender (Python, HA, custom app) | [Communication protocol](/protocol/ble-flow.html) + [Display data format](/protocol/display-data-format/) |

## Schema and binary format

Canonical schema: `firmware/toolbox/config.yaml` (version **1.2** — major 1, minor 2). The Toolbox and reference firmware share this file.

Configuration is transferred as an **outer packet**: 2-byte length, 1-byte version, a sequence of inner packets, then a 2-byte CRC. The CRC is CRC-16/CCITT-FALSE (init 0xFFFF, poly 0x1021) computed over the container excluding the trailing CRC, with the 2 length bytes treated as zero. Each inner packet has a sequential `number`, a type `id`, and a typed payload. Full field definitions: [YAML configuration reference](/protocol/yaml-config/).

On the wire, configuration uses OpenDisplay commands `0x0040` (read), `0x0041` (write / first chunk), and `0x0042` (subsequent chunks). After a successful write, send `0x000F` to reboot and apply.

## Packet types in reference firmware

The table below lists Flex packet type IDs from the schema and whether the current reference firmware parses them at boot (`config_parser.cpp`).

| ID | Name | Reference firmware |
| --- | --- | --- |
| `1` (`0x01`) | `system_config` | ✓ Required — MCU type, pins, communication modes |
| `2` (`0x02`) | `manufacturer_data` | ✓ Manufacturer ID and product strings |
| `4` (`0x04`) | `power_option` | ✓ Battery, deep sleep, power pins |
| `32` (`0x20`) | `display` | ✓ Up to 4 panels — resolution, color scheme, bus |
| `33` (`0x21`) | `led` | ✓ Up to 4 RGB/status LEDs |
| `35` (`0x23`) | `sensor_data` | ✓ Up to 4 sensors (e.g. SHT40) |
| `36` (`0x24`) | `data_bus` | ✓ SPI / I2C bus instances |
| `37` (`0x25`) | `binary_inputs` | ✓ Buttons and GPIO inputs |
| `38` (`0x26`) | `wifi_config` | ✓ ESP32 STA credentials + optional server URL/port |
| `39` (`0x27`) | `security_config` | ✓ AES-128 PSK and encryption flag |
| `40` (`0x28`) | `touch_controller` | ✓ Touch IC + MSD slot mapping |
| `41` (`0x29`) | `passive_buzzer` | ✓ Buzzer instances |
| `42` (`0x2A`) | `nfc_config` | In schema only — not parsed by reference firmware yet |
| `43` (`0x2B`) | `flash_config` | In schema only — not parsed by reference firmware yet |

## BLE advertising and discovery

Reference firmware uses BLE service and characteristic UUID **0x2446** (128-bit form `00002446-0000-1000-8000-00805F9B34FB`). Manufacturer Specific Data uses company identifier **0x2446** with a **16-byte** payload (dynamic status, touch, sensor slots, etc.). Clients can read the live MSD with command `0x0044`.

When `communication_modes` includes Wi‑Fi, the device joins the configured access point and listens on TCP port **2446** by default, advertising `_opendisplay._tcp` via mDNS. LAN uses the same command bytes as BLE — see [LAN transport](/protocol/ble-flow.html#lan-wifi-transport).

## Image transfer (OpenDisplay protocol)

Flex configuration tells the device display dimensions, color scheme, and capabilities (packet type 32). Image bytes use the shared [display data format](/protocol/display-data-format/). Reference firmware implements **direct write** (`0x0070`–`0x0072`). Full wire spec: [image transfer](/protocol/ble-flow.html#image-transfer).

**Streaming decompression:** when `transmission_modes` has both `streaming_decompression` (bit 0) and `zip` (bit 1), clients may send a zlib stream with a 512-byte DEFLATE window. **New senders must not use legacy large-window zlib** — if streaming decompression is not advertised, use uncompressed direct write. Legacy acceptance ends with **firmware version 2**. See [streaming decompression](/protocol/ble-flow.html#streaming-decompression).

**Partial updates:** `partial_update_support: 1` advertises 1 bpp region refresh via `0x0076`; `2` requires the partial stream to cover the full panel (e.g. EP426 / Seeed EN05). Main firmware only — [variants](/protocol/reference-firmware-variants/).

## Full schema reference

Every field, enum, and bit in the Flex configuration schema — packet types 1 through 43, CRC rules, and examples.

<Button href="/protocol/yaml-config/">YAML configuration reference</Button>

## Flex tools

Browser tools for flashing reference firmware and editing Flex presets. Not needed if you only implement or talk to a fixed OpenDisplay product.

<Button href="/protocol/flex-tools/">Flex tools overview</Button>
