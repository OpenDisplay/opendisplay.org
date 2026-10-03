<script>
  import Card from '#lib/ui/Card.svelte';
  import Page from '#lib/ui/Page.svelte';
  import Prose from '#lib/ui/Prose.svelte';
  import { href } from '#lib/paths.js';
</script>

<svelte:head>
  <title>Reference firmware variants · OpenDisplay</title>
</svelte:head>

<Page title="Reference firmware variants" width="prose">
  {#snippet lead()}Both trees speak the same GATT command set over service <code>0x2446</code>. This page
    lists where <a href="https://github.com/OpenDisplay/Firmware">main Firmware</a> (ESP32 / nRF52840) and
    <a href="https://github.com/OpenDisplay/Firmware-silabs-bg22">Firmware-silabs-bg22</a> differ.{/snippet}

  <Card>
    <Prose>
      <h2>Capability matrix</h2>
      <table>
        <thead>
          <tr>
            <th>Capability</th>
            <th>Main Firmware</th>
            <th>BG22 firmware</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>GATT service <code>0x2446</code></td>
            <td>Yes</td>
            <td>Yes</td>
          </tr>
          <tr>
            <td>Flex config <code>0x0040</code>–<code>0x0042</code></td>
            <td>Yes</td>
            <td>Yes (+ NFC / flash packets parsed)</td>
          </tr>
          <tr>
            <td>AES-CCM <code>0x0050</code></td>
            <td>Yes</td>
            <td>Yes</td>
          </tr>
          <tr>
            <td>Direct write <code>0x0070</code>–<code>0x0072</code></td>
            <td>Yes</td>
            <td>Yes</td>
          </tr>
          <tr>
            <td
              ><a href={href.bleFlow + '#streaming-decompression'}>Streaming decompression</a> (<code
                >streaming_decompression</code
              >
              + <code>zip</code> bits)</td
            >
            <td>Yes</td>
            <td>Yes (only compression mode)</td>
          </tr>
          <tr>
            <td>Legacy large-window zlib (32 KB DEFLATE window)</td>
            <td>v1.x ESP32/nRF only — removed in <strong>firmware v2</strong></td>
            <td>Never supported (512 B window only)</td>
          </tr>
          <tr>
            <td><a href={href.bleFlow + '#partial-update'}>Partial region</a> <code>0x0076</code></td>
            <td>Yes (1 bpp panels)</td>
            <td>Not implemented</td>
          </tr>
          <tr>
            <td>LED <code>0x0073</code> / <code>0x0075</code></td>
            <td>Yes</td>
            <td>Yes</td>
          </tr>
          <tr>
            <td>Buzzer <code>0x0077</code></td>
            <td>Yes</td>
            <td>No</td>
          </tr>
          <tr>
            <td><a href={href.bleFlow + '#nfc-endpoint'}>NFC endpoint</a> <code>0x0083</code></td>
            <td>No</td>
            <td>Yes</td>
          </tr>
          <tr>
            <td>Wi‑Fi / LAN TCP port 2446</td>
            <td>ESP32 only</td>
            <td>No</td>
          </tr>
          <tr>
            <td>Multi-display</td>
            <td>Up to 4 panels</td>
            <td>Display [0] only</td>
          </tr>
          <tr>
            <td>Max pipe payload (BLE)</td>
            <td>~230 B typical (MTU 512)</td>
            <td>244 B</td>
          </tr>
          <tr>
            <td>DFU <code>0x0051</code></td>
            <td>Platform-specific</td>
            <td>Yes</td>
          </tr>
        </tbody>
      </table>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2>Sender guidance</h2>
      <p>
        <strong>New senders must not use legacy large-window zlib.</strong> Read Flex
        <code>transmission_modes</code>
        from config (or presets). If <code>streaming_decompression</code> and <code>zip</code> are both set,
        compress with
        <code>window_bits = 9</code> (512-byte DEFLATE window). Otherwise send an
        <strong>uncompressed</strong> direct write — do not fall back to legacy compression.
      </p>
      <p>
        Firmware <strong>version 1.x</strong> (high byte of <code>0x0043</code>) on existing ESP32/nRF builds
        still accepts legacy streams for backward compatibility. <strong>Version 2</strong> drops that path entirely.
      </p>
      <p>
        Wire protocol details: <a href={href.bleFlow}>Communication protocol</a>.
      </p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2>Source code entry points</h2>
      <ul>
        <li>
          <strong>Main:</strong> <code>Firmware/src/communication.cpp</code>,
          <code>display_service.cpp</code>, <code>structs.h</code>
        </li>
        <li>
          <strong>BG22:</strong> <code>Firmware-silabs-bg22/opendisplay_pipe.c</code>,
          <code>opendisplay_display.cpp</code>, <code>opendisplay_structs.h</code>
        </li>
        <li><strong>Shared config schema:</strong> <code>web/firmware/toolbox/config.yaml</code></li>
      </ul>
    </Prose>
  </Card>
</Page>
