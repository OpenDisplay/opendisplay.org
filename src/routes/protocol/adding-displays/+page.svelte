<script>
  import Card from '#lib/ui/Card.svelte';
  import Page from '#lib/ui/Page.svelte';
  import Prose from '#lib/ui/Prose.svelte';
  import { href } from '#lib/paths.js';
</script>

<svelte:head>
  <title>Adding New Displays Guide · OpenDisplay</title>
</svelte:head>

<Page title="Adding New Displays Guide" toc>
  {#snippet lead()}<strong>Flex tool</strong> — for extending <a href={href.flexTools}>reference firmware</a>,
    not the core OpenDisplay spec.{/snippet}

  <Card>
    <Prose>
      <h2 id="overview">Overview</h2>
      <p>
        This guide explains how to add compatibility for new display panels to the open-source reference
        firmware. You will update the Flex YAML schema, implement panel support in firmware, and add a Toolbox
        preset so others can flash the configuration in the browser.
      </p>

      <h3>Need Help?</h3>
      <p>
        If you get stuck at any point or need assistance, don't hesitate to ask for help on the <a
          href="https://discord.gg/XmTHz8RfJE"
          target="_blank"
          rel="noreferrer">OpenDisplay Discord</a
        >. The community is friendly and helpful, and many users have gone through the same process. Whether
        you're having trouble finding your display, configuring pins, or testing your setup, someone is
        usually available to help!
      </p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="prerequisites">Prerequisites</h2>

      <h3>⚠️ Supported MCUs Only</h3>
      <p>
        This guide is only valid if you are using a <strong>supported microcontroller unit (MCU)</strong>. The
        OpenDisplay firmware currently supports the following MCUs:
      </p>
      <ul>
        <li><strong>nRF52840</strong> - Nordic Semiconductor nRF52840</li>
        <li><strong>ESP32-S3</strong> - Espressif ESP32-S3</li>
        <li><strong>ESP32-C3</strong> - Espressif ESP32-C3</li>
        <li><strong>ESP32-C6</strong> - Espressif ESP32-C6</li>
      </ul>
      <p>
        If your device uses a different MCU, this guide does not apply. You would need to add MCU support to
        the firmware first, which is beyond the scope of this guide.
      </p>

      <h4>Required Knowledge and Resources</h4>
      <ul>
        <li>Access to the OpenDisplay firmware source code</li>
        <li>Knowledge of the device's pin configuration</li>
        <li>Display panel specifications (resolution, color scheme, controller IC)</li>
        <li>
          Understanding of the OpenDisplay protocol (see <a href={href.bleFlow}>communication protocol</a>)
        </li>
        <li>
          Familiarity with Flex YAML configuration (see <a href={href.yamlConfig}>YAML config reference</a>)
        </li>
      </ul>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="step-1-gather-device-information">Step 1: Gather Device Information</h2>

      <h3>Recommended Approach</h3>
      <p>
        <strong>Start with a known good configuration:</strong> The easiest way to configure a new device is to
        start with an existing preset configuration for a similar board and modify it for your specific hardware.
        For example, if you're using an ESP32-S3 board, start with the Seeed EE04 or XIAO ESP32-S3 breakout configuration
        and adjust the pin assignments and display settings.
      </p>
      <p>
        <strong>Use compatible hardware for testing:</strong> When testing a new display panel, it's highly recommended
        to use well-supported hardware platforms like the Seeed Studio EE04 (ESP32-S3) or EN04 (nRF52840). These
        boards are thoroughly tested and have known-good configurations, making it easier to isolate display-specific
        issues.
      </p>

      <h4>Required Information</h4>
      <p>Before starting, collect the following information about your device:</p>
      <ul>
        <li>
          <strong>Display Panel:</strong>
          <ul>
            <li>Panel model number and manufacturer</li>
            <li>Resolution (width × height in pixels)</li>
            <li>Physical dimensions (width × height in mm)</li>
            <li>Color scheme (B/W, B/W+R, B/W+Y, B/W+R+Y, 6-color, 4-gray)</li>
            <li>Controller IC type</li>
          </ul>
        </li>
        <li>
          <strong>Hardware Configuration:</strong>
          <ul>
            <li>MCU type (ESP32-S3, ESP32-C3, ESP32-C6, nRF52840)</li>
            <li>Pin assignments (reset, busy, DC, CS, data/MOSI, clock/SCK)</li>
            <li>SPI bus speed (if applicable)</li>
            <li>Power management pins (if any)</li>
          </ul>
        </li>
      </ul>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="step-2-find-your-display-in-existing-panels">Step 2: Find Your Display in Existing Panels</h2>

      <h4>2.1 Understanding Display Support</h4>
      <p>
        The OpenDisplay firmware uses the <strong>bb_epaper</strong> library for display driver support. This means
        that the available panel types are determined by what's supported in the bb_epaper library. Before adding
        a new panel, you should first check if your display is already supported.
      </p>

      <h4>2.2 Check Existing Panel Types</h4>
      <p>
        To find if your display is already supported, check the panel enumeration in the YAML configuration
        file in your local repository:
      </p>
      <pre><code>config.yaml</code></pre>
      <p>
        Navigate to packet type <code>32</code> (display) and look at the <code>panel_ic_type</code> field enumeration.
        This lists all currently supported panels with their:
      </p>
      <ul>
        <li>Panel ID number</li>
        <li>Panel name (e.g., <code>ep213_122x250</code>)</li>
        <li>Description (manufacturer/model information)</li>
      </ul>

      <h4>2.3 Search Strategies</h4>
      <p>When searching for your display, look for matches based on:</p>
      <ul>
        <li><strong>Resolution:</strong> Match the pixel dimensions (width × height)</li>
        <li><strong>Size:</strong> Physical size in inches (e.g., 2.13", 2.9", 4.2")</li>
        <li><strong>Color Scheme:</strong> B/W, B/W+R, B/W+Y, B/W+R+Y, 6-color, or 4-gray</li>
        <li>
          <strong>Model Number:</strong> Check the description field for your panel's model number (e.g., GDEY042T81,
          DEPG0420BN)
        </li>
        <li>
          <strong>Controller IC:</strong> Some panels share the same controller IC and may be compatible
        </li>
      </ul>

      <h4>2.4 Using Toolbox to Browse</h4>
      <p>
        The easiest way to browse available panels is using the <a
          href={href.toolbox}
          target="_blank"
          rel="noreferrer">Toolbox</a
        >:
      </p>
      <ol>
        <li>Open the Toolbox tool</li>
        <li>Load the YAML schema (it loads automatically)</li>
        <li>Add a display packet (Packet Type 32)</li>
        <li>Click on the <code>panel_ic_type</code> dropdown</li>
        <li>Browse through all available panel options with their descriptions</li>
      </ol>
      <p>
        The dropdown shows all supported panels in a searchable format, making it easy to find your display.
      </p>

      <h4>2.5 If Your Display is Not Listed</h4>
      <p>If you cannot find your display in the existing list, it means:</p>
      <ul>
        <li>The panel may not be supported by the bb_epaper library yet</li>
        <li>You may need to add support to bb_epaper first</li>
        <li>Or find a compatible panel that uses the same controller IC</li>
      </ul>
      <p>In this case, you'll need to:</p>
      <ol>
        <li>
          Check if bb_epaper supports your panel (check the bb_epaper library documentation or source code)
        </li>
        <li>
          If supported in bb_epaper but not in OpenDisplay, proceed to add it to the YAML config (see Step 3)
        </li>
        <li>
          If not supported in bb_epaper, you'll need to add support there first, or use a compatible
          alternative panel
        </li>
      </ol>

      <h3>Tip</h3>
      <p>
        Many displays share the same controller IC (like UC8151, SSD1680, etc.) and may be compatible with
        existing panel types even if the exact model isn't listed. Check the controller IC in your panel's
        datasheet and look for panels using the same controller.
      </p>

      <h3>⚠️ Important</h3>
      <p>
        OpenDisplay firmware support is limited to what's available in the <strong>bb_epaper</strong> library. If
        a panel isn't supported by bb_epaper, it cannot be added to OpenDisplay without first adding support to
        the underlying library.
      </p>

      <h3>Recommended Testing Hardware</h3>
      <p>
        When testing a new display panel, it's highly recommended to use well-supported hardware platforms:
      </p>
      <ul>
        <li>
          <strong>Seeed Studio EE04</strong> (ESP32-S3) - Excellent for testing ESP32-based configurations
        </li>
        <li>
          <strong>Seeed Studio EN04</strong> (nRF52840) - Ideal for testing nRF52840-based configurations
        </li>
        <li><strong>Seeed XIAO breakout boards</strong> - Good for testing various MCU platforms</li>
      </ul>
      <p>
        These boards have thoroughly tested configurations and pin assignments, making it easier to isolate
        display-specific issues. If you encounter problems, you can quickly verify whether the issue is with
        the display panel or your custom hardware configuration.
      </p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="step-3-add-panel-type-to-yaml-config-if-not-found">
        Step 3: Add Panel Type to YAML Config (If Not Found)
      </h2>

      <h4>3.1 When This Step is Needed</h4>
      <p>Only proceed with this step if:</p>
      <ul>
        <li>Your display is <strong>not</strong> found in the existing panel list (Step 2)</li>
        <li>The panel is supported by <strong>bb_epaper</strong> library but not yet added to OpenDisplay</li>
        <li>You've confirmed the panel constant exists in bb_epaper</li>
      </ul>
      <p>If you found your display in Step 2, skip to Step 4 (Create Preset Configuration).</p>

      <h4>3.2 Verify bb_epaper Support</h4>
      <p>Before adding a panel to OpenDisplay, verify it's supported in the bb_epaper library:</p>
      <ul>
        <li>Check the bb_epaper library documentation or source code</li>
        <li>Look for the panel constant (e.g., <code>EP_NEW_200x200</code>)</li>
        <li>Ensure the panel initialization and refresh sequences are implemented</li>
      </ul>
      <p>If the panel is not supported in bb_epaper, you must add support there first before proceeding.</p>

      <h4>3.3 Add Panel to YAML Config</h4>
      <p>
        In your local repository, edit the config file at <code>config.yaml</code>. Navigate to packet type
        <code>32</code>
        (display) and find the <code>panel_ic_type</code> enum. Add your new panel entry:
      </p>
      <pre><code
          >- name: panel_ic_type
  size: 2
  description: Display controller / panel type
  enum:
    # ... existing entries ...
    64:  # Next available number
      name: ep_new_200x200
      description: New Panel Model 200x200</code
        ></pre>
      <p>
        <strong>Naming Convention:</strong> Use descriptive names like <code>ep[size][color][variant]</code>
        (e.g., <code>ep213r_122x250</code> for 2.13" red/black panel).
      </p>

      <h4>3.4 Add Panel Mapping in Firmware</h4>
      <p>
        In the firmware source code (<code>src/main.cpp</code>), find the <code>mapEpd()</code> function and add
        your panel mapping:
      </p>
      <pre><code
          >int mapEpd(uint16_t panelType) &#123;
    switch(panelType) &#123;
        case 0x0001: return EP42_400x300;
        case 0x0002: return EP42B_400x300;
        // ... existing cases ...
        case 0x0040: return EP_NEW_200x200;  // Your new panel (64 decimal = 0x0040 hex)
        default: return EP_PANEL_UNDEFINED;
    &#125;
&#125;</code
        ></pre>
      <p>
        The panel constant (e.g., <code>EP_NEW_200x200</code>) must match the constant defined in the
        bb_epaper library.
      </p>

      <h3>⚠️ Important</h3>
      <p>
        The panel type ID in the YAML config (e.g., 64) must match the case value in the firmware mapping
        function (e.g., 0x0040). The firmware uses hexadecimal values, so decimal 64 = 0x0040. Also ensure the
        panel constant matches what's defined in bb_epaper.
      </p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="step-4-create-preset-configuration">Step 4: Create Preset Configuration</h2>

      <h4>4.1 Start with a Known Good Config</h4>
      <p>
        <strong>Best Practice:</strong> Instead of creating a configuration from scratch, start with an existing
        preset configuration for a similar board. This ensures you have all required fields properly configured.
      </p>
      <ol>
        <li>Open the <a href={href.toolbox} target="_blank" rel="noreferrer">Toolbox</a> tool</li>
        <li>Load the YAML schema (it loads automatically)</li>
        <li>
          Select a compatible preset from the dropdown:
          <ul>
            <li>For ESP32-S3 boards: Use "Seeed EE04 ESP 4.26" or "Seeed XIAO ESP32-S3 breakout 4.26"</li>
            <li>For nRF52840 boards: Use "Seeed EN04 NRF 4.26" or "Seeed XIAO NRF52840 breakout 4.26"</li>
            <li>For ESP32-C3/C6 boards: Use the corresponding XIAO breakout presets</li>
          </ul>
        </li>
        <li>Click "Read Config" or import the preset JSON file</li>
        <li>
          Modify the configuration for your specific hardware:
          <ul>
            <li>Update pin assignments to match your board</li>
            <li>Adjust display settings (panel type, dimensions, color scheme)</li>
            <li>Update power settings if different</li>
            <li>Modify manufacturer/board information if needed</li>
          </ul>
        </li>
      </ol>
      <p>This approach is much faster and less error-prone than building a config from scratch.</p>

      <h4>4.2 Manual Configuration (Alternative)</h4>
      <p>
        If you prefer to configure manually or no similar preset exists, you can build the configuration from
        scratch:
      </p>
      <ol>
        <li>
          Add required packets:
          <ul>
            <li>Packet Type 1: system_config (IC type, communication modes)</li>
            <li>Packet Type 2: manufacturer_data (manufacturer, board type)</li>
            <li>Packet Type 4: power_option (power mode, battery, sleep settings)</li>
          </ul>
        </li>
        <li>
          Add display packet (Packet Type 32):
          <ul>
            <li>Set panel_ic_type to your panel ID (from Step 2 or 3)</li>
            <li>Configure pixel dimensions</li>
            <li>Set physical dimensions in mm</li>
            <li>Configure color scheme</li>
            <li>Set all pin assignments</li>
            <li>Configure rotation if needed</li>
            <li>
              Set <code>partial_update_support</code> (<code>1</code> = region partial, <code>2</code> =
              full-frame partial stream) if the panel supports 1 bpp differential refresh — wire protocol:
              <a href={href.bleFlow + '#partial-update'}>partial update</a>
            </li>
          </ul>
        </li>
        <li>Add any optional packets (LEDs, sensors, buttons, etc.)</li>
      </ol>

      <h4>4.2 Export Configuration</h4>
      <p>
        Once configured, export the configuration as JSON using the export action in the <a
          href={href.toolbox}>Toolbox</a
        >.
      </p>

      <h4>4.3 Save Preset File (Optional)</h4>
      <p>
        If you're contributing your configuration back to the project, save the exported JSON file to the
        presets directory in your local repository:
      </p>
      <pre><code>web/firmware/toolbox/presets/[device-name].json</code></pre>
      <p>Use a descriptive filename that includes the MCU type and board name, e.g.:</p>
      <ul>
        <li><code>esp32-s3-custom-board.json</code></li>
        <li><code>nrf52840-diy-panel.json</code></li>
      </ul>
      <p>
        <strong>Note:</strong> You can use the configuration locally without saving it to the presets directory.
        The preset file is only needed if you want to contribute it to the project.
      </p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="step-5-pin-configuration-reference">Step 5: Pin Configuration Reference</h2>

      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Description</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>reset_pin</code></td>
            <td>Panel reset pin</td>
            <td>Use <code>0xFF</code> if not present</td>
          </tr>
          <tr>
            <td><code>busy_pin</code></td>
            <td>Panel busy status pin</td>
            <td>Use <code>0xFF</code> if not present</td>
          </tr>
          <tr>
            <td><code>dc_pin</code></td>
            <td>Data/Command select pin</td>
            <td>Use <code>0xFF</code> if not present</td>
          </tr>
          <tr>
            <td><code>cs_pin</code></td>
            <td>SPI chip select pin</td>
            <td>Use <code>0xFF</code> if not present</td>
          </tr>
          <tr>
            <td><code>data_pin</code></td>
            <td>Data out pin (MOSI)</td>
            <td>Required for SPI communication</td>
          </tr>
          <tr>
            <td><code>clk_pin</code></td>
            <td>Clock pin (SCK)</td>
            <td>Required for SPI communication</td>
          </tr>
        </tbody>
      </table>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="step-6-testing-your-implementation">Step 6: Testing Your Implementation</h2>

      <h4>6.1 Build and Flash Firmware</h4>
      <p>
        <strong>Note:</strong> This step is only necessary if you completed Step 3 (added a new panel type to the
        YAML config and firmware). If you found your display in the existing panel list (Step 2) and only created
        a configuration (Step 4), you can skip compilation and proceed directly to loading your configuration (Step
        6.2).
      </p>
      <p>
        If you did modify the firmware (Step 3), compile the firmware with your changes and flash it to your
        device using the <a href={href.toolbox} target="_blank" rel="noreferrer">Web Installer</a>.
      </p>

      <h4>6.2 Load Configuration</h4>
      <p>Use the Toolbox to:</p>
      <ol>
        <li>Load your preset configuration</li>
        <li>Connect to your device via BLE</li>
        <li>Write the configuration to the device</li>
        <li>Reboot the device</li>
      </ol>

      <h4>6.3 Test Display</h4>
      <p>Use the <a href={href.bleTester} target="_blank" rel="noreferrer">BLE Tester</a> to:</p>
      <ul>
        <li>Upload a test image</li>
        <li>Verify the display shows the image correctly</li>
        <li>Check that colors render properly (if color display)</li>
        <li>Test partial refresh (if supported)</li>
        <li>Verify rotation settings</li>
      </ul>

      <h4>6.4 Verify Configuration</h4>
      <p>Read back the configuration from the device to ensure it was stored correctly:</p>
      <ol>
        <li>Connect to device via BLE</li>
        <li>Click "Read Config" in Toolbox</li>
        <li>Verify all values match your preset</li>
      </ol>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="step-7-common-issues-and-solutions">Step 7: Common Issues and Solutions</h2>

      <h3>Still Having Issues?</h3>
      <p>
        If you're encountering problems not covered here, or if the solutions below don't work, please ask for
        help on the <a href="https://discord.gg/XmTHz8RfJE" target="_blank" rel="noreferrer"
          >OpenDisplay Discord</a
        >. Include details about your hardware, configuration, and what you've already tried. The community
        can often help troubleshoot specific issues.
      </p>

      <h4>Display Not Initializing</h4>
      <ul>
        <li>Verify pin assignments are correct</li>
        <li>Check SPI bus speed (try lower speeds if issues occur)</li>
        <li>Ensure power management is configured correctly</li>
        <li>Verify panel type ID matches between YAML and firmware</li>
      </ul>

      <h4>Wrong Colors or Display Artifacts</h4>
      <ul>
        <li>Verify color_scheme matches the actual panel</li>
        <li>Check rotation settings</li>
        <li>Ensure pixel dimensions are correct</li>
        <li>Verify the panel driver supports your color mode</li>
      </ul>

      <h4>Configuration Not Saving</h4>
      <ul>
        <li>Check CRC validation (Toolbox shows CRC info)</li>
        <li>Ensure packet size doesn't exceed 4kB limit</li>
        <li>Verify all required packets are present</li>
        <li>Check for firmware errors in serial output</li>
      </ul>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="step-8-share-your-findings">Step 8: Share Your Findings</h2>

      <h4>Share on Discord</h4>
      <p>
        If you successfully get a new display working, please share your findings and configuration on the <a
          href="https://discord.gg/XmTHz8RfJE"
          target="_blank"
          rel="noreferrer">OpenDisplay Discord</a
        >. Include:
      </p>
      <ul>
        <li>Panel model and specifications</li>
        <li>Your configuration details (you can export and share the JSON config)</li>
        <li>Any issues you encountered and how you solved them</li>
        <li>Test results</li>
        <li>bb_epaper panel constant used (if you added a new panel)</li>
      </ul>
      <p>
        Sharing your working configuration helps other users with the same display and allows the community to
        integrate it into the main project if desired.
      </p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="step-9-power-consumption-verification">Step 9: Power Consumption Verification</h2>

      <h4>9.1 Recommended: Measure Power Consumption</h4>
      <p>
        To provide accurate power consumption data for your device configuration, it's recommended to use a
        Nordic Power Profiler Kit II (PPK2) or similar power measurement tool. This helps the community
        understand the power characteristics of different configurations and enables accurate battery life
        calculations.
      </p>

      <h4>9.2 Measure Deep Sleep Current</h4>
      <p>
        Measure the deep sleep current consumption when the device is in deep sleep mode. This value should be
        added to the <code>deep_sleep_current_ua</code> field in the power_option packet (Packet Type 4). The value
        should be in microamperes (µA).
      </p>

      <h4>9.3 Measure Display Update Charge</h4>
      <p>
        Measure the total charge consumed for a complete display update. This is the energy consumed during
        the entire update process, from start to finish. The value should be added to the <code
          >full_update_mC</code
        > field in the display packet (Packet Type 32). The value should be in millicoulombs (mC).
      </p>
      <p>
        To measure this, use the PPK2 to capture the charge consumed during a single display update cycle.
        Make sure to measure the complete update process including any initialization, data transfer, and
        refresh operations. The PPK2 can measure the total charge (in mC) consumed during the update.
      </p>

      <h4>9.4 Share Power Consumption Data</h4>
      <p>
        Include your power consumption measurements when sharing your configuration on Discord (Step 8). This
        information is valuable for:
      </p>
      <ul>
        <li>Battery life calculations</li>
        <li>Power optimization recommendations</li>
        <li>Comparing different hardware configurations</li>
        <li>Documenting device power characteristics</li>
      </ul>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="example-adding-a-new-panel">Example: Adding a New Panel</h2>

      <h4>Scenario</h4>
      <p>Adding support for a new 2.9" B/W/R panel with resolution 128×296:</p>

      <h4>YAML Config Addition</h4>
      <pre><code
          ># In config.yaml, packet type 32, panel_ic_type enum:
64:
  name: ep29r_custom_128x296
  description: Custom 2.9" B/W/R Panel 128x296</code
        ></pre>

      <h4>Firmware Mapping Addition</h4>
      <pre><code
          >// In src/main.cpp, mapEpd() function:
case 0x0040: return EP29R_CUSTOM_128x296;  // 64 decimal = 0x0040 hex</code
        ></pre>

      <h4>Preset Configuration</h4>
      <pre><code
          >&#123;
  "version": 1,
  "packets": [
    &#123;
      "id": "0x01",
      "name": "system_config",
      "fields": &#123;
        "ic_type": "0x2",  // ESP32-S3
        "communication_modes": "0x1",  // BLE
        "device_flags": "0x0",
        "pwr_pin": "0xFF"
      &#125;
    &#125;,
    &#123;
      "id": "0x20",  // Display packet
      "name": "display",
      "fields": &#123;
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
      &#125;
    &#125;
  ]
&#125;</code
        ></pre>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2 id="additional-resources">Additional Resources</h2>
      <ul>
        <li><a href={href.bleFlow}>BLE Protocol Flow</a> - Understand the communication protocol</li>
        <li><a href={href.yamlConfig}>YAML Config Documentation</a> - Detailed schema reference</li>
        <li>
          <a href="https://github.com/OpenDisplay/" target="_blank" rel="noreferrer">GitHub Repository</a> - Source
          code and issues
        </li>
        <li>
          <a href={href.toolbox} target="_blank" rel="noreferrer">Toolbox</a> - Interactive configuration tool
        </li>
        <li>
          <a href={href.bleTester} target="_blank" rel="noreferrer">BLE Tester</a> - Test display functionality
        </li>
      </ul>
    </Prose>
  </Card>
</Page>
