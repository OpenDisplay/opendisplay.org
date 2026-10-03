<script>
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import Page from '#lib/ui/Page.svelte';
  import Prose from '#lib/ui/Prose.svelte';
  import { href } from '#lib/paths.js';
</script>

<svelte:head>
  <title>Protocol Documentation · OpenDisplay</title>
</svelte:head>

<Page title="Protocol Documentation" width="prose">
  {#snippet lead()}Three layers: the <strong>OpenDisplay</strong> spec, the <strong>Flex</strong>
    configuration extension for reference firmware, and optional <strong>Flex tools</strong>.{/snippet}

  <Card>
    <Prose>
      <h2>Overview</h2>
      <p>
        OpenDisplay lets senders (apps, Home Assistant, custom code) push rendered images to e-paper receivers
        over Bluetooth Low Energy and, on some devices, the same command set over Wi‑Fi LAN. The documentation
        is split so manufacturers and sender authors can follow the core spec without wading through
        reference-firmware details.
      </p>

      <h3>Devices & Protocols</h3>
      <ul>
        <li>
          <strong>Client Devices:</strong> Computers, smartphones, tablets, web browsers, or Home Assistant running
          client applications. A Python module is available for easy integration.
        </li>
        <li>
          <strong>Display Devices:</strong> E-paper displays that implement the OpenDisplay BLE or OpenDisplay WiFi
          standard. This includes devices running OpenDisplay firmware on ESP32-S3, ESP32-C3, ESP32-C6, or nRF52840
          microcontrollers, as well as other firmware implementations that speak the protocol.
        </li>
        <li>
          <strong>Communication:</strong> BLE GATT (service <code>0x2446</code>) plus optional Wi‑Fi LAN on
          reference firmware — see the <a href={href.bleFlow}>communication protocol</a>.
        </li>
        <li>
          <strong>Configuration:</strong> Fixed-product implementations use a minimal announcement; reference
          firmware stores a Flex YAML blob — see <a href={href.flexStandard}>OpenDisplay Flex</a>.
        </li>
        <li>
          <strong>Image format:</strong> Shared pixel encoding — see
          <a href={href.displayDataFormat}>display data format</a>
          and <a href={href.openDisplayLanguage}>OpenDisplay Language</a>.
        </li>
      </ul>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2>1. OpenDisplay — the spec</h2>
      <p>
        The protocol any sender or product implementation should follow: BLE advertising, configuration
        read/write, image transfer, encryption, optional LAN transport, display data encoding, and OpenDisplay
        Language. Start here for manufacturers and client authors.
      </p>
      <p>
        <a href={href.basicStandard}>OpenDisplay specification</a> ·
        <a href={href.bleFlow}>Communication protocol (BLE &amp; LAN)</a> ·
        <a href={href.firmwareVariants}>Firmware variants</a> ·
        <a href={href.displayDataFormat}>Display data format</a> ·
        <a href={href.openDisplayLanguage}>OpenDisplay Language</a>
      </p>
      <Button href={href.basicStandard}>Read the spec</Button>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2>Reference firmware variants</h2>
      <p>
        ESP32/nRF and Silicon Labs BG22 builds share the same GATT commands but differ in partial refresh,
        NFC, Wi‑Fi/LAN, and compression window support. Use this matrix when writing senders for reference
        hardware.
      </p>
      <Button href={href.firmwareVariants}>View capability matrix</Button>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2>2. OpenDisplay Flex — configuration extension</h2>
      <p>
        A YAML schema compiled to a binary TLV blob. Used by the reference firmware on development boards so
        one firmware binary can support many panels and pinouts. Flex is <em>not</em> a separate wire protocol —
        clients still use the OpenDisplay commands above.
      </p>
      <p>
        <a href={href.yamlConfig}>Full YAML schema reference</a>
      </p>
      <Button href={href.flexStandard}>OpenDisplay Flex</Button>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2>3. Flex tools — reference firmware only</h2>
      <p>
        Browser tools for flashing presets and extending reference firmware. Marked separately so spec readers
        and product integrators are not sent through DIY tooling by default.
      </p>
      <p>
        <a href={href.toolbox}>Toolbox</a> ·
        <a href={href.addingDisplays}>Adding a new panel</a>
      </p>
      <Button href={href.flexTools}>Flex tools overview</Button>
    </Prose>
  </Card>
</Page>
