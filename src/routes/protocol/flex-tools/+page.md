---
title: "Flex tools"
lead: "For <strong>reference firmware</strong> and <a href=\"/protocol/flex-standard/\">OpenDisplay Flex</a> configuration — not required for the core OpenDisplay spec."
---

<script>
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
</script>

## Overview

These browser tools work with the open-source reference firmware on ESP32 and nRF development boards. They compile and flash **Flex** configuration presets so one firmware binary can drive many different panels and pinouts.

If you are implementing OpenDisplay on a fixed product or writing a sender application, start with the [OpenDisplay spec](/protocol/basic-standard.html) instead. You do not need Flex tools unless you are building or extending reference firmware.

## Toolbox <Badge tone="info">Flex</Badge>

Flash reference firmware over USB (Web Serial), pick a board and panel preset, tune power and encryption settings, and write the Flex configuration blob to the device. The main entry point for DIY builds.

<Button href="/firmware/toolbox/">Open the Toolbox</Button>

## Adding a new panel <Badge tone="info">Flex</Badge>

Developer guide for adding a new e-paper panel to reference firmware: controller support, Flex YAML preset, Toolbox integration, and power measurement.

<Button href="/protocol/adding-displays/">Read the guide</Button>

## Related documentation

[OpenDisplay Flex](/protocol/flex-standard/) — what the configuration extension is and which packet types reference firmware supports.  
[YAML configuration reference](/protocol/yaml-config/) — full schema used by the Toolbox.  
[Communication protocol](/protocol/ble-flow.html) — OpenDisplay commands (shared with all implementations).
