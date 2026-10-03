<script>
  import Hub from '#lib/ui/Hub.svelte';
  import { href } from '#lib/paths.js';

  const destinations = [
    {
      title: 'Toolbox',
      text: 'Flash reference firmware over USB (Web Serial), pick a board and panel preset, tune power and encryption settings, and write the Flex configuration blob to the device. The main entry point for DIY builds.',
      action: ['Open the Toolbox', href.toolbox],
    },
    {
      title: 'Adding a new panel',
      text: 'Developer guide for adding a new e-paper panel to reference firmware: controller support, Flex YAML preset, Toolbox integration, and power measurement.',
      action: ['Read the guide', href.addingDisplays],
    },
    {
      title: 'Related documentation',
      text: 'What the configuration extension is and which packet types reference firmware supports, the full schema used by the Toolbox, and the OpenDisplay commands shared with all implementations.',
      links: [
        ['YAML configuration reference', href.yamlConfig],
        ['Communication protocol', href.bleFlow],
      ],
      action: ['OpenDisplay Flex', href.flexStandard],
    },
  ];
</script>

<svelte:head>
  <title>Flex tools · OpenDisplay</title>
</svelte:head>

<Hub title="Flex tools" {destinations}>
  {#snippet lead()}
    For <strong>reference firmware</strong> and <a href={href.flexStandard}>OpenDisplay Flex</a> configuration —
    not required for the core OpenDisplay spec.
  {/snippet}
  {#snippet intro()}
    <p>
      These browser tools work with the open-source reference firmware on ESP32 and nRF development boards.
      They compile and flash <strong>Flex</strong> configuration presets so one firmware binary can drive many different
      panels and pinouts.
    </p>
    <p>
      If you are implementing OpenDisplay on a fixed product or writing a sender application, start with the
      <a href={href.basicStandard}>OpenDisplay spec</a> instead. You do not need Flex tools unless you are building
      or extending reference firmware.
    </p>
  {/snippet}
</Hub>
