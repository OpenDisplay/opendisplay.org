<script>
  import Card from '#lib/ui/Card.svelte';
  import Page from '#lib/ui/Page.svelte';
  import Prose from '#lib/ui/Prose.svelte';
</script>

<svelte:head>
  <title>Legal notice · OpenDisplay</title>
  <meta name="description" content="Legal notice (Impressum) for opendisplay.org.">
</svelte:head>

<!-- The legal text is German (German law requires it); the page chrome stays English. -->
<Page title="Legal notice">
  <div lang="de" class="stack">
  <Card>
    <Prose>
      <h2>Angaben gemäß § 5 TMG, Verantwortlicher für den Inhalt nach § 55 Abs. 2 RStV</h2>
      <p>Jonas Niesner<br>
      Espenstr. 9<br>
      84051 Essenbach<br>
      E-Mail: jonas.niesner@gmail.com<br>
      Telefon: +4915730112156</p>
    </Prose>
  </Card>
  </div>
</Page>

<style>
  .stack { display: flex; flex-direction: column; gap: var(--sp-4); }
</style>
