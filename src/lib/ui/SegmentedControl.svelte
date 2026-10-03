<!-- Pick one of a few options (presets, modes). Radio buttons underneath, so arrow keys work. -->
<script>
  /** @type {{ options: { value: string, label: string }[], value?: string, label: string, name?: string }} */
  let { options, value = $bindable(), label, name } = $props();
  const uid = $props.id();
  const group = $derived(name ?? uid);
</script>

<div class="segmented" role="radiogroup" aria-label={label}>
  {#each options as option (option.value)}
    <label class:selected={value === option.value}>
      <input type="radio" name={group} value={option.value} bind:group={value} class="sr-only">
      {option.label}
    </label>
  {/each}
</div>

<style>
  .segmented {
    display: inline-flex;
    width: fit-content;
    flex-wrap: wrap;
    gap: var(--sp-1);
    padding: var(--sp-1);
    background: var(--bg-sunken);
    border-radius: var(--r-md);
  }
  label {
    padding: var(--sp-2) var(--sp-3);
    border-radius: var(--r-sm);
    font-size: var(--fs-2);
    font-weight: 500;
    color: var(--text-muted);
    cursor: pointer;
    transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
  }
  label:hover { color: var(--text); }
  .selected { background: var(--bg-raised); color: var(--text); box-shadow: 0 1px 2px color-mix(in oklab, var(--text) 10%, transparent); }
  label:has(:focus-visible) { box-shadow: var(--shadow-focus); }
</style>
