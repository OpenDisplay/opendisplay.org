---
title: "Protocol Documentation"
lead: "Three layers: the <strong>OpenDisplay</strong> spec, the <strong>Flex</strong> configuration extension for reference firmware, and optional <strong>Flex tools</strong>."
---

<script>
  import Button from '#lib/ui/Button.svelte';
</script>

## Overview

OpenDisplay lets senders (apps, Home Assistant, custom code) push rendered images to e-paper receivers over Bluetooth Low Energy and, on some devices, the same command set over Wi‑Fi LAN. The documentation is split so manufacturers and sender authors can follow the core spec without wading through reference-firmware details.

### Devices & Protocols

-   **Client Devices:** Computers, smartphones, tablets, web browsers, or Home Assistant running client applications. A Python module is available for easy integration.
-   **Display Devices:** E-paper displays that implement the OpenDisplay BLE or OpenDisplay WiFi standard. This includes devices running OpenDisplay firmware on ESP32-S3, ESP32-C3, ESP32-C6, or nRF52840 microcontrollers, as well as other firmware implementations that speak the protocol.
-   **Communication:** BLE GATT (service `0x2446`) plus optional Wi‑Fi LAN on reference firmware — see the [communication protocol](/protocol/ble-flow.html).
-   **Configuration:** Fixed-product implementations use a minimal announcement; reference firmware stores a Flex YAML blob — see [OpenDisplay Flex](/protocol/flex-standard/).
-   **Image format:** Shared pixel encoding — see [display data format](/protocol/display-data-format/) and [OpenDisplay Language](/protocol/open-display-language/).

## 1\. OpenDisplay — the spec

The protocol any sender or product implementation should follow: BLE advertising, configuration read/write, image transfer, encryption, optional LAN transport, display data encoding, and OpenDisplay Language. Start here for manufacturers and client authors.

[OpenDisplay specification](/protocol/basic-standard.html) · [Communication protocol (BLE & LAN)](/protocol/ble-flow.html) · [Firmware variants](/protocol/reference-firmware-variants/) · [Display data format](/protocol/display-data-format/) · [OpenDisplay Language](/protocol/open-display-language/)

<Button href="/protocol/basic-standard.html">Read the spec</Button>

## Reference firmware variants

ESP32/nRF and Silicon Labs BG22 builds share the same GATT commands but differ in partial refresh, NFC, Wi‑Fi/LAN, and compression window support. Use this matrix when writing senders for reference hardware.

<Button href="/protocol/reference-firmware-variants/">View capability matrix</Button>

## 2\. OpenDisplay Flex — configuration extension

A YAML schema compiled to a binary TLV blob. Used by the reference firmware on development boards so one firmware binary can support many panels and pinouts. Flex is *not* a separate wire protocol — clients still use the OpenDisplay commands above.

[Full YAML schema reference](/protocol/yaml-config/)

<Button href="/protocol/flex-standard/">OpenDisplay Flex</Button>

## 3\. Flex tools — reference firmware only

Browser tools for flashing presets and extending reference firmware. Marked separately so spec readers and product integrators are not sent through DIY tooling by default.

[Toolbox](/firmware/toolbox/) · [Adding a new panel](/protocol/adding-displays/)

<Button href="/protocol/flex-tools/">Flex tools overview</Button>
