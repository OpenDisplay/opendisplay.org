<script>
  import Callout from '#lib/ui/Callout.svelte';
  import Hub from '#lib/ui/Hub.svelte';
  import { external, href } from '#lib/paths.js';

  const destinations = [
    {
      title: 'Toolbox — Install & Configure',
      text: 'All-in-one toolbox for OpenDisplay firmware management. Install firmware directly to your device through your web browser (supports ESP32-S3, ESP32-C3, ESP32-C6, and nRF52840) and configure device settings in a single workflow. Premade configurations are automatically selected after installation for popular device models (Seeed EN04, EE04, XIAO breakout boards, etc.) and can be applied with a single button click. You can also customize settings including display dimensions, color scheme, and other parameters. This tool supports all Seeed Studio devices and breakout boards and some Waveshare devices.',
      action: ['Open Toolbox', href.toolbox],
    },
    {
      title: 'BLE Tester',
      text: 'Test and upload images to your OpenDisplay device via BLE. Upload images, preview them on a canvas, and send them directly to your e-paper display. Supports various color schemes including monochrome, B/W + Red, B/W + Yellow, and multi-color modes.',
      action: ['BLE Tester', href.bleTester],
    },
    {
      title: 'Battery Life Calculator',
      text: 'Calculate the expected battery life of your e-paper display based on battery capacity, standby current, update energy consumption, and update frequency. Load configuration values directly from BLE devices or preset configurations. Visualize consumption breakdown with interactive charts.',
      action: ['Calculator', href.battery],
    },
    {
      title: 'Home Assistant',
      text: 'This firmware works with both the OpenDisplay core integration that ships with Home Assistant and the custom integration. Unlike AP-based setups, this BLE firmware does not require an access point. It only needs active BLE proxies (such as ESPHome Bluetooth proxies) to communicate with Home Assistant. This makes setup simpler and more flexible, allowing direct communication between your Home Assistant instance and your e-paper displays via Bluetooth Low Energy.',
      links: [['Custom integration on GitHub', external.homeAssistantCustom]],
      action: ['Core integration docs', external.homeAssistant],
    },
    {
      title: 'Adding New Displays Guide',
      text: 'Step-by-step guide on how to add support for new display panels to the OpenDisplay firmware. Learn how to find existing displays, add new panel types, implement firmware support, create preset configurations, test your implementation, and measure power consumption.',
      action: ['View Guide', href.addingDisplays],
    },
    {
      title: 'Seeed Display Compatibility',
      text: 'Check compatibility information for Seeed Studio ePaper displays with OpenDisplay Firmware. View detailed compatibility status, resolution information, partial refresh support, and setup notes for various Seeed Studio display models.',
      action: ['View Compatibility', href.seeedCompatibility],
    },
    {
      title: 'Reusing Solum M3 displays',
      text: 'Notes on running OpenDisplay on Solum M3 retail e-paper tags: which panels are supported or in progress, Toolbox preset links, FCC IDs, and what you need for SWD flashing (including J-Link guidance).',
      action: ['View compatibility', href.reusingSolumDisplays],
    },
  ];
</script>

<svelte:head>
  <title>OpenDisplay Firmware · OpenDisplay</title>
</svelte:head>

<Hub title="OpenDisplay Firmware" {destinations}>
  {#snippet intro()}
    <p>Follow these steps to get your e-paper display up and running:</p>
    <ol>
      <li>
        <strong><a href={href.toolbox}>Install &amp; Configure</a></strong> — Use the Toolbox to flash OpenDisplay
        firmware to your device and configure device settings. Select your device type (ESP32-S3, ESP32-C3, ESP32-C6,
        or nRF52840) and follow the installation instructions. Premade configurations are automatically selected
        after installation for popular device models (Seeed EN04, EE04, XIAO breakout boards, etc.) and can be applied
        with a single button click. You can also customize settings including display dimensions, color scheme,
        and other parameters.
      </li>
      <li>
        <strong><a href={href.bleTester}>Display</a></strong> — Use the BLE Tester to upload images and test your
        display. You can upload images, preview them, and send them directly to your e-paper display.
      </li>
    </ol>
    <Callout tone="warn" label="OpenDisplay Firmware only.">
      These tools are designed specifically for the <strong>OpenDisplay firmware</strong>, not the ATC_BLE
      firmware. If your Bluetooth device name starts with <strong>“ATC”</strong>, use the
      <a
        href="https://atc1441.github.io/ATC_BLE_OEPL_Image_Upload.html"
        target="_blank"
        rel="noopener noreferrer">ATC_BLE Image Upload tool</a
      > instead.
    </Callout>
  {/snippet}
</Hub>
