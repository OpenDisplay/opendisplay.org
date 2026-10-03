<script>
  import { external, href } from '#lib/paths.js';

  const columns = [
    {
      title: 'Build',
      links: [
        ['What hardware to buy', href.hardware],
        ['Home Assistant', href.homeAssistantGuide],
        ['BLE Tester', href.bleTester],
        ['Battery calculator', href.battery],
      ],
    },
    {
      title: 'Reference',
      links: [
        ['Protocol spec', href.protocol],
        ['Display data format', href.displayDataFormat],
        ['OpenDisplay Flex', href.flexStandard],
      ],
    },
    {
      title: 'Flex tools',
      links: [
        ['Overview', href.flexTools],
        ['Toolbox', href.toolbox],
        ['Adding a new panel', href.addingDisplays],
      ],
    },
    {
      title: 'Community',
      links: [
        ['GitHub', external.github, true],
        ['Discord', external.discord, true],
        ['Open Home Foundation', external.openHomeFoundation, true],
      ],
    },
  ];
</script>

<footer>
  <div class="inner">
    <div class="top">
      <div class="brand">
        <a href={href.home} aria-label="OpenDisplay home">
          <img src="/assets/brand/logo_dark.svg" alt="OpenDisplay" width="140" height="41" />
        </a>
        <span class="tag">The open e-paper standard</span>
        <p class="lead">
          An open standard and open firmware that lets any sender put pictures on any screen. Local,
          low-power, designed for e-paper.
        </p>
      </div>
      {#each columns as column (column.title)}
        <nav class="col" aria-label={column.title}>
          <span class="heading">{column.title}</span>
          {#each column.links as [label, url, outside] (label)}
            <a href={url} target={outside ? '_blank' : undefined} rel={outside ? 'noreferrer' : undefined}>
              {label}
            </a>
          {/each}
        </nav>
      {/each}
    </div>
    <div class="bottom">
      <span>© {new Date().getFullYear()} OpenDisplay</span>
      <div class="legal">
        <a href={href.impressum}>Legal notice</a>
        <a href={href.datenschutz}>Privacy policy</a>
      </div>
    </div>
  </div>
</footer>

<style>
  footer {
    background: var(--dark);
    color: var(--bg);
    padding: var(--sp-7) 0 var(--sp-6);
  }
  .inner {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 var(--sp-6);
  }
  .top {
    display: grid;
    grid-template-columns: 1.5fr repeat(4, 1fr);
    gap: var(--sp-6);
    padding-bottom: var(--sp-6);
    border-bottom: 1px solid color-mix(in oklab, var(--bg) 15%, var(--dark));
  }
  .brand {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
  .brand img {
    height: 32px;
    width: auto;
  }
  .tag,
  .heading,
  .bottom {
    font-family: var(--font-mono);
    font-size: var(--fs-1);
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .lead {
    max-width: 36ch;
    font-size: var(--fs-2);
    color: var(--text-faint);
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .heading {
    margin-bottom: var(--sp-1);
  }
  a {
    color: var(--bg);
    text-decoration: none;
  }
  a:hover {
    color: var(--blue);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .bottom {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: var(--sp-4);
    padding-top: var(--sp-5);
    text-transform: none;
  }
  .legal {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-4);
  }

  @media (max-width: 768px) {
    .inner {
      padding: 0 var(--sp-4);
    }
    .top {
      grid-template-columns: 1fr 1fr;
    }
  }
  @media (max-width: 480px) {
    .top {
      grid-template-columns: 1fr;
    }
  }
</style>
