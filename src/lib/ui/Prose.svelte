<!-- Styles plain HTML content: headings, paragraphs, lists, tables, code. Doc pages write
     ordinary markup inside <Prose> instead of styling elements one by one. -->
<script>
  /** @type {{ children: import('svelte').Snippet }} */
  let { children } = $props();
</script>

<div class="prose">{@render children()}</div>

<style>
  .prose {
    color: var(--text);
  }
  .prose :global(:is(p, ul, ol, table, pre, figure)) {
    margin: 0 0 var(--sp-4);
  }
  .prose > :global(:last-child) {
    margin-bottom: 0;
  }
  /* Sections are separated by a hairline, not boxed (STYLE.md: Docs). */
  .prose :global(h2:not(:first-child)) {
    padding-top: var(--sp-6);
    border-top: 1px solid var(--line);
  }
  .prose :global(h2) {
    margin: var(--sp-6) 0 var(--sp-3);
    font-size: var(--fs-4);
  }
  .prose :global(h3) {
    margin: var(--sp-5) 0 var(--sp-2);
    font-size: var(--fs-3);
  }
  .prose :global(h4) {
    margin: var(--sp-4) 0 var(--sp-1);
    font-size: var(--fs-3);
    font-weight: 500;
  }
  .prose :global(h3 + h4) {
    margin-top: var(--sp-2);
  }
  .prose :global(:is(h2, h3, h4):first-child) {
    margin-top: 0;
  }
  .prose :global(:is(ul, ol)) {
    padding-left: var(--sp-5);
  }
  .prose :global(li + li) {
    margin-top: var(--sp-1);
  }

  .prose :global(code) {
    padding: 0 var(--sp-1);
    background: var(--bg-sunken);
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
  }
  .prose :global(pre) {
    padding: var(--sp-4) var(--sp-5);
    overflow-x: auto;
    background: var(--dark);
    color: var(--bg);
    border-radius: var(--r-md);
    font-size: var(--fs-2);
    line-height: var(--lh-body);
  }
  .prose :global(pre code) {
    padding: 0;
    background: none;
    border: 0;
  }

  .prose :global(table) {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fs-2);
  }
  /* On small screens, tables scroll sideways instead of squeezing. */
  @media (max-width: 768px) {
    .prose :global(table) {
      display: block;
      overflow-x: auto;
    }
    .prose :global(:is(th, td)) {
      padding: var(--sp-2);
    }
    .prose :global(td:first-child) {
      white-space: nowrap;
    }
  }
  .prose :global(caption) {
    padding-bottom: var(--sp-2);
    text-align: left;
    color: var(--text-muted);
  }
  .prose :global(th) {
    text-align: left;
    font-weight: 600;
    border-bottom: 2px solid var(--line);
  }
  .prose :global(:is(th, td)) {
    padding: var(--sp-3);
    vertical-align: top;
  }
  .prose :global(td) {
    color: var(--text-muted);
    border-bottom: 1px solid var(--line);
  }
  .prose :global(td code) {
    color: var(--text);
  }
  /* The first column names the row. */
  .prose :global(td:first-child) {
    color: var(--text);
  }
</style>
