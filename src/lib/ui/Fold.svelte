<!-- A quiet disclosure: a divider line with a summary that opens more content. -->
<script>
  /** @type {{ summary: string, hint?: string, open?: boolean, children: import('svelte').Snippet }} */
  let { summary, hint, open = $bindable(false), children } = $props();
</script>

<details class="fold" bind:open>
  <summary>
    <span>{summary}</span>
    {#if hint}<span class="hint">{hint}</span>{/if}
  </summary>
  <div class="body">{@render children()}</div>
</details>

<style>
  .fold {
    border-top: 1px solid var(--line);
  }
  summary {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: 48px;
    font-weight: 600;
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary::after {
    content: '';
    width: 7px;
    height: 7px;
    margin-left: auto;
    margin-right: var(--sp-1);
    border-right: 2px solid var(--text-muted);
    border-bottom: 2px solid var(--text-muted);
    transform: rotate(45deg) translateY(-2px);
    transition: transform var(--dur) var(--ease);
  }
  .fold[open] > summary::after {
    transform: rotate(-135deg) translateY(-2px);
  }
  .hint {
    font-size: var(--fs-2);
    font-weight: 400;
    color: var(--text-muted);
  }
  .body {
    padding: var(--sp-1) 0 var(--sp-2);
  }
</style>
