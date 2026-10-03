<!-- Living style guide: every token and every component variant, in one place.
     Not linked from the site. Add new components and variants here in the same commit. -->
<script>
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Callout from '#lib/ui/Callout.svelte';
  import Card from '#lib/ui/Card.svelte';
  import Field from '#lib/ui/Field.svelte';
  import Fold from '#lib/ui/Fold.svelte';
  import Page from '#lib/ui/Page.svelte';
  import Prose from '#lib/ui/Prose.svelte';
  import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
  import Swatch from '#lib/ui/Swatch.svelte';
  import Switch from '#lib/ui/Switch.svelte';
  import { SCHEMES } from '#lib/ui/inks.js';

  const colors = [
    'blue',
    'text',
    'text-muted',
    'text-faint',
    'bg',
    'bg-sunken',
    'bg-raised',
    'line',
    'dark',
    'ok',
    'warn',
    'error',
  ];
  const sizes = ['fs-1', 'fs-2', 'fs-3', 'fs-4', 'fs-5', 'fs-6'];
  const spaces = ['sp-1', 'sp-2', 'sp-3', 'sp-4', 'sp-5', 'sp-6', 'sp-7'];

  const wait = (ms, fail = false) =>
    new Promise((resolve, reject) => setTimeout(fail ? reject : resolve, ms));
  let progress = $state(null);
  async function upload() {
    for (progress = 0; progress < 100; progress += 10) await wait(150);
    progress = null;
  }

  let mode = $state('floyd');
  let encryption = $state(true);
  let name = $state('');
</script>

<svelte:head>
  <title>UI kit · OpenDisplay</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<Page
  eyebrow="Internal"
  title="UI kit"
  lead="Every design token and component variant. If it isn't here, it doesn't exist yet."
