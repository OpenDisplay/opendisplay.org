<script>
  import '#lib/ui/tokens.css';
  import '#lib/ui/base.css';
  import SiteBar from '#lib/ui/SiteBar.svelte';
  import SiteFooter from '#lib/ui/SiteFooter.svelte';

  let { children } = $props();
</script>

<!-- A full-height column: main takes the spare room, so on short pages the footer stays
     at the bottom of the screen instead of floating up into it. -->
<div class="shell">
  <SiteBar />
  <main id="main-content">
    {@render children()}
  </main>
  <SiteFooter />
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    min-height: 100dvh; /* mobile: the visible viewport, not the one behind the URL bar */
  }
  main { flex: 1 0 auto; }
</style>
