<script>
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import Page from '#lib/ui/Page.svelte';
  import Prose from '#lib/ui/Prose.svelte';
  import { href } from '#lib/paths.js';
</script>

<svelte:head>
  <title>Flex tools · OpenDisplay</title>
</svelte:head>

<Page title="Flex tools" width="prose">
  {#snippet lead()}For <strong>reference firmware</strong> and
    <a href={href.flexStandard}>OpenDisplay Flex</a> configuration — not required for the core OpenDisplay spec.{/snippet}

  <Card>
    <Prose>
      <h2>Overview</h2>
      <p>
        These browser tools work with the open-source reference firmware on ESP32 and nRF development boards.
        They compile and flash <strong>Flex</strong> configuration presets so one firmware binary can drive many
        different panels and pinouts.
      </p>
      <p>
        If you are implementing OpenDisplay on a fixed product or writing a sender application, start with the
        <a href={href.basicStandard}>OpenDisplay spec</a> instead. You do not need Flex tools unless you are building
        or extending reference firmware.
      </p>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2>Toolbox <Badge tone="info">Flex</Badge></h2>
      <p>
        Flash reference firmware over USB (Web Serial), pick a board and panel preset, tune power and
        encryption settings, and write the Flex configuration blob to the device. The main entry point for DIY
        builds.
      </p>
      <Button href={href.toolbox}>Open the Toolbox</Button>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2>Adding a new panel <Badge tone="info">Flex</Badge></h2>
      <p>
        Developer guide for adding a new e-paper panel to reference firmware: controller support, Flex YAML
        preset, Toolbox integration, and power measurement.
      </p>
      <Button href={href.addingDisplays}>Read the guide</Button>
    </Prose>
  </Card>

  <Card>
    <Prose>
      <h2>Related documentation</h2>
      <p>
        <a href={href.flexStandard}>OpenDisplay Flex</a> — what the configuration extension is and which
        packet types reference firmware supports.<br />
        <a href={href.yamlConfig}>YAML configuration reference</a> — full schema used by the Toolbox.<br />
        <a href={href.bleFlow}>Communication protocol</a> — OpenDisplay commands (shared with all implementations).
      </p>
    </Prose>
  </Card>
</Page>
