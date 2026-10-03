<script>
  import Card from '#lib/ui/Card.svelte';
  import Page from '#lib/ui/Page.svelte';
  import Prose from '#lib/ui/Prose.svelte';
  import { href } from '#lib/paths.js';
</script>

<svelte:head>
  <title>Display Data Format · OpenDisplay</title>
</svelte:head>

<Page title="Display Data Format" toc>
  {#snippet lead()}Part of the <strong><a href={href.basicStandard}>OpenDisplay spec</a></strong> — shared by all
    implementations{/snippet}

  <Card>
    <Prose>
      <h2 id="overview">Overview</h2>
      <p>
        This page explains how image data is encoded into bytes for transmission to OpenDisplay devices. The
        encoding format depends on the color scheme configured for the display. Understanding this format is
        essential for implementing custom clients or debugging image transfer issues.
      </p>
      <p>
        The pixel encoding is <strong>identical</strong> whether the device uses the compact OpenDisplay
        product profile or reference firmware with a <a href={href.flexStandard}>Flex</a> configuration blob. What
        differs is how bytes are sent on the wire:
      </p>
      <ul>
        <li>
          <strong>Compact profile:</strong> Image data can be sent in the “New Image” response packet (<code
            >0x82</code
          >) as part of the simple request-response flow
        </li>
        <li>
          <strong>Full GATT protocol:</strong> Image data is sent with Direct Write (<code>0x0070</code>,
          <code>0x0071</code>, <code>0x0072</code>) — see <a href={href.bleFlow}>communication protocol</a>
        </li>
      </ul>

      <strong>Pixel Order:</strong> Pixels are processed row by row, from top to bottom, left to right. Each
      row is encoded completely before moving to the next row.

      <strong>Direct Writing:</strong> The image data format is designed to allow direct writing to the e-paper
      display (EPD) without requiring the full image to be stored in RAM or flash memory. Data can be written to
      the EPD controller as it is received, enabling efficient memory usage even for large displays.
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="color-scheme-0-monochrome-b-w">Color Scheme 0: Monochrome (B/W)</h2>
      <p>
        <strong>Encoding:</strong> 1 bit per pixel, 8 pixels per byte<br />
        <strong>Colors:</strong> Black (0) or White (1)<br />
        <strong>Data Size:</strong> (width × height) ÷ 8 bytes
      </p>

      <h3>How It Works</h3>
      <p>
        Each pixel is represented by a single bit. White pixels set the bit to 1, black pixels set it to 0.
        Bits are packed into bytes from left to right, with the most significant bit (MSB) representing the
        leftmost pixel.
      </p>

      <p>Example: 8 pixels in a row</p>
      <table>
        <thead
          ><tr
            ><th></th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>7</th><th>8</th><th
              >Byte</th
            ></tr
          ></thead
        ><tbody
          ><tr
            ><td>Pixel</td><td>W</td><td>B</td><td>W</td><td>W</td><td>B</td><td>B</td><td>W</td><td>B</td><td
            ></td></tr
          ><tr
            ><td>Bits</td><td><code>1</code></td><td><code>0</code></td><td><code>1</code></td><td
              ><code>1</code></td
            ><td><code>0</code></td><td><code>0</code></td><td><code>1</code></td><td><code>0</code></td><td
              ><code>0xB2</code></td
            ></tr
          ></tbody
        >
      </table>
      <p>(10110010 binary = 178 decimal = 0xB2 hex)</p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="color-scheme-1-b-w-red">Color Scheme 1: B/W + Red</h2>
      <p>
        <strong>Encoding:</strong> Bitplanes, 1 bit per pixel per plane, 8 pixels per byte per plane<br />
        <strong>Colors:</strong> Black, White, Red<br />
        <strong>Data Size:</strong> ((width × height) ÷ 8) × 2 bytes (two planes)
      </p>

      <h3>How It Works</h3>
      <p>
        This scheme uses two bitplanes (planes). Plane 1 encodes black/white information, and Plane 2 encodes
        red information. The final color is determined by combining both planes:
      </p>
      <ul>
        <li><strong>Black:</strong> Plane 1 = 0, Plane 2 = 0</li>
        <li><strong>White:</strong> Plane 1 = 1, Plane 2 = 0</li>
        <li><strong>Red:</strong> Plane 1 = 1, Plane 2 = 1</li>
      </ul>
      <p>Data is sent as: <strong>All Plane 1 bytes, then all Plane 2 bytes</strong></p>

      <p>Example: 8 pixels in a row</p>
      <table>
        <thead
          ><tr
            ><th></th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>7</th><th>8</th><th
              >Byte</th
            ></tr
          ></thead
        ><tbody
          ><tr
            ><td>Pixel</td><td>W</td><td>B</td><td>R</td><td>W</td><td>R</td><td>B</td><td>W</td><td>B</td><td
            ></td></tr
          ><tr
            ><td>Plane 1 (B/W)</td><td><code>1</code></td><td><code>0</code></td><td><code>1</code></td><td
              ><code>1</code></td
            ><td><code>1</code></td><td><code>0</code></td><td><code>1</code></td><td><code>0</code></td><td
              ><code>0xBA</code></td
            ></tr
          ><tr
            ><td>Plane 2 (Red)</td><td><code>0</code></td><td><code>0</code></td><td><code>1</code></td><td
              ><code>0</code></td
            ><td><code>1</code></td><td><code>0</code></td><td><code>0</code></td><td><code>0</code></td><td
              ><code>0x28</code></td
            ></tr
          ></tbody
        >
      </table>

      <p><strong>Final Data:</strong> <code>0xBA, 0x28</code> (Plane 1 first, then Plane 2)</p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="color-scheme-2-b-w-yellow">Color Scheme 2: B/W + Yellow</h2>
      <p>
        <strong>Encoding:</strong> Bitplanes, 1 bit per pixel per plane, 8 pixels per byte per plane<br />
        <strong>Colors:</strong> Black, White, Yellow<br />
        <strong>Data Size:</strong> ((width × height) ÷ 8) × 2 bytes (two planes)
      </p>

      <h3>How It Works</h3>
      <p>Similar to Scheme 1, but Plane 2 encodes yellow instead of red:</p>
      <ul>
        <li><strong>Black:</strong> Plane 1 = 0, Plane 2 = 0</li>
        <li><strong>White:</strong> Plane 1 = 1, Plane 2 = 0</li>
        <li><strong>Yellow:</strong> Plane 1 = 0, Plane 2 = 1</li>
      </ul>
      <p>Data is sent as: <strong>All Plane 1 bytes, then all Plane 2 bytes</strong></p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="color-scheme-3-b-w-red-yellow">Color Scheme 3: B/W + Red + Yellow</h2>
      <p>
        <strong>Encoding:</strong> 2 bits per pixel, 4 pixels per byte<br />
        <strong>Colors:</strong> Black (0), White (1), Yellow (2), Red (3)<br />
        <strong>Data Size:</strong> (width × height) ÷ 4 bytes
      </p>

      <h3>How It Works</h3>
      <p>
        Each pixel uses 2 bits to encode one of four colors. Pixels are packed left to right, with the
        leftmost pixel using bits 7-6, next pixel using bits 5-4, and so on.
      </p>

      <p>Example: 4 pixels in a row</p>
      <table>
        <thead><tr><th></th><th>1</th><th>2</th><th>3</th><th>4</th><th>Byte</th></tr></thead><tbody
          ><tr><td>Pixel</td><td>W</td><td>B</td><td>Y</td><td>R</td><td></td></tr><tr
            ><td>Bits</td><td><code>01</code></td><td><code>00</code></td><td><code>10</code></td><td
              ><code>11</code></td
            ><td><code>0x4B</code></td></tr
          ></tbody
        >
      </table>
      <p>(W=01, B=00, Y=10, R=11 = 01001011 = 0x4B)</p>
      <p><strong>Bit pairs (left to right):</strong> 01 (White), 00 (Black), 10 (Yellow), 11 (Red)</p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="color-scheme-4-6-color-b-w-green-blue-red-yellow">
        Color Scheme 4: 6-Color (B/W + Green + Blue + Red + Yellow)
      </h2>
      <p>
        <strong>Encoding:</strong> 4 bits per pixel, 2 pixels per byte<br />
        <strong>Colors:</strong> Black (0), White (1), Yellow (2), Red (3), Blue (5), Green (6)<br />
        <strong>Data Size:</strong> (width × height) ÷ 2 bytes
      </p>

      <h3>How It Works</h3>
      <p>
        Each pixel uses 4 bits (a nibble) to encode one of six colors. Two pixels fit in each byte, with the
        leftmost pixel in the upper nibble (bits 7-4) and the rightmost pixel in the lower nibble (bits 3-0).
      </p>

      <h3>Color Values</h3>
      <table>
        <thead><tr><th></th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th></tr></thead><tbody
          ><tr><td>Pixel</td><td>B</td><td>W</td><td>Y</td><td>R</td><td>BL</td><td>G</td></tr><tr
            ><td>Value</td><td><code>0</code></td><td><code>1</code></td><td><code>2</code></td><td
              ><code>3</code></td
            ><td><code>5</code></td><td><code>6</code></td></tr
          ></tbody
        >
      </table>

      <h3>Visual Examples</h3>

      <h4>Example 1: Black + White</h4>
      <table>
        <thead><tr><th></th><th>1</th><th>2</th><th>Byte</th></tr></thead><tbody
          ><tr><td>Pixel</td><td>B</td><td>W</td><td></td></tr><tr
            ><td>Bits</td><td><code>0000</code></td><td><code>0001</code></td><td><code>0x01</code></td></tr
          ></tbody
        >
      </table>
      <p>(B=0000 upper, W=0001 lower = 00000001 = 0x01)</p>

      <h4>Example 2: White + Red</h4>
      <table>
        <thead><tr><th></th><th>1</th><th>2</th><th>Byte</th></tr></thead><tbody
          ><tr><td>Pixel</td><td>W</td><td>R</td><td></td></tr><tr
            ><td>Bits</td><td><code>0001</code></td><td><code>0011</code></td><td><code>0x13</code></td></tr
          ></tbody
        >
      </table>
      <p>(W=0001 upper, R=0011 lower = 00010011 = 0x13)</p>

      <h4>Example 3: Yellow + Blue</h4>
      <table>
        <thead><tr><th></th><th>1</th><th>2</th><th>Byte</th></tr></thead><tbody
          ><tr><td>Pixel</td><td>Y</td><td>BL</td><td></td></tr><tr
            ><td>Bits</td><td><code>0010</code></td><td><code>0101</code></td><td><code>0x25</code></td></tr
          ></tbody
        >
      </table>
      <p>(Y=0010 upper, BL=0101 lower = 00100101 = 0x25)</p>

      <h4>Example 4: Red + Green</h4>
      <table>
        <thead><tr><th></th><th>1</th><th>2</th><th>Byte</th></tr></thead><tbody
          ><tr><td>Pixel</td><td>R</td><td>G</td><td></td></tr><tr
            ><td>Bits</td><td><code>0011</code></td><td><code>0110</code></td><td><code>0x36</code></td></tr
          ></tbody
        >
      </table>
      <p>(R=0011 upper, G=0110 lower = 00110110 = 0x36)</p>

      <h4>Example 5: All Colors (6 pixels)</h4>
      <table>
        <thead
          ><tr><th></th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>Byte</th></tr></thead
        ><tbody
          ><tr><td>Pixel</td><td>B</td><td>W</td><td>Y</td><td>R</td><td>BL</td><td>G</td><td></td></tr><tr
            ><td>Bits</td><td><code>0000</code></td><td><code>0001</code></td><td><code>0x01</code></td></tr
          ><tr><td>Bits</td><td><code>0010</code></td><td><code>0011</code></td><td><code>0x23</code></td></tr
          ><tr><td>Bits</td><td><code>0101</code></td><td><code>0110</code></td><td><code>0x56</code></td></tr
          ></tbody
        >
      </table>
      <p>(B=0000, W=0001)</p>
      <p>(Y=0010, R=0011)</p>
      <p>(BL=0101, G=0110)</p>
      <p><strong>Complete Data:</strong> <code>0x01, 0x23, 0x56</code></p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="color-scheme-5-4-grayscale">Color Scheme 5: 4 Grayscale</h2>
      <p>
        <strong>Encoding:</strong> 2 bits per pixel, 4 pixels per byte<br />
        <strong>Colors:</strong> Black (0), Dark Gray (1), Light Gray (2), White (3)<br />
        <strong>Data Size:</strong> (width × height) ÷ 4 bytes
      </p>

      <h3>How It Works</h3>
      <p>
        Each pixel uses 2 bits to encode one of four grayscale levels. Pixels are packed left to right,
        similar to Scheme 3, with the leftmost pixel using bits 7-6, next pixel using bits 5-4, and so on.
      </p>

      <p>Example: 4 pixels in a row</p>
      <table>
        <thead><tr><th></th><th>1</th><th>2</th><th>3</th><th>4</th><th>Byte</th></tr></thead><tbody
          ><tr><td>Pixel</td><td>W</td><td>B</td><td>LG</td><td>DG</td><td></td></tr><tr
            ><td>Bits</td><td><code>11</code></td><td><code>00</code></td><td><code>10</code></td><td
              ><code>01</code></td
            ><td><code>0xC9</code></td></tr
          ></tbody
        >
      </table>
      <p>(W=11, B=00, LG=10, DG=01 = 11001001 = 0xC9)</p>
      <p>
        <strong>Bit pairs (left to right):</strong> 11 (White), 00 (Black), 10 (Light Gray), 01 (Dark Gray)
      </p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="pixel-ordering">Pixel Ordering</h2>
      <p>
        Pixels are always processed in row-major order: from top to bottom, left to right within each row.
      </p>

      <h3>Example: 4×4 Image</h3>
      <table>
        <caption>Pixel index, row by row</caption><tbody
          ><tr><td>0</td><td>1</td><td>2</td><td>3</td></tr><tr><td>4</td><td>5</td><td>6</td><td>7</td></tr
          ><tr><td>8</td><td>9</td><td>10</td><td>11</td></tr><tr
            ><td>12</td><td>13</td><td>14</td><td>15</td></tr
          ></tbody
        >
      </table>
      <p>
        <strong>Order:</strong> 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15
      </p>

      <h3>Byte Packing for Scheme 0 (1 bit/pixel)</h3>
      <pre><code>
<code
            >Row 0: Pixel 0, Pixel 1, Pixel 2, Pixel 3
Row 1: Pixel 4, Pixel 5, Pixel 6, Pixel 7
Row 2: Pixel 8, Pixel 9, Pixel 10, Pixel 11
Row 3: Pixel 12, Pixel 13, Pixel 14, Pixel 15

Byte 0: Pixels 0-7 (Row 0: 0-3, Row 1: 4-7)
Byte 1: Pixels 8-15 (Row 2: 8-11, Row 3: 12-15)</code
          >
    </code></pre>

      <p>For bitplane schemes (1 and 2), all rows of Plane 1 are sent first, then all rows of Plane 2.</p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="implementation-notes">Implementation Notes</h2>
      <ul>
        <li>
          When a row doesn't fill a complete byte, the remaining bits in the last byte are padded with zeros.
        </li>
        <li>For bitplane schemes, ensure Plane 1 and Plane 2 have the same number of bytes.</li>
        <li>
          Color detection from RGB values uses thresholds: pixels are classified based on their RGB
          components.
        </li>
        <li>
          The image data must be sent in the rotated orientation. The client should apply rotation before
          encoding the pixel data.
        </li>
        <li>
          Data can be compressed using zlib before transmission when the device supports streaming
          decompression (see below).
        </li>
        <li>
          Uncompressed direct write has no protocol-level size limit — pixels stream directly into the
          framebuffer.
        </li>
      </ul>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="transmission-protocols">Transmission Protocols</h2>
      <p>
        While the image encoding format is identical for both standards, the transmission protocols differ.
        This section explains how image data is sent in each standard.
      </p>

      <h3>OpenDisplay Basic</h3>
      <p>In the Basic standard, image data is sent as part of the "New Image" response packet (0x82):</p>
      <pre><code>
<code
            >Packet Type: 0x82
Offset 0: packet_type (1 byte) = 0x82
Offset 1-2: image_length (2 bytes, uint16, little-endian)
Offset 3-6: poll_interval (4 bytes, uint32, little-endian)
Offset 7: refresh_type (1 byte) = 0 (normal) or 1 (fast)
Offset 8 to (8+image_length-1): image_data (variable)</code
          >
    </code></pre>
      <ul>
        <li><strong>Image Data:</strong> Raw encoded pixel data (or compressed using zlib)</li>
        <li>
          <strong>No Chunking:</strong> Entire image is sent in one packet (wrapped in outer packet format for TCP)
        </li>
        <li>
          <strong>TCP Support:</strong> Over TCP, packets can be up to 8KB, allowing larger images in a single transmission
        </li>
        <li>
          <strong>BLE Support:</strong> Over BLE, the image data must fit within BLE packet size limits (~200 bytes
          per chunk)
        </li>
      </ul>
      <p>
        See <strong><a href={href.basicStandard}>OpenDisplay Basic</a></strong> for complete packet specifications.
      </p>

      <h3 id="transmission-reference">Full GATT protocol (reference firmware)</h3>
      <p>
        Wire-level details: <a href={href.bleFlow + '#image-transfer'}
          >Communication protocol — image transfer</a
        >. Panel geometry comes from Flex config, not from the client start command.
      </p>

      <h4>Start command (<code>0x0070</code>)</h4>
      <pre><code>
<code
            >Command: 0x00 0x70

Payload (uncompressed direct write):
  (empty — fewer than 4 bytes)

Payload (streaming decompression):
  [uncompressed_size: 4 bytes, little-endian]
  [optional zlib prefix bytes in the same command]</code
          >
    </code></pre>

      <h4>Data command (<code>0x0071</code>)</h4>
      <pre><code>
<code
            >Command: 0x00 0x71
Payload: raw pixel bytes OR continuation of zlib stream
  - BLE: up to ~230 bytes per chunk
  - LAN: up to ~1000 bytes per chunk</code
          >
    </code></pre>

      <h4>End command (<code>0x0072</code>)</h4>
      <pre><code>
<code
            >Command: 0x00 0x72
Payload (optional):
  [refresh_mode: 1 byte] — 0 = full (default), 1 = fast refresh
  [new_etag: 4 bytes, big-endian] — optional after full-frame upload

After refresh: device notifies 0x00 0x73 (success) or 0x00 0x74 (timeout)</code
          >
    </code></pre>

      <h4>Partial region update (<code>0x0076</code>)</h4>
      <p>
        1 bpp B/W panels only. Stream layout: <code>old_region_bits || new_region_bits</code>, each
        <code>ceil(w/8) × h</code> bytes. Region <code>x</code> and <code>w</code> must be multiples of 8.
        Uses the same <code>0x0071</code>/<code>0x0072</code> chunking as full frames. See
        <a href={href.bleFlow + '#partial-update'}>partial update</a>.
      </p>

      <h3>Maximum Packet Sizes</h3>
      <table>
        <thead>
          <tr>
            <th>Transport</th>
            <th>Standard</th>
            <th>Maximum Chunk Size</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>BLE</td>
            <td>Basic</td>
            <td>~200 bytes (wrapped in outer packet)</td>
          </tr>
          <tr>
            <td>BLE</td>
            <td>Flex</td>
            <td>230 bytes per chunk (0x0071 command)</td>
          </tr>
          <tr>
            <td>TCP</td>
            <td>Basic</td>
            <td>Up to 8KB (wrapped in outer packet)</td>
          </tr>
          <tr>
            <td>TCP</td>
            <td>Flex</td>
            <td>1000 bytes per chunk (0x0071 command)</td>
          </tr>
        </tbody>
      </table>

      <h3 id="streaming-decompression">Streaming decompression</h3>
      <p>
        When Flex <code>transmission_modes</code> has both <code>streaming_decompression</code> (bit 0) and
        <code>zip</code> (bit 1) set, the client may send a zlib DEFLATE stream over direct write. The device decompresses
        incrementally and writes pixels as they are decoded — no full-frame buffer on the device.
      </p>
      <ul>
        <li><strong>Client:</strong> compress with <code>window_bits = 9</code> (512-byte DEFLATE window)</li>
        <li>
          <strong>Basic standard:</strong> compressed data may still be embedded in packet <code>0x82</code> (separate
          profile)
        </li>
        <li>
          <strong>New senders:</strong> do not use legacy large-window zlib. If streaming decompression is not
          advertised, use <strong>uncompressed</strong> direct write
        </li>
        <li>
          <strong>Firmware v2:</strong> reference firmware version 2 will drop legacy large-window zlib; only streaming
          decompression remains (v1.x ESP32/nRF builds still accept both)
        </li>
      </ul>

      <p>
        See <strong><a href={href.bleFlow}>OpenDisplay communication protocol</a></strong> (BLE &amp; LAN) for complete
        transfer specifications.
      </p>
    </Prose>
  </Card>
</Page>
