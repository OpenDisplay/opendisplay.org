<!-- Label + control + hint/error. Put one input, select or textarea in the children;
     Field styles it and wires the label, hint and error to it by id. -->
<script>
  /** @type {{ label: string, id: string, hint?: string, error?: string, children: import('svelte').Snippet }} */
  let { label, id, hint, error, children } = $props();
</script>

<div class="field" class:invalid={!!error}>
  <label for={id}>{label}</label>
  {@render children()}
  {#if error}
    <p class="message error" id="{id}-message" role="alert">{error}</p>
  {:else if hint}
    <p class="message" id="{id}-message">{hint}</p>
  {/if}
</div>

<style>
  .field { display: flex; flex-direction: column; gap: var(--sp-1); }
  .field + :global(.field) { margin-top: var(--sp-4); }
  label { font-size: var(--fs-2); font-weight: 600; }
  .field :global(:is(input, select, textarea)) {
    width: 100%;
    min-height: 44px;
    padding: var(--sp-2) var(--sp-3);
    font: var(--fs-2) / var(--lh-tight) var(--font-sans);
    color: var(--text);
    background: var(--bg-raised);
    border: 1px solid var(--text-faint);
    border-radius: var(--r-sm);
    transition: border-color var(--dur) var(--ease);
  }
  .field :global(textarea) { min-height: 6lh; font-family: var(--font-mono); }
  .field :global(:is(input, select, textarea):hover) { border-color: var(--text-muted); }
  .field :global(:is(input, select, textarea):focus-visible) { border-color: var(--blue); }
  .field :global(::placeholder) { color: var(--text-faint); }
  .invalid :global(:is(input, select, textarea)) { border-color: var(--error); }
  .message { font-size: var(--fs-2); color: var(--text-muted); }
  .message.error { color: var(--error); }
</style>
