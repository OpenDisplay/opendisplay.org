<!-- A highlighted note inside content. tone: info, warn, error, ok.
     A tinted box with a thin border all round and a short bold label, so the meaning
     doesn't rest on color alone. No accent bar on one side. -->
<script>
  /** @type {{ tone?: 'info' | 'warn' | 'error' | 'ok', label?: string | null, children: import('svelte').Snippet }} */
  let { tone = 'info', label, children } = $props();
  const DEFAULT_LABELS = { info: 'Note', warn: 'Warning', error: 'Error', ok: 'Done' };
  const shown = $derived(label === undefined ? DEFAULT_LABELS[tone] : label);
</script>

<div class="callout {tone}" role={tone === 'error' ? 'alert' : undefined}>
  {#if shown}<strong class="label">{shown}</strong>{/if}
  {@render children()}
</div>

<style>
  .callout {
    --tone: var(--blue);
    padding: var(--sp-3) var(--sp-4);
    border: 1px solid color-mix(in oklab, var(--tone) 35%, var(--bg));
    border-radius: var(--r-md);
    background: color-mix(in oklab, var(--tone) 7%, var(--bg));
    font-size: var(--fs-2);
  }
  .label {
    margin-right: var(--sp-1);
    color: color-mix(in oklab, var(--tone) 65%, var(--text));
  }
  .warn {
    --tone: var(--warn);
  }
  .error {
    --tone: var(--error);
  }
  .ok {
    --tone: var(--ok);
  }
  .callout :global(p) {
    display: inline;
  }
  .callout :global(p + p) {
    display: block;
    margin-top: var(--sp-2);
  }
</style>
