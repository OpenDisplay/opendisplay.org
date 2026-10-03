---
title: "Display Data Format"
lead: "Part of the <strong><a href=\"/protocol/basic-standard.html\">OpenDisplay spec</a></strong> — shared by all implementations"
---

## Overview

This page explains how image data is encoded into bytes for transmission to OpenDisplay devices. The encoding format depends on the color scheme configured for the display. Understanding this format is essential for implementing custom clients or debugging image transfer issues.

The pixel encoding is **identical** whether the device uses the compact OpenDisplay product profile or reference firmware with a [Flex](/protocol/flex-standard/) configuration blob. What differs is how bytes are sent on the wire:

-   **Compact profile:** Image data can be sent in the “New Image” response packet (`0x82`) as part of the simple request-response flow
-   **Full GATT protocol:** Image data is sent with Direct Write (`0x0070`, `0x0071`, `0x0072`) — see [communication protocol](/protocol/ble-flow.html)

**Pixel Order:** Pixels are processed row by row, from top to bottom, left to right. Each row is encoded completely before moving to the next row. **Direct Writing:** The image data format is designed to allow direct writing to the e-paper display (EPD) without requiring the full image to be stored in RAM or flash memory. Data can be written to the EPD controller as it is received, enabling efficient memory usage even for large displays.

## Color Scheme 0: Monochrome (B/W)

**Encoding:** 1 bit per pixel, 8 pixels per byte  
**Colors:** Black (0) or White (1)  
**Data Size:** (width × height) ÷ 8 bytes

### How It Works

Each pixel is represented by a single bit. White pixels set the bit to 1, black pixels set it to 0. Bits are packed into bytes from left to right, with the most significant bit (MSB) representing the leftmost pixel.

Example: 8 pixels in a row

|  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | Byte |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pixel | W | B | W | W | B | B | W | B |  |
| Bits | `1` | `0` | `1` | `1` | `0` | `0` | `1` | `0` | `0xB2` |

(10110010 binary = 178 decimal = 0xB2 hex)

## Color Scheme 1: B/W + Red

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
| Plane 1 (B/W) | `1` | `0` | `1` | `1` | `1` | `0` | `1` | `0` | `0xBA` |
| Plane 2 (Red) | `0` | `0` | `1` | `0` | `1` | `0` | `0` | `0` | `0x28` |

**Final Data:** `0xBA, 0x28` (Plane 1 first, then Plane 2)

## Color Scheme 2: B/W + Yellow

**Encoding:** Bitplanes, 1 bit per pixel per plane, 8 pixels per byte per plane  
**Colors:** Black, White, Yellow  
**Data Size:** ((width × height) ÷ 8) × 2 bytes (two planes)

### How It Works

Similar to Scheme 1, but Plane 2 encodes yellow instead of red:

-   **Black:** Plane 1 = 0, Plane 2 = 0
-   **White:** Plane 1 = 1, Plane 2 = 0
-   **Yellow:** Plane 1 = 0, Plane 2 = 1

Data is sent as: **All Plane 1 bytes, then all Plane 2 bytes**

## Color Scheme 3: B/W + Red + Yellow

**Encoding:** 2 bits per pixel, 4 pixels per byte  
**Colors:** Black (0), White (1), Yellow (2), Red (3)  
**Data Size:** (width × height) ÷ 4 bytes

### How It Works

Each pixel uses 2 bits to encode one of four colors. Pixels are packed left to right, with the leftmost pixel using bits 7-6, next pixel using bits 5-4, and so on.

Example: 4 pixels in a row

|  | 1 | 2 | 3 | 4 | Byte |
| --- | --- | --- | --- | --- | --- |
| Pixel | W | B | Y | R |  |
| Bits | `01` | `00` | `10` | `11` | `0x4B` |

(W=01, B=00, Y=10, R=11 = 01001011 = 0x4B)

**Bit pairs (left to right):** 01 (White), 00 (Black), 10 (Yellow), 11 (Red)

## Color Scheme 4: 6-Color (B/W + Green + Blue + Red + Yellow)

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

### Visual Examples

