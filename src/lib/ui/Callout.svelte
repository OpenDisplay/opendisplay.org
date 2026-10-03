<!-- A highlighted note inside content. tone: info, warn, error, ok. -->
<script>
  /** @type {{ tone?: 'info' | 'warn' | 'error' | 'ok', children: import('svelte').Snippet }} */
  let { tone = 'info', children } = $props();
</script>

<div class="callout {tone}" role={tone === 'error' ? 'alert' : undefined}>
  {@render children()}
</div>

<style>
  .callout {
    --tone: var(--blue);
    padding: var(--sp-3) var(--sp-4);
    border-left: 3px solid var(--tone);
    border-radius: 0 var(--r-sm) var(--r-sm) 0;
    background: color-mix(in oklab, var(--tone) 8%, var(--bg));
    font-size: var(--fs-2);
  }
  .warn { --tone: var(--warn); }
  .error { --tone: var(--error); }
  .ok { --tone: var(--ok); }
  .callout :global(p + p) { margin-top: var(--sp-2); }
</style>
