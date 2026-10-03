<script>
  import '#lib/ui/tokens.css';
  import '#lib/ui/base.css';
  import SiteBar from '#lib/ui/SiteBar.svelte';
  import SiteFooter from '#lib/ui/SiteFooter.svelte';

  let { children } = $props();
</script>

<!-- Header and content fill at least one screen, so on short pages the footer starts just
     below the fold instead of showing up in the middle of the page. -->
<div class="screen">
  <SiteBar />
  <main id="main-content">
    {@render children()}
  </main>
</div>
<SiteFooter />

<style>
  .screen {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    min-height: 100dvh; /* mobile: the visible viewport, not the one behind the URL bar */
  }
  main { flex: 1 0 auto; }
</style>
