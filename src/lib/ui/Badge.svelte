<!-- A short status label in tables and lists. tone: neutral, info, ok, warn, error. -->
<script>
  /** @type {{ tone?: 'neutral' | 'info' | 'ok' | 'warn' | 'error', children: import('svelte').Snippet }} */
  let { tone = 'neutral', children } = $props();
</script>

<span class="badge {tone}">{@render children()}</span>

<style>
  .badge {
    --tone: var(--text-muted);
    display: inline-block;
    padding: 0 var(--sp-2);
    border-radius: var(--r-pill);
    corner-shape: round;
    background: color-mix(in oklab, var(--tone) 12%, var(--bg));
    color: color-mix(in oklab, var(--tone) 85%, var(--text));
    font: 500 var(--fs-1) / var(--lh-body) var(--font-mono);
    white-space: nowrap;
  }
  .info { --tone: var(--blue); color: color-mix(in oklab, var(--blue) 60%, var(--text)); }
  .ok { --tone: var(--ok); }
  .warn { --tone: var(--warn); }
  .error { --tone: var(--error); }
</style>
