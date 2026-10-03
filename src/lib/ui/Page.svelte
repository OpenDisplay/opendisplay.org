<!-- The content column every page uses, with an optional heading block.
     toc: an "On this page" list of the page's sections (h2 and h3 that have an id).
     Wide screens: a sticky sidebar. Narrow screens: a collapsible list under the heading. -->
<script>
  import { onMount } from 'svelte';
  import Fold from './Fold.svelte';

  /** @type {{ eyebrow?: string, title?: string, lead?: string | import('svelte').Snippet, toc?: boolean, children: import('svelte').Snippet }} */
  let { eyebrow, title, lead, toc = false, children } = $props();

  /** @type {HTMLElement} */
  let content;
  /** @type {{ id: string, title: string, sub: boolean }[]} */
  let sections = $state([]);

  // Built in the browser from the headings: the section ids are in the prerendered
  // markup, so #links work without this list; it only adds the sidebar.
  /** The section being read: the last heading that has scrolled past the top. */
  let current = $state(null);

  onMount(() => {
    if (!toc) return;
    const headings = [...content.querySelectorAll('h2[id], h3[id]')];
    sections = headings.map((h) => ({ id: h.id, title: h.textContent.trim(), sub: h.tagName === 'H3' }));

    const OFFSET = 120; // a heading counts as reached once it's this close to the top
    let frame = 0;
    const update = () => {
      frame = 0;
      const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
      const passed = headings.filter((h) => h.getBoundingClientRect().top <= OFFSET);
      current = atBottom ? headings.at(-1)?.id : (passed.at(-1)?.id ?? null);
    };
    const onScroll = () => (frame ||= requestAnimationFrame(update));
    update();
    addEventListener('scroll', onScroll, { passive: true });
    return () => {
      removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  });
</script>

<div class="page" class:with-toc={toc}>
  <div class="content" bind:this={content}>
    {#if title}
      <header>
        {#if eyebrow}<p class="eyebrow">{eyebrow}</p>{/if}
        <h1>{title}</h1>
        {#if lead}<p class="lead">
            {#if typeof lead === 'string'}{lead}{:else}{@render lead()}{/if}
          </p>{/if}
      </header>
    {/if}
    {#if toc && sections.length > 1}
      <div class="toc-inline">
        <Fold summary="On this page">{@render list()}</Fold>
      </div>
    {/if}
    {@render children()}
  </div>
  {#if toc && sections.length > 1}
    <nav class="toc" aria-label="On this page">
      <p class="toc-title">On this page</p>
      {@render list()}
    </nav>
  {/if}
</div>

{#snippet list()}
  <ul>
    {#each sections as section (section.id)}
      <li class:sub={section.sub}>
        <a href="#{section.id}" aria-current={current === section.id ? 'location' : undefined}
          >{section.title}</a
        >
      </li>
    {/each}
  </ul>
{/snippet}

<style>
  .page {
    max-width: 900px;
    margin: 0 auto;
    padding: var(--sp-6) var(--sp-6) var(--sp-7);
  }
  header {
    margin-bottom: var(--sp-6);
  }
  .eyebrow,
  .toc-title {
    margin-bottom: var(--sp-2);
    font: 500 var(--fs-1) var(--font-mono);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  h1 {
    font-size: var(--fs-5);
  }
  .lead {
    margin-top: var(--sp-3);
    max-width: 70ch;
    font-size: var(--fs-3);
    color: var(--text-muted);
  }

  .toc {
    display: none;
  }
  .toc-inline {
    margin-bottom: var(--sp-5);
  }
  @media (min-width: 1100px) {
    .toc-inline {
      display: none;
    }
    .with-toc {
      display: grid;
      grid-template-columns: minmax(0, 900px) 200px;
      gap: var(--sp-6);
      max-width: none;
      justify-content: center;
    }
    .toc {
      display: block;
      position: sticky;
      top: var(--sp-5);
      align-self: start;
      max-height: calc(100vh - 2 * var(--sp-5));
      overflow-y: auto;
      /* line up with the first section, below the page heading */
      margin-top: var(--sp-2);
    }
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li + li {
    margin-top: var(--sp-2);
  }
  .sub {
    padding-left: var(--sp-3);
  }
  ul a {
    display: block;
    font-size: var(--fs-2);
    line-height: var(--lh-tight);
    color: var(--text-muted);
    text-decoration: none;
  }
  ul a[aria-current] {
    color: var(--text);
    font-weight: 500;
  }
  ul a:hover {
    color: var(--text);
  }

  @media (max-width: 768px) {
    .page {
      padding: var(--sp-5) var(--sp-4) var(--sp-6);
    }
  }
</style>