#### Example 1: Black + White

|  | 1 | 2 | Byte |
| --- | --- | --- | --- |
| Pixel | B | W |  |
| Bits | `0000` | `0001` | `0x01` |

(B=0000 upper, W=0001 lower = 00000001 = 0x01)

#### Example 2: White + Red

|  | 1 | 2 | Byte |
| --- | --- | --- | --- |
| Pixel | W | R |  |
| Bits | `0001` | `0011` | `0x13` |

(W=0001 upper, R=0011 lower = 00010011 = 0x13)

#### Example 3: Yellow + Blue

|  | 1 | 2 | Byte |
| --- | --- | --- | --- |
| Pixel | Y | BL |  |
| Bits | `0010` | `0101` | `0x25` |

(Y=0010 upper, BL=0101 lower = 00100101 = 0x25)

#### Example 4: Red + Green

|  | 1 | 2 | Byte |
| --- | --- | --- | --- |
| Pixel | R | G |  |
| Bits | `0011` | `0110` | `0x36` |

(R=0011 upper, G=0110 lower = 00110110 = 0x36)

#### Example 5: All Colors (6 pixels)

|  | 1 | 2 | 3 | 4 | 5 | 6 | Byte |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pixel | B | W | Y | R | BL | G |  |
| Bits | `0000` | `0001` | `0x01` |
| Bits | `0010` | `0011` | `0x23` |
| Bits | `0101` | `0110` | `0x56` |

(B=0000, W=0001)

(Y=0010, R=0011)

(BL=0101, G=0110)

**Complete Data:** `0x01, 0x23, 0x56`

## Color Scheme 5: 4 Grayscale

**Encoding:** 2 bits per pixel, 4 pixels per byte  
**Colors:** Black (0), Dark Gray (1), Light Gray (2), White (3)  
**Data Size:** (width × height) ÷ 4 bytes

### How It Works

Each pixel uses 2 bits to encode one of four grayscale levels. Pixels are packed left to right, similar to Scheme 3, with the leftmost pixel using bits 7-6, next pixel using bits 5-4, and so on.

Example: 4 pixels in a row

|  | 1 | 2 | 3 | 4 | Byte |
| --- | --- | --- | --- | --- | --- |
| Pixel | W | B | LG | DG |  |
| Bits | `11` | `00` | `10` | `01` | `0xC9` |

(W=11, B=00, LG=10, DG=01 = 11001001 = 0xC9)

**Bit pairs (left to right):** 11 (White), 00 (Black), 10 (Light Gray), 01 (Dark Gray)

## Pixel Ordering

Pixels are always processed in row-major order: from top to bottom, left to right within each row.

### Example: 4×4 Image

<table><caption>Pixel index, row by row</caption><tbody><tr><td>0</td><td>1</td><td>2</td><td>3</td></tr><tr><td>4</td><td>5</td><td>6</td><td>7</td></tr><tr><td>8</td><td>9</td><td>10</td><td>11</td></tr><tr><td>12</td><td>13</td><td>14</td><td>15</td></tr></tbody></table>

**Order:** 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15

### Byte Packing for Scheme 0 (1 bit/pixel)

```

Row 0: Pixel 0, Pixel 1, Pixel 2, Pixel 3
Row 1: Pixel 4, Pixel 5, Pixel 6, Pixel 7
Row 2: Pixel 8, Pixel 9, Pixel 10, Pixel 11
Row 3: Pixel 12, Pixel 13, Pixel 14, Pixel 15

Byte 0: Pixels 0-7 (Row 0: 0-3, Row 1: 4-7)
Byte 1: Pixels 8-15 (Row 2: 8-11, Row 3: 12-15)
    
```

For bitplane schemes (1 and 2), all rows of Plane 1 are sent first, then all rows of Plane 2.

## Implementation Notes

-   When a row doesn't fill a complete byte, the remaining bits in the last byte are padded with zeros.
-   For bitplane schemes, ensure Plane 1 and Plane 2 have the same number of bytes.
-   Color detection from RGB values uses thresholds: pixels are classified based on their RGB components.
-   The image data must be sent in the rotated orientation. The client should apply rotation before encoding the pixel data.
-   Data can be compressed using zlib before transmission when the device supports streaming decompression (see below).
-   Uncompressed direct write has no protocol-level size limit — pixels stream directly into the framebuffer.

