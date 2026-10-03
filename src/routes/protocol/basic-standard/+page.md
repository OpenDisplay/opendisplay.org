---
title: "OpenDisplay Standard"
---

**⚠️ Work in Progress:** This specification is still under development and may change. Please use with caution and check for updates regularly.

## Overview

OpenDisplay is an open standard to get images displayed on e-paper screens via Wi-Fi or BLE in an efficient way.

**Need Help or Want to Contribute?** Join our [Discord server](https://discord.gg/XmTHz8RfJE) to get help with integration, ask questions, or suggest changes and improvements to the standard.

## Communication Flow

This standard uses binary packets with fixed byte positions. Manufacturers can choose to implement BLE, WiFi, or both communication methods. The packet format and communication flow are identical for both, with only the connection establishment differing. For more details on connection setup, see the [BLE Communication](#ble-communication) and [WiFi Communication](#wifi-communication) sections.

1.  **Connection established** (BLE: client connects to display; WiFi: display connects to server)
2.  **Display → Server:** Image Request Packet (0x02) when ready (includes battery status)
3.  **Server → Display:** Response packet:
    -   No new image (0x81) - ask again in X seconds
    -   Request configuration (0x83) - display should send announcement
    -   New image (0x82) - image data with poll interval
4.  **Display → Server:** If configuration requested, sends Announcement Packet (0x01)
5.  **Display → Server:** Periodic Image Request Packets (0x02) with battery status
6.  **Server → Display:** Response packets (no new image or new image with data)
7.  **Power Saving:** Between updates, the display and/or client may disconnect or enter sleep mode to save power. The connection can be re-established when the next update is needed.
8.  Loop continues with periodic image requests (reconnecting as needed)

## BLE Communication

This standard uses BLE GATT (Generic Attribute Profile) for communication. The display acts as a BLE peripheral (server), and clients connect to it to exchange packets.

### GATT Service Structure

-   **Service UUID:** 0x2446
-   **Characteristic UUID:** 0x2446
-   **Characteristic Properties:** READ, NOTIFY, WRITE, WRITE\_NR (write without response)

### Communication Mechanism

The display uses a single characteristic for bidirectional communication:

-   **Display → Client:** Packets are sent using BLE notifications. The display calls `notify()` on the characteristic to send response packets (0x81, 0x82, 0x83) to the connected client.
-   **Client → Display:** Packets are received via BLE write operations. The client writes request packets (0x01, 0x02) to the characteristic, which triggers a write callback in the display's firmware.

### Packet Transmission

All packets are sent as raw binary data with fixed byte positions. There are no variable-length strings or padding. The BLE MTU (Maximum Transmission Unit) determines the maximum packet size per transmission:

-   **MTU Size:** Typically 512 bytes (negotiated during connection). The minimum is 23 bytes (BLE 4.0), but modern implementations negotiate higher values for better throughput.
-   **Effective Chunk Size:** Each BLE notification can carry up to (MTU - 3) bytes of payload data. For a 512-byte MTU, this means approximately 509 bytes per chunk.

### Advertising

The display advertises itself as a BLE peripheral to allow clients to discover and connect:

-   **Service UUID:** The service UUID (0x2446) is included in the advertisement data
-   **Device Name:** The display advertises with a device name (manufacturer-specific)
-   **Connection:** Clients scan for the service UUID and connect to the display

## WiFi Communication

**Reference firmware** uses a different Wi‑Fi model: the device joins your access point and acts as a **TCP server**; the client connects to it with length-prefixed frames matching BLE writes. See the OpenDisplay [LAN (Wi‑Fi) transport](/protocol/ble-flow/#lan-wifi-transport). The sections below describe the *this-page* OpenDisplay standard’s pull-based Wi‑Fi flow (display as TCP client to a server).

This standard also supports WiFi communication via TCP. WiFi network configuration is the responsibility of the manufacturer's app, but server discovery uses mDNS (multicast DNS) to eliminate the need for manual IP address and port configuration.

#### WiFi Configuration

Manufacturers are responsible for handling WiFi network configuration. This includes configuring WiFi credentials (SSID, password, encryption type). This protocol does not include commands for WiFi configuration - this must be handled separately by the manufacturer's app.

#### Server Discovery via mDNS

The display discovers the OpenDisplay server automatically using mDNS (multicast DNS) service discovery. This eliminates the need for manual IP address and port configuration:

-   **Service Type:** `_opendisplay._tcp.local`
-   **Service Name:** The server advertises with a service name (e.g., "OpenDisplay Server")
-   **Default Port:** 2446 (discovered via mDNS SRV record, or defaults to 2446 if not specified)
-   **Discovery Process:** The display queries the local network for OpenDisplay servers using mDNS
-   **Connection:** Once discovered, the display connects to the server's IP address and port

The server must advertise itself via mDNS with the service type `_opendisplay._tcp.local` for automatic discovery to work. Multiple servers can be advertised on the same network, and the display can connect to any available server.

**mDNS Service Advertisement:** The server should advertise the following information:

-   **Service Type:** `_opendisplay._tcp.local.` (note the trailing dot)
-   **Service Name:** Full qualified service name (e.g., `OpenDisplay Server._opendisplay._tcp.local.`)
-   **Port:** TCP port number (default: 2446)
-   **IP Address:** Server's IPv4 address
-   **TXT Records (optional but recommended):** Include the IP address in TXT records with key `"ip"` as a workaround for devices that have difficulty resolving mDNS hostnames

**IP Address Resolution:** The display should attempt to resolve the server's IP address using the following methods (in order):

1.  **TXT Record:** Read the IP address from mDNS TXT records (key: `"ip"`) if available
2.  **Hostname Resolution:** Resolve the mDNS hostname to an IP address using standard DNS resolution (with or without `.local` suffix)
3.  **Direct IP (if supported):** Use the IP address directly from mDNS response if the platform supports it

The TXT record method is recommended as a workaround for platforms (such as ESP32) that may have unreliable mDNS hostname resolution. Servers should include the IP address in TXT records to ensure reliable discovery across all platforms.

#### TCP Protocol

WiFi communication uses TCP with the same packet format as BLE. The device acts as a TCP client, connecting to the server discovered via mDNS.

-   **Connection Model:** Persistent TCP connection (device connects to server)
-   **Packet Format:** Same outer packet structure as BLE (see packet format below)
-   **Reconnection:** If the connection is lost, the display will rediscover the server via mDNS and reconnect

#### Packet Format Over TCP

TCP uses the same outer packet structure as BLE, allowing for larger packet sizes (up to 8KB vs ~200 bytes for BLE):

```
Outer Packet Format:
[length:2][version:1][packets:variable][crc:2]

Single Packet Format:
[number:1][id:1][payload:variable]

Where:
- length: Total packet size including CRC (little-endian, 2 bytes)
- version: Protocol version (0x01, 1 byte)
- packets: Sequence of single_packet entries (variable length)
- crc: CRC16-CCITT checksum (2 bytes)
- number: Packet index (0-based, 1 byte)
- id: Packet type identifier (1 byte)
- payload: Packet-specific data (variable length)
```

All packets (0x01, 0x02, 0x81, 0x82, 0x83) are wrapped in this outer packet format when sent over TCP. The packet structure is identical to BLE, but TCP allows for larger payloads.

## Packet Types

All packets use fixed byte positions. All multi-byte values are little-endian (least significant byte first).

#### Packet Type Values

| Value | Direction | Packet Type |
| --- | --- | --- |
| 0x01 | Display → Server | Display Announcement |
| 0x02 | Display → Server | Image Request |
| 0x81 | Server → Display | Response: No New Image |
| 0x82 | Server → Display | Response: New Image |
| 0x83 | Server → Display | Response: Request Configuration |

## Display Announcement Packet (0x01)

Sent by the display when requested by the server (via packet 0x83). Contains all display specifications. The display does not send this automatically on connection.

| Offset | Field | Size | Description |
| --- | --- | --- | --- |
| 0 | `packet_type` | 1 byte | Always 0x01 |
| 1-2 | `width` | 2 bytes (uint16) | Display width in pixels (little-endian) |
| 3-4 | `height` | 2 bytes (uint16) | Display height in pixels (little-endian) |
| 5 | `colour_scheme` | 1 byte | Color scheme enum (matches OpenDisplay Flex, see Image Data Format section) |
| 6-7 | `firmware_id` | 2 bytes (uint16) | Firmware identifier |
| 8-9 | `firmware_version` | 2 bytes (uint16) | Firmware version number (little-endian) |
| 10-11 | `manufacturer_id` | 2 bytes (uint16) | Manufacturer identifier |
| 12-13 | `model_id` | 2 bytes (uint16) | Model identifier |
| 14-15 | `max_compressed_size` | 2 bytes (uint16) | Maximum compressed image size in bytes (little-endian). If 0, the display does not support compression. Compression support is optional for uploading programs. |
| 16 | `rotation` | 1 byte | Image rotation in degrees: 0 = 0°, 1 = 90°, 2 = 180°, 3 = 270°. The uploading program should rotate the image data accordingly before transmission. |

**Total packet size:** 17 bytes

```
Example (200×200 Monochrome display, no compression, 0° rotation):
0x01 0xC8 0x00 0xC8 0x00 0x00 0x01 0x00 0x01 0x00 0x01 0x00 0x01 0x00 0x00 0x00 0x00
^^^  ^^^^^^^^^^^  ^^^^^^^^^^^  ^^^^  ^^^^^^^^^^^  ^^^^^^^^^^^  ^^^^^^^^^^^  ^^^^^^^^^^^  ^^^^^^^^^^^  ^^^
type width=200   height=200   scheme firmware_id version=1  mfr_id=1   model_id=1  max_comp=0  rot=0
```

Manufacturer, model, and firmware names are represented as 16-bit integer IDs. These mappings are optional for clients to implement.

**ID Mappings Repository:** The official mappings for manufacturer IDs, model IDs, and firmware IDs are maintained in the [OpenDisplay Mappings repository](https://github.com/OpenDisplay/mappings). Manufacturers should open a pull request against this repository to register new displays and ensure their IDs are properly documented.

## Image Request Packet (0x02)

Sent by the display when a client connects and the display is ready, or periodically to request new images. Includes current power status.

**Initial Request:** When a BLE client connects, the display should send this packet as soon as it is ready to communicate. This signals to the server that the display is available.

| Offset | Field | Size | Description |
| --- | --- | --- | --- |
| 0 | `packet_type` | 1 byte | Always 0x02 |
| 1 | `battery_percent` | 1 byte | Battery percentage (0-100), or 0xFF for AC powered |
| 2 | `rssi` | 1 byte | RSSI (Received Signal Strength Indicator) in dBm when connected over WiFi. For BLE connections, this field is not used (should be 0 or ignored). |

**Total packet size:** 3 bytes

```
Example (battery at 85%, WiFi RSSI -65 dBm):
0x02 0x55 0xBF
^^^^  ^^^^
type battery=85% rssi=-65

Example (AC powered, BLE connection):
0x02 0xFF 0x00
^^^^  ^^^^
type AC powered rssi=0 (BLE)
```

## Response: No New Image (0x81)

Sent by the server when there's no new image available. Tells the display when to poll again.

| Offset | Field | Size | Description |
| --- | --- | --- | --- |
| 0 | `packet_type` | 1 byte | Always 0x81 |
| 1-4 | `poll_interval` | 4 bytes (uint32) | Seconds to wait before next request (little-endian) |

**Total packet size:** 5 bytes

```
Example (ask again in 60 seconds):
0x81 0x3C 0x00 0x00 0x00
^^^^^^^^^^^^^^^^^^^^
type interval=60
```

## Response: Request Configuration (0x83)

Sent by the server to request the display's configuration. The display should respond with an Announcement Packet (0x01).

| Offset | Field | Size | Description |
| --- | --- | --- | --- |
| 0 | `packet_type` | 1 byte | Always 0x83 |

**Total packet size:** 1 byte

```
Example:
0x83
^^^
type
```

When the display receives this packet, it should immediately send a Display Announcement Packet (0x01) containing its specifications.

## Response: New Image (0x82)

Sent by the server when there's a new image to display. Contains the image data in OpenDisplay format.

| Offset | Field | Size | Description |
| --- | --- | --- | --- |
| 0 | `packet_type` | 1 byte | Always 0x82 |
| 1-2 | `image_length` | 2 bytes (uint16) | Length of image data in bytes (little-endian) |
| 3-6 | `poll_interval` | 4 bytes (uint32) | Seconds to wait before next request (little-endian) |
| 7 | `refresh_type` | 1 byte | Refresh type: 0 = normal refresh, 1 = fast refresh |
| 8 to (8+image\_length-1) | `image_data` | Variable | Image data in OpenDisplay format (see [Display Data Format](/protocol/display-data-format/)) |

**Total packet size:** 8 + image\_length bytes

```
Example (image of 5000 bytes, ask again in 300 seconds, normal refresh):
0x82 0x88 0x13 0x2C 0x01 0x00 0x00 0x00 0x[5000 bytes of image data]
^^^^^^^^^^^  ^^^^^^^^^^^^^^^^^^^^  ^^^  ^^^^^^^^^^^^^^^^^^^^^^^^^^^
type length=5000  interval=300      refresh image data
```

## Image Transmission

In this standard, image data is sent as part of the "New Image" response packet (0x82):

```
Packet Type: 0x82
Offset 0: packet_type (1 byte) = 0x82
Offset 1-2: image_length (2 bytes, uint16, little-endian)
Offset 3-6: poll_interval (4 bytes, uint32, little-endian)
Offset 7: refresh_type (1 byte) = 0 (normal) or 1 (fast)
Offset 8 to (8+image_length-1): image_data (variable)
```

The `image_data` field contains raw encoded pixel data in OpenDisplay format. For transmission details over BLE and TCP, see the [BLE Communication](#ble-communication) and [WiFi Communication](#wifi-communication) sections.

## Image Data Format

This section explains how image data is encoded into bytes for transmission to OpenDisplay devices. The encoding format depends on the color scheme configured for the display. Understanding this format is essential for implementing custom clients or debugging image transfer issues.

**Direct Writing:** The image data format is designed to allow direct writing to the e-paper display (EPD) without requiring the full image to be stored in RAM or flash memory. Data can be written to the EPD controller as it is received, enabling efficient memory usage even for large displays.

### Pixel Ordering

Pixels are always processed in row-major order: from top to bottom, left to right within each row.

For bitplane schemes (1 and 2), all rows of Plane 1 are sent first, then all rows of Plane 2.

### Color Schemes

### Color Scheme 0x00: Monochrome (B/W)

**Encoding:** 1 bit per pixel, 8 pixels per byte  
**Colors:** Black (0) or White (1)  
**Data Size:** (width × height) ÷ 8 bytes

### How It Works

Each pixel is represented by a single bit. White pixels set the bit to 1, black pixels set it to 0. Bits are packed into bytes from left to right, with the most significant bit (MSB) representing the leftmost pixel.

Example: 8 pixels in a row

|  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | Byte |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pixel | W | B | W | W | B | B | W | B |  |
| Bits | `1` | `0` | `1` | `1` | `0` | `0` | `1` | `0` | `0xB6` |

(10110110 binary = 182 decimal = 0xB6 hex)

### Color Scheme 0x01: B/W + Red

**Encoding:** Bitplanes, 1 bit per pixel per plane, 8 pixels per byte per plane  
**Colors:** Black, White, Red  
**Data Size:** ((width × height) ÷ 8) × 2 bytes (two planes)

### How It Works

This scheme uses two bitplanes (planes). Plane 1 encodes black/white information, and Plane 2 encodes red information. The final color is determined by combining both planes:

-   **Black:** Plane 1 = 0, Plane 2 = 0
-   **White:** Plane 1 = 1, Plane 2 = 0
-   **Red:** Plane 1 = 1, Plane 2 = 1

Data is sent as: **All Plane 1 bytes, then all Plane 2 bytes**

Example: 8 pixels in a row

|  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | Byte |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pixel | W | B | R | W | R | B | W | B |  |
| Plane 1 (B/W) | `1` | `0` | `1` | `1` | `1` | `0` | `1` | `0` | `0xB6` |
| Plane 2 (Red) | `0` | `0` | `1` | `0` | `1` | `0` | `0` | `0` | `0x24` |

**Final Data:** `0xB6, 0x24` (Plane 1 first, then Plane 2)

### Color Scheme 0x02: B/W + Yellow

**Encoding:** Bitplanes, 1 bit per pixel per plane, 8 pixels per byte per plane  
**Colors:** Black, White, Yellow  
**Data Size:** ((width × height) ÷ 8) × 2 bytes (two planes)

### How It Works

Similar to Scheme 1, but Plane 2 encodes yellow instead of red:

-   **Black:** Plane 1 = 0, Plane 2 = 0
-   **White:** Plane 1 = 1, Plane 2 = 0
-   **Yellow:** Plane 1 = 0, Plane 2 = 1

Data is sent as: **All Plane 1 bytes, then all Plane 2 bytes**

### Color Scheme 0x03: B/W + Red + Yellow

**Encoding:** 2 bits per pixel, 4 pixels per byte  
**Colors:** Black (0), White (1), Yellow (2), Red (3)  
**Data Size:** (width × height) ÷ 4 bytes

### How It Works

Each pixel uses 2 bits to encode one of four colors. Pixels are packed left to right, with the leftmost pixel using bits 7-6, next pixel using bits 5-4, and so on.

Example: 4 pixels in a row

|  | 1 | 2 | 3 | 4 | Byte |
| --- | --- | --- | --- | --- | --- |
| Pixel | W | B | Y | R |  |
| Bits | `10` | `00` | `10` | `11` | `0x93` |

(W=01, B=00, Y=10, R=11 = 10010011 = 0x93)

**Bit pairs (left to right):** 01 (White), 00 (Black), 10 (Yellow), 11 (Red)

### Color Scheme 0x04: 6-Color (B/W + Green + Blue + Red + Yellow)

**Encoding:** 4 bits per pixel, 2 pixels per byte  
**Colors:** Black (0), White (1), Yellow (2), Red (3), Blue (5), Green (6)  
**Data Size:** (width × height) ÷ 2 bytes

### How It Works

Each pixel uses 4 bits (a nibble) to encode one of six colors. Two pixels fit in each byte, with the leftmost pixel in the upper nibble (bits 7-4) and the rightmost pixel in the lower nibble (bits 3-0).

### Color Values

|  | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- | --- |
| Pixel | B | W | Y | R | BL | G |
| Value | `0` | `1` | `2` | `3` | `5` | `6` |

#### Example: White + Red

2 pixels in a row

|  | 1 | 2 | Byte |
| --- | --- | --- | --- |
| Pixel | W | R |  |
| Bits | `0001` | `0011` | `0x13` |

(W=0001 upper, R=0011 lower = 00010011 = 0x13)

## OpenDisplay vs Flex configuration

OpenDisplay is the wire protocol and product profile. Flex is an optional YAML configuration extension used by reference firmware on dev boards. Both use the same image encoding:

| Feature | OpenDisplay (spec) | Flex (reference firmware) |
| --- | --- | --- |
| Role | Protocol any sender or product implements | Board/panel configuration blob for reference firmware |
| Configuration | Minimal announcement packet | Full YAML → binary TLV schema |
| Image format | ✓ Shared encoding | ✓ Shared encoding |
| Communication | Compact profile or full GATT command set | Full GATT + optional LAN (same as spec) |
| Typical use | Fixed products, sender authors | DIY dev boards, many panel presets |
