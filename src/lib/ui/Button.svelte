<!--
  The one button. Variants are looks only: primary, secondary, danger.
  Busy / progress / done / failed are behavior:
  - onclick returns a Promise → the button goes busy, then done (resolved) or failed
    (rejected), then back to idle after a moment. Show error details elsewhere.
  - progress (0–100) → the busy button fills and shows the percentage.
  - state → set from outside when something else drives it (e.g. a connection).
  With href it renders a link and has no states.
-->
<script>
  /** @type {{
   *   variant?: 'primary' | 'secondary' | 'danger',
   *   href?: string,
   *   onclick?: (event: MouseEvent) => unknown,
   *   state?: 'idle' | 'busy' | 'done' | 'failed',
   *   progress?: number | null,
   *   busyLabel?: string,
   *   doneLabel?: string,
   *   failedLabel?: string,
   *   type?: 'button' | 'submit' | 'reset',
   *   disabled?: boolean,
   *   children: import('svelte').Snippet,
   *   [key: string]: unknown,
   * }} */
  let {
    variant = 'primary',
    href,
    onclick,
    state: stateProp,
    progress = null,
    busyLabel = 'Working…',
    doneLabel = 'Done',
    failedLabel = 'Failed',
    type = 'button',
    disabled = false,
    children,
    ...rest
  } = $props();

  const RESET_MS = 2000;
  let own = $state('idle');
  let resetTimer;
  const status = $derived(stateProp ?? own);
  const busy = $derived(status === 'busy');
  const hasProgress = $derived(busy && typeof progress === 'number');
  const busyText = $derived(hasProgress ? `${busyLabel} ${Math.round(progress)}%` : busyLabel);
  const announcement = $derived(
    status === 'busy' ? busyText : status === 'done' ? doneLabel : status === 'failed' ? failedLabel : '',
  );

  async function handleClick(event) {
    if (busy || disabled) {
      event.preventDefault();
      return;
    }
    const result = onclick?.(event);
    if (!result || typeof result.then !== 'function') return;
    clearTimeout(resetTimer);
    own = 'busy';
    try {
      await result;
      own = 'done';
    } catch {
      own = 'failed';
    }
    resetTimer = setTimeout(() => (own = 'idle'), RESET_MS);
  }

  $effect(() => () => clearTimeout(resetTimer));
</script>

{#snippet labels()}
  <!-- All labels share one grid cell, so the button is as wide as the longest and
       doesn't jump when the label changes. -->
  <span class="label" class:shown={status === 'idle'}>{@render children()}</span>
  <span class="label" class:shown={busy} aria-hidden="true">{busyText}</span>
  <span class="label" class:shown={status === 'done'} aria-hidden="true">{doneLabel}</span>
  <span class="label" class:shown={status === 'failed'} aria-hidden="true">{failedLabel}</span>
{/snippet}

{#if href}
  <a class="btn {variant}" {href} {...rest}>{@render children()}</a>
{:else}
  <button
    class="btn {variant} {status}"
    class:has-progress={hasProgress}
    style:--progress={hasProgress ? `${progress}%` : null}
    {type}
    disabled={disabled && !busy}
    aria-disabled={busy || undefined}
    aria-busy={busy || undefined}
    onclick={handleClick}
    {...rest}
  >
    {@render labels()}
  </button>
  <span class="sr-only" aria-live="polite">{announcement}</span>
{/if}

<style>
  .btn {
    display: inline-grid;
    place-items: center;
    min-height: 44px; /* touch target */
    padding: 0 var(--sp-4);
    border: 1px solid transparent;
    border-radius: var(--r-md);
    font: 600 var(--fs-2) / var(--lh-tight) var(--font-sans);
    font-variant-numeric: tabular-nums;
    text-align: center;
    text-decoration: none;
    cursor: pointer;
    /* Paint from the outer edge and don't tile, so a progress fill never wraps into the border. */
    background-origin: border-box;
    background-repeat: no-repeat;
    transition: background-color var(--dur) var(--ease), border-color var(--dur) var(--ease), color var(--dur) var(--ease),
      --progress 300ms var(--ease);
  }
  .label { grid-area: 1 / 1; visibility: hidden; }
  .label.shown { visibility: visible; }
  a.btn > :global(*) { grid-area: 1 / 1; }

  .primary { background-color: var(--blue); color: var(--text); }
  .primary:hover { background-color: color-mix(in oklab, var(--blue) 80%, var(--bg-raised)); color: var(--text); }
  .secondary { background-color: transparent; border-color: var(--text-faint); color: var(--text); }
  .secondary:hover { background-color: var(--bg-sunken); border-color: var(--text); color: var(--text); }
  .danger { background-color: transparent; border-color: color-mix(in oklab, var(--error) 45%, transparent); color: var(--error); }
  .danger:hover { background-color: color-mix(in oklab, var(--error) 8%, transparent); border-color: var(--error); color: var(--error); }

  .btn:disabled { background-color: var(--bg-sunken); border-color: var(--line); color: var(--text-faint); cursor: not-allowed; }

  /* Busy: the button keeps its look and pulses; with a percentage it fills instead. */
  .busy { cursor: progress; }
  .primary.busy { background-color: color-mix(in oklab, var(--blue) 40%, var(--bg)); animation: pulse 1.6s ease-in-out infinite; }
  .secondary.busy, .danger.busy { border-color: var(--blue); background-color: color-mix(in oklab, var(--blue) 6%, transparent); animation: pulse-soft 1.6s ease-in-out infinite; }
  .primary.has-progress {
    animation: none;
    background-color: transparent;
    background-image: linear-gradient(to right, var(--blue) var(--progress), color-mix(in oklab, var(--blue) 22%, var(--bg)) var(--progress));
  }
  .secondary.has-progress, .danger.has-progress {
    animation: none;
    background-color: transparent;
    background-image: linear-gradient(to right, color-mix(in oklab, var(--blue) 28%, transparent) var(--progress), transparent var(--progress));
  }
  .btn.done { background-color: var(--ok); border-color: var(--ok); color: var(--bg-raised); }
  .btn.failed { background-color: transparent; border-color: var(--error); color: var(--error); }

  /* Registered so the fill slides between progress values instead of jumping. */
  @property --progress { syntax: '<percentage>'; inherits: false; initial-value: 0%; }

  @keyframes pulse { 50% { background-color: color-mix(in oklab, var(--blue) 70%, var(--bg)); } }
  @keyframes pulse-soft { 50% { background-color: color-mix(in oklab, var(--blue) 16%, transparent); } }
</style>
