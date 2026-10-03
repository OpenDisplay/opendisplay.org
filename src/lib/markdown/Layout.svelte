<!-- Wraps every Markdown page: frontmatter (title, lead, toc, lang) feeds Page, and the
     body is styled by Prose. The lead may contain inline HTML (links), written by us.
     lang marks a body in another language than the English page chrome (legal pages). -->
<script>
  import Page from '#lib/ui/Page.svelte';
  import Prose from '#lib/ui/Prose.svelte';

  let { title, lead, toc = true, lang, children } = $props();
</script>

<svelte:head>
  <title>{title} · OpenDisplay</title>
</svelte:head>

{#snippet leadHtml()}{@html lead}{/snippet}

<Page {title} lead={lead ? leadHtml : undefined} {toc}>
  <div {lang}><Prose>{@render children()}</Prose></div>
</Page>
