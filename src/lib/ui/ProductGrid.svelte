<!-- Products as cards in a grid (STYLE.md: Catalog): photo, name, a status line, links.
     Two columns on wide screens, one on phones. -->
<script>
  import Card from './Card.svelte';

  /** @type {{ products: { name: string, image: string, alt: string, status?: string, links: [string, string][] }[] }} */
  let { products } = $props();

  const external = (url) => /^https?:/.test(url);
</script>

<div class="grid">
  {#each products as p (p.name)}
    <Card>
      <img src={p.image} alt={p.alt} width="640" height="360" loading="lazy" />
      <h3>{p.name}</h3>
      {#if p.status}<p class="status">{p.status}</p>{/if}
      <p class="links">
        {#each p.links as [label, url] (url)}
          <a
            href={url}
            target={external(url) ? '_blank' : undefined}
            rel={external(url) ? 'noreferrer' : undefined}>{label}</a
          >
        {/each}
      </p>
    </Card>
  {/each}
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-4);
    margin: 0 0 var(--sp-5);
  }
  .grid :global(.card + .card) {
    margin-top: 0;
  }
  img {
    width: 100%;
    height: auto;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border-radius: var(--r-sm);
    background: var(--bg-sunken);
  }
  /* Explicit margins: the grid usually sits inside Prose, whose text spacing doesn't apply here. */
  .grid h3 {
    margin: var(--sp-3) 0 0;
    padding: 0;
    border: 0;
    font-size: var(--fs-3);
  }
  .grid .status {
    margin: var(--sp-1) 0 0;
    font-size: var(--fs-2);
    color: var(--text-muted);
  }
  .grid .links {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1) var(--sp-4);
    margin: var(--sp-3) 0 0;
    font-size: var(--fs-2);
  }
  @media (max-width: 640px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
