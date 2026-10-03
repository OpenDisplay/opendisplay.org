<!-- The inks a display can show, for a firmware color scheme (0–9), in palette order.
     Gray schemes with many levels render as one stepped strip. -->
<script>
  import { SCHEMES } from './inks.js';

  /** @type {{ scheme: number }} */
  let { scheme } = $props();
  const entry = $derived(SCHEMES[scheme]);
  const strip = $derived(entry.inks.length > 7);
  const title = (name) => name.replace(/^gray(\d+)$/, 'gray $1').replace(/^./, (c) => c.toUpperCase());
</script>

<span class="swatches" class:strip role="img" aria-label={entry.label}>
  {#each entry.inks as [name, color] (name)}
    <span class="patch" style:background-color={color} title={title(name)}></span>
  {/each}
</span>

<style>
  .swatches {
    display: inline-flex;
    gap: var(--sp-1);
    vertical-align: middle;
  }
  .patch {
    width: 16px;
    height: 16px;
    border-radius: var(--r-sm);
    border: 1px solid var(--line);
  }
  /* Many gray levels: one continuous strip of narrow steps. */
  .strip {
    gap: 0;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
  }
  .strip .patch {
    width: 6px;
    border: 0;
    border-radius: 0;
  }
</style>
