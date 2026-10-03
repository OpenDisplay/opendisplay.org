---
title: "YAML Configuration"
lead: "Part of <strong><a href=\"/protocol/flex-standard/\">OpenDisplay Flex</a></strong> — the configuration extension for reference firmware"
---

<script>
  import Badge from '#lib/ui/Badge.svelte';
</script>

**OpenDisplay Flex** is a YAML-based configuration schema, not a wire protocol. Tools compile it into a binary TLV blob that reference firmware stores on the device. Clients discover capabilities through the normal OpenDisplay configuration read (`0x0040`) and the commands in the [communication protocol](/protocol/ble-flow.html).

This page documents every packet type and field in the schema (canonical source: `firmware/toolbox/config.yaml`, version 1.2). See **[OpenDisplay Flex](/protocol/flex-standard/)** for an overview and which packet types reference firmware parses today.

This configuration fully explains all capabilities the device has, including display specifications, power management options, communication modes, sensor support, and all other device settings. The configuration is used by tools like the Toolbox to generate and parse configuration packets, and by clients to understand what features are available on a particular device.

The configuration schema is designed to be extensible. New packet types and fields can be added to support additional features while maintaining backward compatibility through versioning and reserved fields. This allows the protocol to evolve and accommodate new device capabilities without breaking existing implementations.

## Packet Structure

The configuration is organized as an outer packet containing multiple inner packets. Each inner packet represents a specific aspect of the device configuration (display, power, sensors, etc.):

Bytes on the wire, in order
| Part | Field | Size | Value |
| --- | --- | --- | --- |
| Outer packet | `length` | 2 bytes |  |
| Outer packet | `version` | 1 byte |  |
| Packet #0 | `number`, `id` | 1 + 1 bytes | 0, 1 (system\_config) |
| Packet #1 | `number`, `id` | 1 + 1 bytes | 1, 2 (manufacturer\_data) |
| Packet #2 | `number`, `id` | 1 + 1 bytes | 2, 32 (display configuration) |
| … | more packets, each followed by its payload |
| Outer packet | `crc` | 2 bytes |  |

### Outer Packet

The outer packet wraps the entire configuration transfer:

| Field | Size | Description |
| --- | --- | --- |
| `length` | 2 bytes | Total length including CRC (max 4kB recommended) |
| `version` | 1 byte | Major protocol version |
| `packets` | variable | Sequence of single\_packet entries |
| `crc` | 2 bytes | CRC-16/CCITT-FALSE (init 0xFFFF, poly 0x1021) over the container excluding the trailing CRC field, with the 2 length bytes treated as zero |

### Single Packet

Each packet in the sequence has this structure:

| Field | Size | Description |
| --- | --- | --- |
| `number` | 1 byte | Packet index (0-based, sequential) |
| `id` | 1 byte | Packet type identifier |
| `payload` | variable | Packet-specific payload |

## Field Types

### Fixed-Size Fields

Fields with a fixed size are specified with a number:

```
- name: ic_type
  size: 2
  description: IC used in this device
```

### Enumerations

Fields can have enumerated values:

```
- name: ic_type
  size: 2
  enum:
    1:
      name: NRF52840
      description: nrf52840 based boards
    2:
      name: ESP32S3
      description: esp32-s3 based boards
```

### Conditional Enumerations

Enum values can depend on another field's value:

```
- name: board_type
  size: 1
  conditional_enum:
    depends_on: manufacturer_id
    values:
      1:  # if manufacturer_id == 1 (Seeed)
        0:
          name: EE04
          description: XIAO ePaper Display EE04
```

### Bitfields

Fields can be bitfields where each bit has a specific meaning:

```
- name: communication_modes
  size: 1
  bits:
    0:
      name: ble
      description: BLE transfer supported
    1:
      name: oepl
      description: OEPL based transfer supported
    2:
      name: wifi
      description: WiFi LAN (TCP) transfer supported
```

## Packet Types

