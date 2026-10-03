<!-- A section's entry page (STYLE.md: Hub): optional short intro, then one card per
     destination with a sentence or two and one secondary button to go there. -->
<script>
  import Button from './Button.svelte';
  import Card from './Card.svelte';
  import Page from './Page.svelte';
  import Prose from './Prose.svelte';

  /** @type {{
   *   title: string,
   *   lead?: string | import('svelte').Snippet,
   *   intro?: import('svelte').Snippet,
   *   destinations: { title: string, text: string, links?: [string, string][], action: [string, string] }[],
   * }} */
  let { title, lead, intro, destinations } = $props();
</script>

<Page {title} {lead}>
  {#if intro}
    <div class="intro"><Prose>{@render intro()}</Prose></div>
  {/if}
  <div class="destinations">
    {#each destinations as d (d.title)}
      <Card title={d.title}>
        <Prose>
          <p>{d.text}</p>
          {#if d.links?.length}
            <p class="links">
              {#each d.links as [label, url], i (url)}{#if i}{' · '}{/if}<a href={url}>{label}</a>{/each}
            </p>
          {/if}
        </Prose>
        <div class="action"><Button variant="secondary" href={d.action[1]}>{d.action[0]}</Button></div>
      </Card>
    {/each}
  </div>
</Page>

<style>
  .intro {
    margin-bottom: var(--sp-6);
  }
  .destinations {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }
  .links {
    font-size: var(--fs-2);
  }
  .action {
    margin-top: var(--sp-4);
  }
</style>
