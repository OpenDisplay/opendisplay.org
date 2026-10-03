---
title: "Adding New Displays Guide"
lead: "<strong>Flex tool</strong> — for extending <a href=\"/protocol/flex-tools/\">reference firmware</a>, not the core OpenDisplay spec."
---

<script>
  import Callout from '#lib/ui/Callout.svelte';
</script>

## Overview

This guide explains how to add compatibility for new display panels to the open-source reference firmware. You will update the Flex YAML schema, implement panel support in firmware, and add a Toolbox preset so others can flash the configuration in the browser.

<Callout tone="info" label="Need help?">

If you get stuck at any point or need assistance, don't hesitate to ask for help on the [OpenDisplay Discord](https://discord.gg/XmTHz8RfJE). The community is friendly and helpful, and many users have gone through the same process. Whether you're having trouble finding your display, configuring pins, or testing your setup, someone is usually available to help!

</Callout>

## Prerequisites

<Callout tone="warn" label="Supported MCUs only">

This guide is only valid if you are using a **supported microcontroller unit (MCU)**. The OpenDisplay firmware currently supports the following MCUs:

-   **nRF52840** - Nordic Semiconductor nRF52840
-   **ESP32-S3** - Espressif ESP32-S3
-   **ESP32-C3** - Espressif ESP32-C3
-   **ESP32-C6** - Espressif ESP32-C6

If your device uses a different MCU, this guide does not apply. You would need to add MCU support to the firmware first, which is beyond the scope of this guide.

#### Required Knowledge and Resources

-   Access to the OpenDisplay firmware source code
-   Knowledge of the device's pin configuration
-   Display panel specifications (resolution, color scheme, controller IC)
-   Understanding of the OpenDisplay protocol (see [communication protocol](/protocol/ble-flow.html))
-   Familiarity with Flex YAML configuration (see [YAML config reference](/protocol/yaml-config/))

</Callout>

## Step 1: Gather Device Information

### Recommended Approach

**Start with a known good configuration:** The easiest way to configure a new device is to start with an existing preset configuration for a similar board and modify it for your specific hardware. For example, if you're using an ESP32-S3 board, start with the Seeed EE04 or XIAO ESP32-S3 breakout configuration and adjust the pin assignments and display settings.

**Use compatible hardware for testing:** When testing a new display panel, it's highly recommended to use well-supported hardware platforms like the Seeed Studio EE04 (ESP32-S3) or EN04 (nRF52840). These boards are thoroughly tested and have known-good configurations, making it easier to isolate display-specific issues.

#### Required Information

Before starting, collect the following information about your device:

-   **Display Panel:**
    -   Panel model number and manufacturer
    -   Resolution (width × height in pixels)
    -   Physical dimensions (width × height in mm)
    -   Color scheme (B/W, B/W+R, B/W+Y, B/W+R+Y, 6-color, 4-gray)
    -   Controller IC type
-   **Hardware Configuration:**
    -   MCU type (ESP32-S3, ESP32-C3, ESP32-C6, nRF52840)
    -   Pin assignments (reset, busy, DC, CS, data/MOSI, clock/SCK)
    -   SPI bus speed (if applicable)
    -   Power management pins (if any)

## Step 2: Find Your Display in Existing Panels

#### 2.1 Understanding Display Support

The OpenDisplay firmware uses the **bb\_epaper** library for display driver support. This means that the available panel types are determined by what's supported in the bb\_epaper library. Before adding a new panel, you should first check if your display is already supported.

#### 2.2 Check Existing Panel Types

To find if your display is already supported, check the panel enumeration in the YAML configuration file in your local repository:

```
config.yaml
```

Navigate to packet type `32` (display) and look at the `panel_ic_type` field enumeration. This lists all currently supported panels with their:

-   Panel ID number
-   Panel name (e.g., `ep213_122x250`)
-   Description (manufacturer/model information)

#### 2.3 Search Strategies

When searching for your display, look for matches based on:

