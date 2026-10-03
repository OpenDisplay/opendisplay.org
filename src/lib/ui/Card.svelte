<!-- A bordered panel. Optional title (and icon snippet) above the content. -->
<script>
  /** @type {{ title?: string, icon?: import('svelte').Snippet, children: import('svelte').Snippet }} */
  let { title, icon, children } = $props();
</script>

<section class="card">
  {#if title}
    <div class="head">
      {#if icon}<span class="icon" aria-hidden="true">{@render icon()}</span>{/if}
      <h2>{title}</h2>
    </div>
  {/if}
  {@render children()}
</section>

<style>
  .card {
    padding: var(--sp-5);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
  }
  .card + :global(.card) {
    margin-top: var(--sp-4);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin-bottom: var(--sp-4);
  }
  h2 {
    font-size: var(--fs-4);
  }
  .icon {
    display: inline-grid;
    place-items: center;
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: var(--r-sm);
    background: color-mix(in oklab, var(--blue) 12%, transparent);
    color: color-mix(in oklab, var(--blue) 60%, var(--text));
  }
  .icon :global(svg) {
    width: 20px;
    height: 20px;
  }
  @media (max-width: 480px) {
    .card {
      padding: var(--sp-4);
    }
  }
</style>
