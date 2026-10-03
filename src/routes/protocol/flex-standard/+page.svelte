<script>
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import Page from '#lib/ui/Page.svelte';
  import Prose from '#lib/ui/Prose.svelte';
  import { href } from '#lib/paths.js';
</script>

<svelte:head>
  <title>OpenDisplay Flex · OpenDisplay</title>
</svelte:head>

<Page title="OpenDisplay Flex" toc>
  {#snippet lead()}Configuration extension for the <strong>reference firmware</strong> — not a separate communication
    protocol.{/snippet}

  <Card>
    <Prose>
      <h2 id="what-flex-is">What Flex is</h2>
      <p>
        <strong>OpenDisplay Flex</strong> is a YAML-based configuration schema. Tools compile it into a binary TLV
        blob that describes a specific board: host MCU, display panel(s), pin wiring, power options, optional Wi‑Fi
        credentials, encryption keys, sensors, and other peripherals.
      </p>
      <p>
        The <a href="https://github.com/OpenDisplay/Firmware">reference firmware</a> uses Flex so one firmware
        binary can support many development boards and e-paper panels. Flash a preset from the
        <a href={href.toolbox}>Toolbox</a> (a Flex tool), and the device advertises the correct capabilities to
        any OpenDisplay client.
      </p>
      <p>
        Clients still speak the <strong><a href={href.bleFlow}>OpenDisplay communication protocol</a></strong>
        for configuration read/write, image transfer, and encryption. Flex only defines <em>what</em> is
        stored in the configuration blob — see the <a href={href.yamlConfig}>YAML schema</a> for field detail.
      </p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="who-needs-flex">Who needs Flex</h2>
      <table>
        <thead>
          <tr>
            <th>You are…</th>
            <th>Read this</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Building with reference firmware on a dev board</td>
            <td>Flex config + <a href={href.flexTools}>Flex tools</a></td>
          </tr>
          <tr>
            <td>Adding a new panel to reference firmware</td>
            <td
              ><a href={href.addingDisplays}>Adding a new panel</a> +
              <a href={href.yamlConfig}>YAML schema</a></td
            >
          </tr>
          <tr>
            <td>Implementing OpenDisplay on a fixed product</td>
            <td><a href={href.basicStandard}>OpenDisplay spec</a> only — Flex is optional</td>
          </tr>
          <tr>
            <td>Writing a sender (Python, HA, custom app)</td>
            <td
              ><a href={href.bleFlow}>Communication protocol</a> +
              <a href={href.displayDataFormat}>Display data format</a></td
            >
          </tr>
        </tbody>
      </table>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="schema-and-binary-format">Schema and binary format</h2>
      <p>
        Canonical schema: <code>firmware/toolbox/config.yaml</code> (version <strong>1.2</strong> — major 1, minor
        2). The Toolbox and reference firmware share this file.
      </p>
      <p>
        Configuration is transferred as an <strong>outer packet</strong>: 2-byte length, 1-byte version, a
        sequence of inner packets, then a 2-byte CRC. The CRC is CRC-16/CCITT-FALSE (init 0xFFFF, poly 0x1021)
        computed over the container excluding the trailing CRC, with the 2 length bytes treated as zero. Each
        inner packet has a sequential <code>number</code>, a type <code>id</code>, and a typed payload. Full
        field definitions: <a href={href.yamlConfig}>YAML configuration reference</a>.
      </p>
      <p>
        On the wire, configuration uses OpenDisplay commands <code>0x0040</code> (read), <code>0x0041</code>
        (write / first chunk), and <code>0x0042</code> (subsequent chunks). After a successful write, send
        <code>0x000F</code> to reboot and apply.
      </p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="packet-types-in-reference-firmware">Packet types in reference firmware</h2>
      <p>
        The table below lists Flex packet type IDs from the schema and whether the current reference firmware
        parses them at boot (<code>config_parser.cpp</code>).
      </p>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Reference firmware</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>1</code> (<code>0x01</code>)</td>
            <td><code>system_config</code></td>
            <td>✓ Required — MCU type, pins, communication modes</td>
          </tr>
          <tr>
            <td><code>2</code> (<code>0x02</code>)</td>
            <td><code>manufacturer_data</code></td>
            <td>✓ Manufacturer ID and product strings</td>
          </tr>
          <tr>
            <td><code>4</code> (<code>0x04</code>)</td>
            <td><code>power_option</code></td>
            <td>✓ Battery, deep sleep, power pins</td>
          </tr>
          <tr>
            <td><code>32</code> (<code>0x20</code>)</td>
            <td><code>display</code></td>
            <td>✓ Up to 4 panels — resolution, color scheme, bus</td>
          </tr>
          <tr>
            <td><code>33</code> (<code>0x21</code>)</td>
            <td><code>led</code></td>
            <td>✓ Up to 4 RGB/status LEDs</td>
          </tr>
          <tr>
            <td><code>35</code> (<code>0x23</code>)</td>
            <td><code>sensor_data</code></td>
            <td>✓ Up to 4 sensors (e.g. SHT40)</td>
          </tr>
          <tr>
            <td><code>36</code> (<code>0x24</code>)</td>
            <td><code>data_bus</code></td>
            <td>✓ SPI / I2C bus instances</td>
          </tr>
          <tr>
            <td><code>37</code> (<code>0x25</code>)</td>
            <td><code>binary_inputs</code></td>
            <td>✓ Buttons and GPIO inputs</td>
          </tr>
          <tr>
            <td><code>38</code> (<code>0x26</code>)</td>
            <td><code>wifi_config</code></td>
            <td>✓ ESP32 STA credentials + optional server URL/port</td>
          </tr>
          <tr>
            <td><code>39</code> (<code>0x27</code>)</td>
            <td><code>security_config</code></td>
            <td>✓ AES-128 PSK and encryption flag</td>
          </tr>
          <tr>
            <td><code>40</code> (<code>0x28</code>)</td>
            <td><code>touch_controller</code></td>
            <td>✓ Touch IC + MSD slot mapping</td>
          </tr>
          <tr>
            <td><code>41</code> (<code>0x29</code>)</td>
            <td><code>passive_buzzer</code></td>
            <td>✓ Buzzer instances</td>
          </tr>
          <tr>
            <td><code>42</code> (<code>0x2A</code>)</td>
            <td><code>nfc_config</code></td>
            <td>In schema only — not parsed by reference firmware yet</td>
          </tr>
          <tr>
            <td><code>43</code> (<code>0x2B</code>)</td>
            <td><code>flash_config</code></td>
            <td>In schema only — not parsed by reference firmware yet</td>
          </tr>
        </tbody>
      </table>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="ble-advertising-and-discovery">BLE advertising and discovery</h2>
      <p>
        Reference firmware uses BLE service and characteristic UUID <strong>0x2446</strong> (128-bit form
        <code>00002446-0000-1000-8000-00805F9B34FB</code>). Manufacturer Specific Data uses company identifier
        <strong>0x2446</strong> with a <strong>16-byte</strong> payload (dynamic status, touch, sensor slots,
        etc.). Clients can read the live MSD with command <code>0x0044</code>.
      </p>
      <p>
        When <code>communication_modes</code> includes Wi‑Fi, the device joins the configured access point and
        listens on TCP port <strong>2446</strong> by default, advertising <code>_opendisplay._tcp</code> via
        mDNS. LAN uses the same command bytes as BLE — see
        <a href={href.bleFlow + '#lan-wifi-transport'}>LAN transport</a>.
      </p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="image-transfer-opendisplay-protocol">Image transfer (OpenDisplay protocol)</h2>
      <p>
        Flex configuration tells the device display dimensions, color scheme, and capabilities (packet type
        32). Image bytes use the shared
        <a href={href.displayDataFormat}>display data format</a>. Reference firmware implements
        <strong>direct write</strong> (<code>0x0070</code>–<code>0x0072</code>). Full wire spec:
        <a href={href.bleFlow + '#image-transfer'}>image transfer</a>.
      </p>
      <p>
        <strong>Streaming decompression:</strong> when <code>transmission_modes</code> has both
        <code>streaming_decompression</code>
        (bit 0) and <code>zip</code> (bit 1), clients may send a zlib stream with a 512-byte DEFLATE window.
        <strong>New senders must not use legacy large-window zlib</strong> — if streaming decompression is not
        advertised, use uncompressed direct write. Legacy acceptance ends with
        <strong>firmware version 2</strong>. See
        <a href={href.bleFlow + '#streaming-decompression'}>streaming decompression</a>.
      </p>
      <p>
        <strong>Partial updates:</strong> <code>partial_update_support: 1</code> advertises 1 bpp region
        refresh via <code>0x0076</code>;
        <code>2</code> requires the partial stream to cover the full panel (e.g. EP426 / Seeed EN05). Main
        firmware only — <a href={href.firmwareVariants}>variants</a>.
      </p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="full-schema-reference">Full schema reference</h2>
      <p>
        Every field, enum, and bit in the Flex configuration schema — packet types 1 through 43, CRC rules,
        and examples.
      </p>
      <Button href={href.yamlConfig}>YAML configuration reference</Button>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="flex-tools">Flex tools</h2>
      <p>
        Browser tools for flashing reference firmware and editing Flex presets. Not needed if you only
        implement or talk to a fixed OpenDisplay product.
      </p>
      <Button href={href.flexTools}>Flex tools overview</Button>
    </Prose>
  </Card>
</Page>
