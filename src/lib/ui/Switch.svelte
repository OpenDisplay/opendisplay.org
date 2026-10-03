<!-- An on/off setting: a checkbox drawn as a switch, with a label and optional description. -->
<script>
  /** @type {{ checked?: boolean, label: string, description?: string, disabled?: boolean, onchange?: (e: Event) => void }} */
  let { checked = $bindable(false), label, description, disabled = false, onchange } = $props();
</script>

<label class="switch">
  <input type="checkbox" role="switch" bind:checked {disabled} {onchange} />
  <span class="text">
    <span class="label">{label}</span>
    {#if description}<span class="description">{description}</span>{/if}
  </span>
</label>

<style>
  .switch {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
    cursor: pointer;
  }
  input {
    appearance: none;
    position: relative;
    flex-shrink: 0;
    width: 44px;
    height: 26px;
    margin: 0;
    border-radius: var(--r-pill);
    corner-shape: round; /* pills and circles keep the classic shape */
    background: var(--line);
    cursor: pointer;
    transition: background var(--dur) var(--ease);
  }
  input::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    corner-shape: round; /* a real circle */
    background: var(--bg-raised);
    box-shadow: 0 1px 3px color-mix(in oklab, var(--text) 25%, transparent);
    transition: transform var(--dur) var(--ease);
  }
  input:checked {
    background: var(--blue);
  }
  input:checked::after {
    transform: translateX(18px);
  }
  input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    padding-top: calc(var(--sp-1) / 2);
  }
  .label {
    font-size: var(--fs-3);
  }
  .description {
    font-size: var(--fs-2);
    color: var(--text-muted);
  }
</style>