## Transmission Protocols

While the image encoding format is identical for both standards, the transmission protocols differ. This section explains how image data is sent in each standard.

### OpenDisplay Basic

In the Basic standard, image data is sent as part of the "New Image" response packet (0x82):

```

Packet Type: 0x82
Offset 0: packet_type (1 byte) = 0x82
Offset 1-2: image_length (2 bytes, uint16, little-endian)
Offset 3-6: poll_interval (4 bytes, uint32, little-endian)
Offset 7: refresh_type (1 byte) = 0 (normal) or 1 (fast)
Offset 8 to (8+image_length-1): image_data (variable)
    
```

-   **Image Data:** Raw encoded pixel data (or compressed using zlib)
-   **No Chunking:** Entire image is sent in one packet (wrapped in outer packet format for TCP)
-   **TCP Support:** Over TCP, packets can be up to 8KB, allowing larger images in a single transmission
-   **BLE Support:** Over BLE, the image data must fit within BLE packet size limits (~200 bytes per chunk)

See **[OpenDisplay Basic](/protocol/basic-standard.html)** for complete packet specifications.

<h3 id="transmission-reference">Full GATT protocol (reference firmware)</h3>

Wire-level details: [Communication protocol — image transfer](/protocol/ble-flow.html#image-transfer). Panel geometry comes from Flex config, not from the client start command.

#### Start command (`0x0070`)

```

Command: 0x00 0x70

Payload (uncompressed direct write):
  (empty — fewer than 4 bytes)

Payload (streaming decompression):
  [uncompressed_size: 4 bytes, little-endian]
  [optional zlib prefix bytes in the same command]
    
```

#### Data command (`0x0071`)

```

Command: 0x00 0x71
Payload: raw pixel bytes OR continuation of zlib stream
  - BLE: up to ~230 bytes per chunk
  - LAN: up to ~1000 bytes per chunk
    
```

#### End command (`0x0072`)

```

Command: 0x00 0x72
Payload (optional):
  [refresh_mode: 1 byte] — 0 = full (default), 1 = fast refresh
  [new_etag: 4 bytes, big-endian] — optional after full-frame upload

After refresh: device notifies 0x00 0x73 (success) or 0x00 0x74 (timeout)
    
```

#### Partial region update (`0x0076`)

1 bpp B/W panels only. Stream layout: `old_region_bits || new_region_bits`, each `ceil(w/8) × h` bytes. Region `x` and `w` must be multiples of 8. Uses the same `0x0071`/`0x0072` chunking as full frames. See [partial update](/protocol/ble-flow.html#partial-update).

### Maximum Packet Sizes

| Transport | Standard | Maximum Chunk Size |
| --- | --- | --- |
| BLE | Basic | ~200 bytes (wrapped in outer packet) |
| BLE | Flex | 230 bytes per chunk (0x0071 command) |
| TCP | Basic | Up to 8KB (wrapped in outer packet) |
| TCP | Flex | 1000 bytes per chunk (0x0071 command) |

### Streaming decompression

When Flex `transmission_modes` has both `streaming_decompression` (bit 0) and `zip` (bit 1) set, the client may send a zlib DEFLATE stream over direct write. The device decompresses incrementally and writes pixels as they are decoded — no full-frame buffer on the device.

-   **Client:** compress with `window_bits = 9` (512-byte DEFLATE window)
-   **Basic standard:** compressed data may still be embedded in packet `0x82` (separate profile)
-   **New senders:** do not use legacy large-window zlib. If streaming decompression is not advertised, use **uncompressed** direct write
-   **Firmware v2:** reference firmware version 2 will drop legacy large-window zlib; only streaming decompression remains (v1.x ESP32/nRF builds still accept both)

See **[OpenDisplay communication protocol](/protocol/ble-flow.html)** (BLE & LAN) for complete transfer specifications.
