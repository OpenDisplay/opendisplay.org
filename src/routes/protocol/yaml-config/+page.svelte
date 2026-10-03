<script>
  import Badge from '#lib/ui/Badge.svelte';
  import Card from '#lib/ui/Card.svelte';
  import Page from '#lib/ui/Page.svelte';
  import Prose from '#lib/ui/Prose.svelte';
  import { href } from '#lib/paths.js';
</script>

<svelte:head>
  <title>YAML Configuration · OpenDisplay</title>
</svelte:head>

<Page title="YAML Configuration" toc>
  {#snippet lead()}Part of <strong><a href={href.flexStandard}>OpenDisplay Flex</a></strong> — the configuration
    extension for reference firmware{/snippet}

  <Card>
    <Prose>
      <p>
        <strong>OpenDisplay Flex</strong> is a YAML-based configuration schema, not a wire protocol. Tools
        compile it into a binary TLV blob that reference firmware stores on the device. Clients discover
        capabilities through the normal OpenDisplay configuration read (<code>0x0040</code>) and the commands
        in the
        <a href={href.bleFlow}>communication protocol</a>.
      </p>
      <p>
        This page documents every packet type and field in the schema (canonical source:
        <code>firmware/toolbox/config.yaml</code>, version 1.2). See
        <strong><a href={href.flexStandard}>OpenDisplay Flex</a></strong> for an overview and which packet types
        reference firmware parses today.
      </p>
      <p>
        This configuration fully explains all capabilities the device has, including display specifications,
        power management options, communication modes, sensor support, and all other device settings. The
        configuration is used by tools like the Toolbox to generate and parse configuration packets, and by
        clients to understand what features are available on a particular device.
      </p>
      <p>
        The configuration schema is designed to be extensible. New packet types and fields can be added to
        support additional features while maintaining backward compatibility through versioning and reserved
        fields. This allows the protocol to evolve and accommodate new device capabilities without breaking
        existing implementations.
      </p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="packet-structure">Packet Structure</h2>

      <p>
        The configuration is organized as an outer packet containing multiple inner packets. Each inner packet
        represents a specific aspect of the device configuration (display, power, sensors, etc.):
      </p>

      <table>
        <caption>Bytes on the wire, in order</caption>
        <thead>
          <tr><th>Part</th><th>Field</th><th>Size</th><th>Value</th></tr>
        </thead>
        <tbody>
          <tr><td>Outer packet</td><td><code>length</code></td><td>2 bytes</td><td></td></tr>
          <tr><td>Outer packet</td><td><code>version</code></td><td>1 byte</td><td></td></tr>
          <tr
            ><td>Packet #0</td><td><code>number</code>, <code>id</code></td><td>1 + 1 bytes</td><td
              >0, 1 (system_config)</td
            ></tr
          >
          <tr
            ><td>Packet #1</td><td><code>number</code>, <code>id</code></td><td>1 + 1 bytes</td><td
              >1, 2 (manufacturer_data)</td
            ></tr
          >
          <tr
            ><td>Packet #2</td><td><code>number</code>, <code>id</code></td><td>1 + 1 bytes</td><td
              >2, 32 (display configuration)</td
            ></tr
          >
          <tr><td>…</td><td colspan="3">more packets, each followed by its payload</td></tr>
          <tr><td>Outer packet</td><td><code>crc</code></td><td>2 bytes</td><td></td></tr>
        </tbody>
      </table>
      <h3>Outer Packet</h3>
      <p>The outer packet wraps the entire configuration transfer:</p>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Size</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>length</code></td>
            <td>2 bytes</td>
            <td>Total length including CRC (max 4kB recommended)</td>
          </tr>
          <tr>
            <td><code>version</code></td>
            <td>1 byte</td>
            <td>Major protocol version</td>
          </tr>
          <tr>
            <td><code>packets</code></td>
            <td>variable</td>
            <td>Sequence of single_packet entries</td>
          </tr>
          <tr>
            <td><code>crc</code></td>
            <td>2 bytes</td>
            <td
              >CRC-16/CCITT-FALSE (init 0xFFFF, poly 0x1021) over the container excluding the trailing CRC
              field, with the 2 length bytes treated as zero</td
            >
          </tr>
        </tbody>
      </table>

      <h3>Single Packet</h3>
      <p>Each packet in the sequence has this structure:</p>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Size</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>number</code></td>
            <td>1 byte</td>
            <td>Packet index (0-based, sequential)</td>
          </tr>
          <tr>
            <td><code>id</code></td>
            <td>1 byte</td>
            <td>Packet type identifier</td>
          </tr>
          <tr>
            <td><code>payload</code></td>
            <td>variable</td>
            <td>Packet-specific payload</td>
          </tr>
        </tbody>
      </table>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="field-types">Field Types</h2>

      <h3>Fixed-Size Fields</h3>
      <p>Fields with a fixed size are specified with a number:</p>
      <pre><code
          >- name: ic_type
  size: 2
  description: IC used in this device</code
        ></pre>

      <h3>Enumerations</h3>
      <p>Fields can have enumerated values:</p>
      <pre><code
          >- name: ic_type
  size: 2
  enum:
    1:
      name: NRF52840
      description: nrf52840 based boards
    2:
      name: ESP32S3
      description: esp32-s3 based boards</code
        ></pre>

      <h3>Conditional Enumerations</h3>
      <p>Enum values can depend on another field's value:</p>
      <pre><code
          >- name: board_type
  size: 1
  conditional_enum:
    depends_on: manufacturer_id
    values:
      1:  # if manufacturer_id == 1 (Seeed)
        0:
          name: EE04
          description: XIAO ePaper Display EE04</code
        ></pre>

      <h3>Bitfields</h3>
      <p>Fields can be bitfields where each bit has a specific meaning:</p>
      <pre><code
          >- name: communication_modes
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
      description: WiFi LAN (TCP) transfer supported</code
        ></pre>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="packet-types">Packet Types</h2>
      <p>
        The protocol defines multiple packet types, each representing a different aspect of device
        configuration. For detailed field definitions, enumerations, and constraints, use the <a
          href={href.toolbox}
          target="_blank"
          rel="noreferrer">Toolbox</a
        > tool, which provides an interactive interface to explore all packet types and their fields.
      </p>

      <h4>Packet Type 1: system_config <Badge>Required</Badge></h4>
      <p>Contains information about the host microcontroller (IC type) and power management configuration.</p>

      <h4>Packet Type 2: manufacturer_data <Badge>Required</Badge></h4>
      <p>Identifies the manufacturer and specific board model/revision.</p>

      <h4>Packet Type 4: power_option <Badge>Required</Badge></h4>
      <p>
        Defines power supply settings, battery capacity, sleep behavior, and power consumption
        characteristics.
      </p>

      <h4 id="packet-type-32">Packet Type 32: display <Badge>Repeatable</Badge></h4>
      <p>
        Specifies display/panel configuration including dimensions, color scheme, controller type, pin
        assignments, and transfer capabilities. This packet is required for the protocol to function. Can
        appear multiple times for devices with multiple displays.
      </p>
      <p>Key fields for senders:</p>
      <ul>
        <li>
          <code>pixel_width</code>, <code>pixel_height</code>, <code>color_scheme</code> — frame geometry and encoding
        </li>
        <li>
          <code>partial_update_support</code> — <code>0</code> none; <code>1</code> 1 bpp partial region
          refresh (<code>0x0076</code>); <code>2</code> partial supported but full-frame stream required
        </li>
        <li>
          <code>transmission_modes</code> bitfield — <code>streaming_decompression</code> (bit 0) +
          <code>zip</code>
          (bit 1) enable compressed direct write; <code>direct_write</code> (bit 3) marks bufferless mode
        </li>
      </ul>
      <p>
        Full field list: <code>web/firmware/toolbox/config.yaml</code> or the
        <a href={href.toolbox}>Toolbox</a>.
      </p>

      <h4>Packet Type 33: led <Badge>Repeatable</Badge></h4>
      <p>Optional LED configuration for devices with status or RGB LEDs.</p>

      <h4>Packet Type 35: sensor_data <Badge>Repeatable</Badge></h4>
      <p>Optional sensor configuration for devices with environmental or other sensors.</p>

      <h4>Packet Type 36: data_bus <Badge>Repeatable</Badge></h4>
      <p>Defines communication buses (I2C, SPI, etc.) used by sensors or other peripherals.</p>

      <h4>Packet Type 37: binary_inputs <Badge>Repeatable</Badge></h4>
      <p>Optional configuration for buttons, switches, or other binary input devices.</p>

      <h4>Packet Type 38: wifi_config <Badge>Wi‑Fi LAN</Badge></h4>
      <p>
        Station credentials for devices that use Flex <a href={href.bleFlow + '#lan-wifi-transport'}
          >LAN (Wi‑Fi) transport</a
        >: 32-byte SSID, 32-byte password (null-terminated, zero-padded), 1-byte encryption type enum (none,
        WEP, WPA, WPA2, WPA3), plus reserved bytes per schema. Required in non-volatile config (along with
        <code>communication_modes</code>
        bit <code>wifi</code>) before the device will join the network and open the TCP server.
      </p>

      <h4 id="packet-type-39">Packet Type 39: security_config</h4>
      <p>
        Optional <strong>application-layer encryption</strong>: 16-byte AES-128 pre-shared key,
        <code>encryption_enabled</code>,
        <code>session_timeout_seconds</code> (0 = no timeout), security flags (<code>rewrite_allowed</code>
        for unauthenticated config recovery), and reset-pin fields per schema. If the key is all zeros, encryption
        is off. See
        <a href={href.bleFlow + '#encryption-authentication'}>Encryption and authentication</a> in the communication
        protocol.
      </p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="packet-properties">Packet Properties</h2>

      <h3>Required Packets</h3>
      <p>
        Some packet types are marked as <Badge>required</Badge>, meaning they must appear in every
        configuration
      </p>

      <h3>Repeatable Packets</h3>
      <p>
        Some packet types are marked as <Badge>repeatable</Badge>, meaning they can appear multiple times
      </p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="using-the-yaml-config">Using the YAML Config</h2>

      <p>
        The <a href={href.toolbox} target="_blank" rel="noreferrer">Toolbox</a> web tool loads the YAML configuration
        to:
      </p>
      <ul>
        <li>Generate UI forms for each packet type</li>
        <li>Validate field values against enums and constraints</li>
        <li>Build binary configuration packets</li>
        <li>Parse received configuration data</li>
      </ul>

      <h3>Configuration Flow</h3>
      <ol>
        <li>Load YAML schema from <code>config.yaml</code></li>
        <li>User selects/edits packet instances</li>
        <li>Tool validates all fields</li>
        <li>Tool builds binary packet with CRC</li>
        <li>Packet is sent to the device (typically via BLE; LAN is available after Wi‑Fi is configured)</li>
      </ol>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="reserved-fields">Reserved Fields</h2>
      <p>
        Many packet types include reserved fields for future compatibility. According to the protocol
        specification:
      </p>
      <ul>
        <li>Reserved fields MUST be set to 0 unless otherwise specified</li>
        <li>Reserved byte blocks are provided for forward compatibility</li>
        <li>Older parsers should ignore reserved fields they don't understand</li>
      </ul>
    </Prose>
  </Card>
</Page>