The protocol defines multiple packet types, each representing a different aspect of device configuration. For detailed field definitions, enumerations, and constraints, use the [Toolbox](/firmware/toolbox/) tool, which provides an interactive interface to explore all packet types and their fields.

#### Packet Type 1: system\_config <Badge>Required</Badge>

Contains information about the host microcontroller (IC type) and power management configuration.

#### Packet Type 2: manufacturer\_data <Badge>Required</Badge>

Identifies the manufacturer and specific board model/revision.

#### Packet Type 4: power\_option <Badge>Required</Badge>

Defines power supply settings, battery capacity, sleep behavior, and power consumption characteristics.

<h4 id="packet-type-32">Packet Type 32: display <Badge>Repeatable</Badge></h4>

Specifies display/panel configuration including dimensions, color scheme, controller type, pin assignments, and transfer capabilities. This packet is required for the protocol to function. Can appear multiple times for devices with multiple displays.

Key fields for senders:

-   `pixel_width`, `pixel_height`, `color_scheme` — frame geometry and encoding
-   `partial_update_support` — `0` none; `1` 1 bpp partial region refresh (`0x0076`); `2` partial supported but full-frame stream required
-   `transmission_modes` bitfield — `streaming_decompression` (bit 0) + `zip` (bit 1) enable compressed direct write; `direct_write` (bit 3) marks bufferless mode

Full field list: `web/firmware/toolbox/config.yaml` or the [Toolbox](/firmware/toolbox/).

#### Packet Type 33: led <Badge>Repeatable</Badge>

Optional LED configuration for devices with status or RGB LEDs.

#### Packet Type 35: sensor\_data <Badge>Repeatable</Badge>

Optional sensor configuration for devices with environmental or other sensors.

#### Packet Type 36: data\_bus <Badge>Repeatable</Badge>

Defines communication buses (I2C, SPI, etc.) used by sensors or other peripherals.

#### Packet Type 37: binary\_inputs <Badge>Repeatable</Badge>

Optional configuration for buttons, switches, or other binary input devices.

#### Packet Type 38: wifi\_config <Badge>Wi‑Fi LAN</Badge>

Station credentials for devices that use Flex [LAN (Wi‑Fi) transport](/protocol/ble-flow.html#lan-wifi-transport): 32-byte SSID, 32-byte password (null-terminated, zero-padded), 1-byte encryption type enum (none, WEP, WPA, WPA2, WPA3), plus reserved bytes per schema. Required in non-volatile config (along with `communication_modes` bit `wifi`) before the device will join the network and open the TCP server.

<h4 id="packet-type-39">Packet Type 39: security_config</h4>

Optional **application-layer encryption**: 16-byte AES-128 pre-shared key, `encryption_enabled`, `session_timeout_seconds` (0 = no timeout), security flags (`rewrite_allowed` for unauthenticated config recovery), and reset-pin fields per schema. If the key is all zeros, encryption is off. See [Encryption and authentication](/protocol/ble-flow.html#encryption-authentication) in the communication protocol.

## Packet Properties

### Required Packets

Some packet types are marked as <Badge>required</Badge>, meaning they must appear in every configuration

### Repeatable Packets

Some packet types are marked as <Badge>repeatable</Badge>, meaning they can appear multiple times

## Using the YAML Config

The [Toolbox](/firmware/toolbox/) web tool loads the YAML configuration to:

-   Generate UI forms for each packet type
-   Validate field values against enums and constraints
-   Build binary configuration packets
-   Parse received configuration data

### Configuration Flow

1.  Load YAML schema from `config.yaml`
2.  User selects/edits packet instances
3.  Tool validates all fields
4.  Tool builds binary packet with CRC
5.  Packet is sent to the device (typically via BLE; LAN is available after Wi‑Fi is configured)

## Reserved Fields

Many packet types include reserved fields for future compatibility. According to the protocol specification:

-   Reserved fields MUST be set to 0 unless otherwise specified
-   Reserved byte blocks are provided for forward compatibility
-   Older parsers should ignore reserved fields they don't understand