-   **Resolution:** Match the pixel dimensions (width × height)
-   **Size:** Physical size in inches (e.g., 2.13", 2.9", 4.2")
-   **Color Scheme:** B/W, B/W+R, B/W+Y, B/W+R+Y, 6-color, or 4-gray
-   **Model Number:** Check the description field for your panel's model number (e.g., GDEY042T81, DEPG0420BN)
-   **Controller IC:** Some panels share the same controller IC and may be compatible

#### 2.4 Using Toolbox to Browse

The easiest way to browse available panels is using the [Toolbox](/firmware/toolbox/):

1.  Open the Toolbox tool
2.  Load the YAML schema (it loads automatically)
3.  Add a display packet (Packet Type 32)
4.  Click on the `panel_ic_type` dropdown
5.  Browse through all available panel options with their descriptions

The dropdown shows all supported panels in a searchable format, making it easy to find your display.

#### 2.5 If Your Display is Not Listed

If you cannot find your display in the existing list, it means:

-   The panel may not be supported by the bb\_epaper library yet
-   You may need to add support to bb\_epaper first
-   Or find a compatible panel that uses the same controller IC

In this case, you'll need to:

1.  Check if bb\_epaper supports your panel (check the bb\_epaper library documentation or source code)
2.  If supported in bb\_epaper but not in OpenDisplay, proceed to add it to the YAML config (see Step 3)
3.  If not supported in bb\_epaper, you'll need to add support there first, or use a compatible alternative panel

<Callout tone="info" label="Tip">

Many displays share the same controller IC (like UC8151, SSD1680, etc.) and may be compatible with existing panel types even if the exact model isn't listed. Check the controller IC in your panel's datasheet and look for panels using the same controller.

</Callout>

<Callout tone="warn" label="Important">

OpenDisplay firmware support is limited to what's available in the **bb\_epaper** library. If a panel isn't supported by bb\_epaper, it cannot be added to OpenDisplay without first adding support to the underlying library.

</Callout>

### Recommended Testing Hardware

When testing a new display panel, it's highly recommended to use well-supported hardware platforms:

-   **Seeed Studio EE04** (ESP32-S3) - Excellent for testing ESP32-based configurations
-   **Seeed Studio EN04** (nRF52840) - Ideal for testing nRF52840-based configurations
-   **Seeed XIAO breakout boards** - Good for testing various MCU platforms

These boards have thoroughly tested configurations and pin assignments, making it easier to isolate display-specific issues. If you encounter problems, you can quickly verify whether the issue is with the display panel or your custom hardware configuration.

## Step 3: Add Panel Type to YAML Config (If Not Found)

#### 3.1 When This Step is Needed

Only proceed with this step if:

-   Your display is **not** found in the existing panel list (Step 2)
-   The panel is supported by **bb\_epaper** library but not yet added to OpenDisplay
-   You've confirmed the panel constant exists in bb\_epaper

If you found your display in Step 2, skip to Step 4 (Create Preset Configuration).

#### 3.2 Verify bb\_epaper Support

Before adding a panel to OpenDisplay, verify it's supported in the bb\_epaper library:

-   Check the bb\_epaper library documentation or source code
-   Look for the panel constant (e.g., `EP_NEW_200x200`)
-   Ensure the panel initialization and refresh sequences are implemented

If the panel is not supported in bb\_epaper, you must add support there first before proceeding.

#### 3.3 Add Panel to YAML Config

In your local repository, edit the config file at `config.yaml`. Navigate to packet type `32` (display) and find the `panel_ic_type` enum. Add your new panel entry:

```
- name: panel_ic_type
  size: 2
  description: Display controller / panel type
  enum:
    # ... existing entries ...
    64:  # Next available number
      name: ep_new_200x200
      description: New Panel Model 200x200
```

**Naming Convention:** Use descriptive names like `ep[size][color][variant]` (e.g., `ep213r_122x250` for 2.13" red/black panel).

#### 3.4 Add Panel Mapping in Firmware

In the firmware source code (`src/main.cpp`), find the `mapEpd()` function and add your panel mapping:

```
int mapEpd(uint16_t panelType) {
    switch(panelType) {
        case 0x0001: return EP42_400x300;
        case 0x0002: return EP42B_400x300;
        // ... existing cases ...
        case 0x0040: return EP_NEW_200x200;  // Your new panel (64 decimal = 0x0040 hex)
        default: return EP_PANEL_UNDEFINED;
    }
}
```

The panel constant (e.g., `EP_NEW_200x200`) must match the constant defined in the bb\_epaper library.

<Callout tone="warn" label="Important">

The panel type ID in the YAML config (e.g., 64) must match the case value in the firmware mapping function (e.g., 0x0040). The firmware uses hexadecimal values, so decimal 64 = 0x0040. Also ensure the panel constant matches what's defined in bb\_epaper.

</Callout>

## Step 4: Create Preset Configuration

#### 4.1 Start with a Known Good Config

**Best Practice:** Instead of creating a configuration from scratch, start with an existing preset configuration for a similar board. This ensures you have all required fields properly configured.

1.  Open the [Toolbox](/firmware/toolbox/) tool
2.  Load the YAML schema (it loads automatically)
3.  Select a compatible preset from the dropdown:
    -   For ESP32-S3 boards: Use "Seeed EE04 ESP 4.26" or "Seeed XIAO ESP32-S3 breakout 4.26"
    -   For nRF52840 boards: Use "Seeed EN04 NRF 4.26" or "Seeed XIAO NRF52840 breakout 4.26"
    -   For ESP32-C3/C6 boards: Use the corresponding XIAO breakout presets
4.  Click "Read Config" or import the preset JSON file
5.  Modify the configuration for your specific hardware:
    -   Update pin assignments to match your board
    -   Adjust display settings (panel type, dimensions, color scheme)
    -   Update power settings if different
    -   Modify manufacturer/board information if needed

This approach is much faster and less error-prone than building a config from scratch.

#### 4.2 Manual Configuration (Alternative)

If you prefer to configure manually or no similar preset exists, you can build the configuration from scratch:

1.  Add required packets:
    -   Packet Type 1: system\_config (IC type, communication modes)
    -   Packet Type 2: manufacturer\_data (manufacturer, board type)
    -   Packet Type 4: power\_option (power mode, battery, sleep settings)
2.  Add display packet (Packet Type 32):
    -   Set panel\_ic\_type to your panel ID (from Step 2 or 3)
    -   Configure pixel dimensions
    -   Set physical dimensions in mm
    -   Configure color scheme
    -   Set all pin assignments
    -   Configure rotation if needed
    -   Set `partial_update_support` (`1` = region partial, `2` = full-frame partial stream) if the panel supports 1 bpp differential refresh — wire protocol: [partial update](/protocol/ble-flow.html#partial-update)
3.  Add any optional packets (LEDs, sensors, buttons, etc.)

#### 4.2 Export Configuration

Once configured, export the configuration as JSON using the export action in the [Toolbox](/firmware/toolbox/).

#### 4.3 Save Preset File (Optional)

If you're contributing your configuration back to the project, save the exported JSON file to the presets directory in your local repository:

```
web/firmware/toolbox/presets/[device-name].json
```

Use a descriptive filename that includes the MCU type and board name, e.g.:

-   `esp32-s3-custom-board.json`
-   `nrf52840-diy-panel.json`

<Callout>

You can use the configuration locally without saving it to the presets directory. The preset file is only needed if you want to contribute it to the project.

</Callout>

## Step 5: Pin Configuration Reference

| Field | Description | Notes |
| --- | --- | --- |
| `reset_pin` | Panel reset pin | Use `0xFF` if not present |
| `busy_pin` | Panel busy status pin | Use `0xFF` if not present |
| `dc_pin` | Data/Command select pin | Use `0xFF` if not present |
| `cs_pin` | SPI chip select pin | Use `0xFF` if not present |
| `data_pin` | Data out pin (MOSI) | Required for SPI communication |
| `clk_pin` | Clock pin (SCK) | Required for SPI communication |

## Step 6: Testing Your Implementation

#### 6.1 Build and Flash Firmware

<Callout>

This step is only necessary if you completed Step 3 (added a new panel type to the YAML config and firmware). If you found your display in the existing panel list (Step 2) and only created a configuration (Step 4), you can skip compilation and proceed directly to loading your configuration (Step 6.2).

</Callout>

If you did modify the firmware (Step 3), compile the firmware with your changes and flash it to your device using the [Web Installer](/firmware/toolbox/).

#### 6.2 Load Configuration

Use the Toolbox to:

1.  Load your preset configuration
2.  Connect to your device via BLE
3.  Write the configuration to the device
4.  Reboot the device

#### 6.3 Test Display

Use the [BLE Tester](/firmware/display/) to:

-   Upload a test image
-   Verify the display shows the image correctly
-   Check that colors render properly (if color display)
-   Test partial refresh (if supported)
-   Verify rotation settings

#### 6.4 Verify Configuration

Read back the configuration from the device to ensure it was stored correctly:

1.  Connect to device via BLE
2.  Click "Read Config" in Toolbox
3.  Verify all values match your preset

## Step 7: Common Issues and Solutions

<Callout tone="info" label="Still having issues?">

If you're encountering problems not covered here, or if the solutions below don't work, please ask for help on the [OpenDisplay Discord](https://discord.gg/XmTHz8RfJE). Include details about your hardware, configuration, and what you've already tried. The community can often help troubleshoot specific issues.

#### Display Not Initializing

-   Verify pin assignments are correct
-   Check SPI bus speed (try lower speeds if issues occur)
-   Ensure power management is configured correctly
-   Verify panel type ID matches between YAML and firmware

#### Wrong Colors or Display Artifacts

-   Verify color\_scheme matches the actual panel
-   Check rotation settings
-   Ensure pixel dimensions are correct
-   Verify the panel driver supports your color mode

#### Configuration Not Saving

-   Check CRC validation (Toolbox shows CRC info)
-   Ensure packet size doesn't exceed 4kB limit
-   Verify all required packets are present
-   Check for firmware errors in serial output

</Callout>

## Step 8: Share Your Findings

#### Share on Discord

If you successfully get a new display working, please share your findings and configuration on the [OpenDisplay Discord](https://discord.gg/XmTHz8RfJE). Include:

-   Panel model and specifications
-   Your configuration details (you can export and share the JSON config)
-   Any issues you encountered and how you solved them
-   Test results
-   bb\_epaper panel constant used (if you added a new panel)

Sharing your working configuration helps other users with the same display and allows the community to integrate it into the main project if desired.

## Step 9: Power Consumption Verification

#### 9.1 Recommended: Measure Power Consumption

To provide accurate power consumption data for your device configuration, it's recommended to use a Nordic Power Profiler Kit II (PPK2) or similar power measurement tool. This helps the community understand the power characteristics of different configurations and enables accurate battery life calculations.

#### 9.2 Measure Deep Sleep Current

Measure the deep sleep current consumption when the device is in deep sleep mode. This value should be added to the `deep_sleep_current_ua` field in the power\_option packet (Packet Type 4). The value should be in microamperes (µA).

#### 9.3 Measure Display Update Charge

Measure the total charge consumed for a complete display update. This is the energy consumed during the entire update process, from start to finish. The value should be added to the `full_update_mC` field in the display packet (Packet Type 32). The value should be in millicoulombs (mC).

To measure this, use the PPK2 to capture the charge consumed during a single display update cycle. Make sure to measure the complete update process including any initialization, data transfer, and refresh operations. The PPK2 can measure the total charge (in mC) consumed during the update.

#### 9.4 Share Power Consumption Data

Include your power consumption measurements when sharing your configuration on Discord (Step 8). This information is valuable for:

-   Battery life calculations
-   Power optimization recommendations
-   Comparing different hardware configurations
-   Documenting device power characteristics

## Example: Adding a New Panel

#### Scenario

Adding support for a new 2.9" B/W/R panel with resolution 128×296:

#### YAML Config Addition

```
# In config.yaml, packet type 32, panel_ic_type enum:
64:
  name: ep29r_custom_128x296
  description: Custom 2.9" B/W/R Panel 128x296
```

#### Firmware Mapping Addition

```
// In src/main.cpp, mapEpd() function:
case 0x0040: return EP29R_CUSTOM_128x296;  // 64 decimal = 0x0040 hex
```

#### Preset Configuration

```
{
  "version": 1,
  "packets": [
    {
      "id": "0x01",
      "name": "system_config",
      "fields": {
        "ic_type": "0x2",  // ESP32-S3
        "communication_modes": "0x1",  // BLE
        "device_flags": "0x0",
        "pwr_pin": "0xFF"
      }
    },
    {
      "id": "0x20",  // Display packet
      "name": "display",
      "fields": {
        "instance_number": "0x0",
        "display_technology": "0x1",  // e-paper
        "panel_ic_type": "0x40",  // Your new panel
        "pixel_width": "0x80",  // 128
        "pixel_height": "0x128",  // 296
        "color_scheme": "0x1",  // B/W/R
        "reset_pin": "0x6",
        "busy_pin": "0x7",
        "dc_pin": "0x8",
        "cs_pin": "0x9",
        "data_pin": "0xA",
        "clk_pin": "0xB"
      }
    }
  ]
}
```

## Additional Resources

-   [BLE Protocol Flow](/protocol/ble-flow.html) - Understand the communication protocol
-   [YAML Config Documentation](/protocol/yaml-config/) - Detailed schema reference
-   [GitHub Repository](https://github.com/OpenDisplay/) - Source code and issues
-   [Toolbox](/firmware/toolbox/) - Interactive configuration tool
-   [BLE Tester](/firmware/display/) - Test display functionality
