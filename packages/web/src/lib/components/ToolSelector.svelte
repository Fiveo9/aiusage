<script>
  import { dateRange, selectedDevice, selectedTool, setTool } from '../stores.js'
  import { fetchTools } from '../api.js'

  let tools = []
  let loading = true

  async function loadTools() {
    loading = true
    try {
      const params = { ...$dateRange, device: $selectedDevice }
      const data = await fetchTools(params)
      tools = data.tools || []
    } catch {
      tools = []
    } finally {
      loading = false
    }
  }

  // Load on mount and reload when date range or device changes
  $: $dateRange, $selectedDevice, loadTools()

  // Clear selection if the selected tool no longer has data
  $: if (!loading && $selectedTool && !tools.some(t => t.tool === $selectedTool)) {
    setTool('')
  }

  function toggle(tool) {
    setTool($selectedTool === tool ? '' : tool)
  }
</script>

{#if !loading && tools.length > 0}
  <div class="tool-toggles" role="group" aria-label="AI Tools">
    {#each tools as item}
      <button
        type="button"
        class="tool-btn"
        class:active={$selectedTool === item.tool}
        aria-pressed={$selectedTool === item.tool}
        on:click={() => toggle(item.tool)}
        title="{item.tool} ({item.sessionCount})"
      >
        <span>{item.tool}</span>
        <span class="tool-count numeric">{item.sessionCount}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .tool-toggles {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
  }

  .tool-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    height: var(--control-height);
    padding: 0 0.6rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: color 0.12s ease, background-color 0.12s ease, border-color 0.12s ease;
  }

  .tool-btn:hover {
    color: var(--text);
    background: var(--raised);
    border-color: var(--border-medium);
  }

  .tool-btn.active {
    color: var(--accent-strong);
    background: var(--accent-dim);
    border-color: color-mix(in oklch, var(--accent) 45%, transparent);
    font-weight: 600;
  }

  .tool-count {
    font-size: var(--text-2xs);
    font-weight: 500;
    color: var(--text-muted);
  }

  .tool-btn.active .tool-count {
    color: var(--accent);
  }
</style>
