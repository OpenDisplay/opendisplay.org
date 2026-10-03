<script>
  import Hub from '#lib/ui/Hub.svelte';
  import { href } from '#lib/paths.js';

  const destinations = [
    {
      title: '1. OpenDisplay — the spec',
      text: 'The protocol any sender or product implementation should follow: BLE advertising, configuration read/write, image transfer, encryption, optional LAN transport, display data encoding, and OpenDisplay Language. Start here for manufacturers and client authors.',
      links: [
        ['Communication protocol (BLE & LAN)', href.bleFlow],
        ['Firmware variants', href.firmwareVariants],
        ['Display data format', href.displayDataFormat],
        ['OpenDisplay Language', href.openDisplayLanguage],
      ],
      action: ['Read the spec', href.basicStandard],
    },
    {
      title: 'Reference firmware variants',
      text: 'ESP32/nRF and Silicon Labs BG22 builds share the same GATT commands but differ in partial refresh, NFC, Wi‑Fi/LAN, and compression window support. Use this matrix when writing senders for reference hardware.',
      action: ['View capability matrix', href.firmwareVariants],
    },
    {
      title: '2. OpenDisplay Flex — configuration extension',
      text: 'A YAML schema compiled to a binary TLV blob. Used by the reference firmware on development boards so one firmware binary can support many panels and pinouts. Flex is not a separate wire protocol — clients still use the OpenDisplay commands above.',
      links: [['Full YAML schema reference', href.yamlConfig]],
      action: ['OpenDisplay Flex', href.flexStandard],
    },
    {
      title: '3. Flex tools — reference firmware only',
      text: 'Browser tools for flashing presets and extending reference firmware. Marked separately so spec readers and product integrators are not sent through DIY tooling by default.',
      links: [
        ['Toolbox', href.toolbox],
        ['Adding a new panel', href.addingDisplays],
      ],
      action: ['Flex tools overview', href.flexTools],
    },
  ];
</script>

<svelte:head>
  <title>Protocol Documentation · OpenDisplay</title>
</svelte:head>

<Hub title="Protocol Documentation" {destinations}>
  {#snippet lead()}
    Three layers: the <strong>OpenDisplay</strong> spec, the <strong>Flex</strong> configuration extension for
    reference firmware, and optional <strong>Flex tools</strong>.
  {/snippet}
  {#snippet intro()}
    <p>
      OpenDisplay lets senders (apps, Home Assistant, custom code) push rendered images to e-paper receivers
      over Bluetooth Low Energy and, on some devices, the same command set over Wi‑Fi LAN. The documentation
      is split so manufacturers and sender authors can follow the core spec without wading through
      reference-firmware details.
    </p>
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
        <a href={href.displayDataFormat}>display data format</a> and
        <a href={href.openDisplayLanguage}>OpenDisplay Language</a>.
      </li>
    </ul>
  {/snippet}
</Hub>
