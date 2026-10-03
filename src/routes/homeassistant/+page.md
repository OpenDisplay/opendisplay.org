---
title: "Home Assistant"
lead: "OpenDisplay devices work with two Home Assistant integrations: the core integration that ships with Home Assistant, and a custom integration installed through HACS. Both talk to the OpenDisplay firmware over Bluetooth, with no access point needed."
---

## Which one to use

Use the **core integration** if you want to show images from automations and prefer something built into Home Assistant, with nothing extra to install.

Use the **custom integration** if you want to draw content from your Home Assistant data (text, icons, plots, progress bars with live values), use battery-powered tags that deep-sleep, deliver over Wi‑Fi, or control the LED, buzzer and NFC chip.

## Comparison

| | Core integration | Custom integration |
| --- | --- | --- |
| Install | Built in, since Home Assistant 2026.4 | HACS or manual, Home Assistant 2026.7 or newer |
| Discovery | Bluetooth | Bluetooth, or mDNS for devices on Wi‑Fi |
| Delivery | Bluetooth (adapter or ESPHome proxy) | Bluetooth, or over the LAN for Wi‑Fi devices |
| Drawing from Home Assistant data | No | `opendisplay.drawcustom`, with templates (see [OpenDisplay Language](/protocol/open-display-language/)) |
| Sending an image | `opendisplay.upload_image` | `opendisplay.upload_image` |
| LED, buzzer, NFC | No | `activate_led`, `activate_buzzer`, `play_melody`, `write_nfc` |
| Deep-sleeping tags | No queue: the tag must be awake | Content is queued and delivered at the next wake |
| Display content entity | No | Image entity with the last or queued frame |
| Sensors | Connectivity; on Flex devices temperature and battery | Temperature, humidity (SHT40), battery, signal strength, last seen |
| Buttons | Button events | Button and touch events |
| Firmware updates | No | Update entity, flashed over Bluetooth |
| Encryption | AES-128 key, can be read from the QR code on the display | AES-128 key, asked again if it is rejected |

For both: Shelly Bluetooth proxies can't upload images, because they don't support active Bluetooth connections. Use an ESPHome Bluetooth proxy or a local adapter. The core integration's documentation also lists displays with 40-pin or 60-pin connectors (such as 10.3-inch monochrome panels) as unsupported.

## Links

- [Core integration documentation](https://www.home-assistant.io/integrations/opendisplay/) on home-assistant.io
- [Custom integration](https://github.com/OpenDisplay/Home_Assistant_Integration) on GitHub, with installation steps and every `drawcustom` element

Compared on 3 October 2026 from both projects' documentation; check them for changes since.
