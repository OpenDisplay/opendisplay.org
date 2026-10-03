<script>
  import Button from '#lib/ui/Button.svelte';
  import Callout from '#lib/ui/Callout.svelte';
  import Page from '#lib/ui/Page.svelte';
  import ProductGrid from '#lib/ui/ProductGrid.svelte';
  import Prose from '#lib/ui/Prose.svelte';
  import { external, href } from '#lib/paths.js';
  import { bleKits, bleScreens, espKits, espScreens } from './products.js';
</script>

<svelte:head>
  <title>What hardware to buy · OpenDisplay</title>
</svelte:head>

<Page
  title="What hardware to buy"
  lead="BLE-only screens stay awake on battery with Bluetooth always listening — no deep sleep — so you can send a new image whenever you want. ESP32 screens add Wi‑Fi and more flexibility, but use way more power when idle."
  toc
>
  <Prose>
    <h2 id="ble-screens-heading">BLE-only screens — best battery life</h2>
    <ProductGrid products={bleScreens} />
    <h3 id="ble-kits-heading">Kit — pair with a compatible screen</h3>
    <ProductGrid products={bleKits} />

    <h2 id="esp-screens-heading">ESP32 screens</h2>
    <Callout tone="warn" label="Battery life">
      A BLE-only screen is recommended for the best battery life. See <a href="#ble-screens-heading"
        >BLE-only screens</a
      >
      above if runtime on a charge matters more than Wi-Fi.
    </Callout>
    <ProductGrid products={espScreens} />
    <h3 id="esp-kits-heading">Kit — pair with a compatible screen</h3>
    <ProductGrid products={espKits} />

    <h2 id="next-steps-heading">After you buy</h2>
    <p>
      Use the <a href={href.toolbox}>Toolbox</a> to install firmware with the matching preset, try the
      <a href={href.bleTester}>BLE Tester</a> in your browser, and see
      <a href={href.seeedCompatibility}>Seeed panel compatibility</a> if you are mixing your own driver board
      and display. Reusing a retail Solum M3 tag? See
      <a href={href.reusingSolumDisplays}>Solum M3 compatibility and flashing notes</a>.
    </p>

    <h2 id="discord-cta-heading">Join the Discord server</h2>
    <p>Questions about hardware, flashing, or senders? The OpenDisplay community can help.</p>
    <Button variant="secondary" href={external.discord} target="_blank" rel="noreferrer">Join Discord</Button>
  </Prose>
</Page>
