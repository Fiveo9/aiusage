<script>
  export let type = 'info' // 'info' | 'tip' | 'warn'
</script>

<div class="callout {type}">
  <span class="callout-mark">
    {#if type === 'info'}i{:else if type === 'tip'}✦{:else}!{/if}
  </span>
  <div class="callout-body"><slot /></div>
</div>

<style>
  .callout {
    display: flex;
    gap: 0.875rem;
    align-items: flex-start;
    padding: 1rem 1.25rem;
    border-radius: 8px;
    margin: 1rem 0;
    font-size: 0.9375rem;
    line-height: 1.65;
    border: 1px solid;
  }

  .callout-mark {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-family: var(--mono);
    font-size: 0.6875rem;
    font-weight: 700;
    margin-top: 0.125rem;
  }

  .callout-body { flex: 1; min-width: 0; }

  .info {
    border-color: oklch(0.52 0.16 250 / 0.2);
    background: oklch(0.52 0.16 250 / 0.06);
    color: var(--blue);
  }
  .info .callout-mark {
    background: oklch(0.52 0.16 250 / 0.15);
    color: var(--blue);
  }

  .tip {
    border-color: oklch(0.52 0.14 165 / 0.2);
    background: oklch(0.52 0.14 165 / 0.06);
    color: var(--accent);
  }
  .tip .callout-mark {
    background: oklch(0.52 0.14 165 / 0.15);
    color: var(--accent);
  }

  .warn {
    border-color: oklch(0.55 0.22 25 / 0.2);
    background: oklch(0.55 0.22 25 / 0.06);
    color: var(--rose);
  }
  .warn .callout-mark {
    background: oklch(0.55 0.22 25 / 0.15);
    color: var(--rose);
  }
</style>