>
  <section>
    <h2>Colors (12)</h2>
    <div class="grid">
      {#each colors as token (token)}
        <div class="token">
          <span class="chip" data-token={token}></span>
          <code>--{token}</code>
        </div>
      {/each}
    </div>
    <p class="note">
      Blue text and tints are mixes of <code>--blue</code>
      , never new tokens:
      <a href="#links">links</a>
      use
      <code>color-mix(in oklab, var(--blue) 60%, var(--text))</code>
      (5.2:1 on
      <code>--bg</code>
      ).
    </p>
  </section>

  <section>
    <h2>Type (6 sizes)</h2>
    {#each sizes as token (token)}
      <p class="sample" data-size={token}>
        <code>--{token}</code>
        The open e-paper standard
      </p>
    {/each}
  </section>

  <section>
    <h2>Space (7 steps)</h2>
    {#each spaces as token (token)}
      <div class="token">
        <span class="bar" data-space={token}></span>
        <code>--{token}</code>
      </div>
    {/each}
  </section>

  <section>
    <h2>Button</h2>
    <div class="row">
      <Button>Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="danger">Danger</Button>
      <Button disabled>Disabled</Button>
      <Button href="#links" variant="secondary">As a link</Button>
    </div>
    <h3>States are behavior</h3>
    <div class="row">
      <Button onclick={() => wait(1200)} busyLabel="Writing…" doneLabel="Saved">Write config</Button>
      <Button variant="secondary" onclick={() => wait(1200, true)} busyLabel="Reading…">Read (fails)</Button>
      <Button onclick={upload} {progress} busyLabel="Uploading">Send image</Button>
    </div>
    <div class="row">
      <Button state="busy" busyLabel="Connecting…">Connect</Button>
      <Button state="busy" progress={42} busyLabel="Flashing">Install</Button>
      <Button variant="secondary" state="busy">Secondary busy</Button>
      <Button state="done" doneLabel="Saved">Write</Button>
      <Button variant="secondary" state="failed" failedLabel="Failed">Read</Button>
    </div>
  </section>

  <section>
    <h2>Card, Field, Switch, SegmentedControl, Fold</h2>
    <Card title="Display settings">
      {#snippet icon()}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="4" width="18" height="14" rx="2" />
          <path d="M8 21h8" />
        </svg>
      {/snippet}
      <Field label="Device name" id="ui-name" hint="Shown in Bluetooth scans.">
        <input id="ui-name" bind:value={name} placeholder="OD123456" aria-describedby="ui-name-message" />
      </Field>
      <Field label="Encryption key" id="ui-key" error="Needs 32 hex characters.">
        <input id="ui-key" value="abc" aria-describedby="ui-key-message" aria-invalid="true" />
      </Field>
      <Field label="Color scheme" id="ui-scheme">
        <select id="ui-scheme">
          <option>Black / white</option>
          <option>Black / white / red</option>
        </select>
      </Field>
      <div class="stack">
        <Switch
          bind:checked={encryption}
          label="Encrypt the connection"
          description="Only devices with the key can change settings."
        />
        <SegmentedControl
          label="Dithering"
          bind:value={mode}
          options={[
            { value: 'none', label: 'None' },
            { value: 'floyd', label: 'Floyd-Steinberg' },
            { value: 'burkes', label: 'Burkes' },
          ]}
        />
      </div>
      <Fold summary="Advanced" hint="Pins and power">
        <p>Folded content sits on the page, without a box around it.</p>
      </Fold>
    </Card>
  </section>

  <section>
    <h2>Callout</h2>
    <div class="stack">
      <Callout>Your display needs firmware 2.4 or newer.</Callout>
      <Callout tone="ok">Settings saved. The display restarts now.</Callout>
      <Callout tone="warn">Updating erases the Wi-Fi settings.</Callout>
      <Callout tone="error">The display didn't answer. Move closer and try again.</Callout>
    </div>
  </section>

  <section id="links">
    <h2>Prose, Badge, Swatch</h2>
    <Prose>
      <p>
        Body text with a <a href="#links">link</a>
        and
        <code>inline code</code>
        .
      </p>
      <table>
        <thead>
          <tr>
            <th>Panel</th>
            <th>Inks</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>EP26R</code>
              2.6"
            </td>
            <td><Swatch scheme={1} /></td>
            <td><Badge tone="ok">compatible</Badge></td>
          </tr>
          <tr>
            <td>
              <code>EP29YR</code>
              2.9"
            </td>
            <td><Swatch scheme={3} /></td>
            <td><Badge tone="warn">wip</Badge></td>
          </tr>
          <tr>
            <td>
              <code>EP42</code>
              4.2"
            </td>
            <td><Swatch scheme={0} /></td>
            <td><Badge tone="error">no</Badge> <Badge>required</Badge> <Badge tone="info">24-pin</Badge></td>
          </tr>
        </tbody>
      </table>
      <pre><code
          >{`ble_proto:
  packet_types:
    0x20: display`}</code
        ></pre>
    </Prose>
    <h3>Every color scheme</h3>
    <div class="grid">
      {#each Object.entries(SCHEMES) as [scheme, entry] (scheme)}
        <div class="token">
          <Swatch scheme={Number(scheme)} />
          <span>{scheme} · {entry.label}</span>
        </div>
      {/each}
    </div>
  </section>
</Page>

<style>
  section + section {
    margin-top: var(--sp-7);
  }
  h2 {
    margin-bottom: var(--sp-4);
    font-size: var(--fs-4);
  }
  h3 {
    margin: var(--sp-5) 0 var(--sp-3);
    font-size: var(--fs-3);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: var(--sp-3);
  }
  .token {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    font-size: var(--fs-2);
  }
  .token + .token {
    margin-top: var(--sp-2);
  }
  .grid .token + .token {
    margin-top: 0;
  }
  .chip {
    width: 40px;
    height: 40px;
    border-radius: var(--r-sm);
    border: 1px solid var(--line);
  }
  .note {
    margin-top: var(--sp-4);
    font-size: var(--fs-2);
    color: var(--text-muted);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-3);
    margin-top: var(--sp-3);
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    margin: var(--sp-4) 0;
  }
  .sample + .sample {
    margin-top: var(--sp-2);
  }
  .sample code {
    display: inline-block;
    width: 6ch;
    font-size: var(--fs-1);
    color: var(--text-muted);
  }
  .bar {
    height: var(--sp-3);
    background: var(--blue);
    border-radius: var(--r-sm);
  }

  [data-token='blue'] {
    background: var(--blue);
  }
  [data-token='text'] {
    background: var(--text);
  }
  [data-token='text-muted'] {
    background: var(--text-muted);
  }
  [data-token='text-faint'] {
    background: var(--text-faint);
  }
  [data-token='bg'] {
    background: var(--bg);
  }
  [data-token='bg-sunken'] {
    background: var(--bg-sunken);
  }
  [data-token='bg-raised'] {
    background: var(--bg-raised);
  }
  [data-token='line'] {
    background: var(--line);
  }
  [data-token='dark'] {
    background: var(--dark);
  }
  [data-token='ok'] {
    background: var(--ok);
  }
  [data-token='warn'] {
    background: var(--warn);
  }
  [data-token='error'] {
    background: var(--error);
  }
  [data-size='fs-1'] {
    font-size: var(--fs-1);
  }
  [data-size='fs-2'] {
    font-size: var(--fs-2);
  }
  [data-size='fs-3'] {
    font-size: var(--fs-3);
  }
  [data-size='fs-4'] {
    font-size: var(--fs-4);
  }
  [data-size='fs-5'] {
    font-size: var(--fs-5);
  }
  [data-size='fs-6'] {
    font-size: var(--fs-6);
  }
  [data-space='sp-1'] {
    width: var(--sp-1);
  }
  [data-space='sp-2'] {
    width: var(--sp-2);
  }
  [data-space='sp-3'] {
    width: var(--sp-3);
  }
  [data-space='sp-4'] {
    width: var(--sp-4);
  }
  [data-space='sp-5'] {
    width: var(--sp-5);
  }
  [data-space='sp-6'] {
    width: var(--sp-6);
  }
  [data-space='sp-7'] {
    width: var(--sp-7);
  }
</style>
