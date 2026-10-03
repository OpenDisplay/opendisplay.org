---
title: "Reusing Solum displays"
---

<script>
  import Badge from '#lib/ui/Badge.svelte';
  import Swatch from '#lib/ui/Swatch.svelte';
</script>

## Overview

OpenDisplay can replace the factory firmware on some Solum M3 e-paper tags. Images and settings are sent over Bluetooth Low Energy from your phone, PC, or home automation stack. The firmware and web Toolbox are free to use.

Use the [Firmware Toolbox](/firmware/toolbox/) to flash and configure a tag, and the [Home Assistant integration](https://github.com/OpenDisplay/Home_Assistant_Integration) for automations (via BLE proxies such as ESPHome). The table below lists panels the community has tested on Nordic nRF52811 and Silicon Labs EFR32BG22 hardware, with FCC IDs and Toolbox preset links where available.

OpenDisplay is an independent community project, not affiliated with Solum or other hardware vendors. Model names are used only to describe hardware people have tried.

Replacing factory firmware may void your warranty, brick the device, or cause data loss. There is often no reliable way to restore the original image once it has been overwritten. You are responsible for deciding whether to flash third-party firmware.

Hardware can differ between batches even when the label matches a table entry. A row marked compatible or work in progress reflects community experience, not a guarantee for your unit.

## Prebuild panels (M3)

| Name | FCC ID | Colors | Firmware |
| --- | --- | --- | --- |
| M3 NRF · nRF52811 |
| 1.3" EL013H2WRD | 2AFWN-EL013H2WRD | <Swatch scheme={1} /> | <Badge tone="warn">Work in progress</Badge> |
| 2.2" EL022H3WRA | 2AFWN-EL022H3WRA | <Swatch scheme={1} /> | <Badge tone="warn">Work in progress</Badge> |
| 2.2" EL022H4WRC | 2AFWN-EL016H4WRC | <Swatch scheme={1} /> | <Badge tone="warn">Work in progress</Badge> |
| [2.7" EL027H3BRA](/firmware/toolbox/index.html?driver=m3-nrf&display=uc8151-027-bwr&power=battery-prim-2p) | 2AFWN-EL029H3WRA | <Swatch scheme={1} /> | <Badge tone="ok">Compatible</Badge> |
| [2.9" EL029H3WRA](/firmware/toolbox/index.html?driver=m3-nrf&display=uc8151-029-bwr&power=battery-prim-2p) | 2AFWN-EL029H3WRA | <Swatch scheme={1} /> | <Badge tone="ok">Compatible</Badge> |
| M3 Silabs · EFR32BG22C222F352GM40 |
| 1.6" BWRY EL016F5C4C | — | <Swatch scheme={3} /> | <Badge tone="warn">Work in progress</Badge> |
| [1.6" BWRY EL016F6W4A](/firmware/toolbox/index.html?driver=m3-pro-silabs&display=ep154yr-200x200&power=battery-prim-1p) | 2AFWN-EL016F6W4A | <Swatch scheme={3} /> | <Badge tone="ok">Compatible</Badge> |
| [2.2" BWRY EL022F6W4A](/firmware/toolbox/index.html?driver=m3-pro-silabs&display=ep215yr-160x296&power=battery-prim-2p) | 2AFWN-EL022F6W4A | <Swatch scheme={3} /> | <Badge tone="ok">Compatible</Badge> |
| [2.6" BWRY EL026F6W4A](/firmware/toolbox/index.html?driver=m3-pro-silabs&display=ep266yr-184x360&power=battery-prim-2p) | 2AFWN-EL026F6W4A | <Swatch scheme={3} /> | <Badge tone="ok">Compatible</Badge> |
| 2.9" BW Freezer EL029F3WRA | — | <Swatch scheme={0} /> | <Badge tone="warn">Work in progress</Badge> |
| 2.9" BWRY EL029F5C4C | — | <Swatch scheme={3} /> | <Badge tone="warn">Work in progress</Badge> |
| [3.5" BWRY EL035F5C4C](/firmware/toolbox/index.html?driver=m3-core-silabs&display=ep35yr-184x384&power=battery-prim-2p) | 2AFWN-EL035F5C4C | <Swatch scheme={3} /> | <Badge tone="ok">Compatible</Badge> |
| 4.2" BWRY EL042F6W4A | — | <Swatch scheme={3} /> | <Badge tone="warn">Work in progress</Badge> |
| 4.3" BWRY EL043F5C4C | — | <Swatch scheme={3} /> | <Badge tone="warn">Work in progress</Badge> |
| 7.5" BWRY EL075F5CRC | — | <Swatch scheme={3} /> | <Badge tone="warn">Work in progress</Badge> |
| 11.6" BWRY EL116F5CRC | — | <Swatch scheme={3} /> | <Badge tone="warn">Work in progress</Badge> |

## Flashing

Build and flash instructions for each MCU port (toolchain, SWD wiring, unlock steps) are in the [OpenDisplay firmware repository](https://github.com/OpenDisplay/). After programming, open the [Toolbox](/firmware/toolbox/) to configure the device. If your panel has a preset link in the table, use it after flashing so driver, panel, and power settings match your hardware.

A genuine Segger J-Link is strongly recommended; many clones are unreliable. To unlock the MCU for a full erase and reflash you typically need J-Link hardware version 9 (V9) or newer.
