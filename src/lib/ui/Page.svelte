<!-- Content column for a page, with an optional heading block.
     width: 'prose' (docs), 'tool' (forms and tools), 'wide' (overviews, tables). -->
<script>
  /** @type {{ eyebrow?: string, title?: string, lead?: string, width?: 'prose' | 'tool' | 'wide', children: import('svelte').Snippet }} */
  let { eyebrow, title, lead, width = 'prose', children } = $props();
</script>

<div class="page {width}">
  {#if title}
    <header>
      {#if eyebrow}<p class="eyebrow">{eyebrow}</p>{/if}
      <h1>{title}</h1>
      {#if lead}<p class="lead">{lead}</p>{/if}
    </header>
  {/if}
  {@render children()}
</div>

<style>
  .page { margin: 0 auto; padding: var(--sp-6) var(--sp-6) var(--sp-7); }
  .prose { max-width: 820px; }
  .tool { max-width: 760px; }
  .wide { max-width: 1200px; }
  header { margin-bottom: var(--sp-6); }
  .eyebrow {
    margin-bottom: var(--sp-2);
    font: 500 var(--fs-1) var(--font-mono);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  h1 { font-size: var(--fs-5); }
  .lead { margin-top: var(--sp-3); max-width: 52ch; font-size: var(--fs-3); color: var(--text-muted); }
  @media (max-width: 768px) {
    .page { padding: var(--sp-5) var(--sp-4) var(--sp-6); }
  }
</style>
