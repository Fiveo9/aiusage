<script>
  import { onMount } from 'svelte'
  import { dateRange, selectedDevice, selectedTool, formatNumber, formatCost, formatTokens } from '$lib/stores.js'
  import { fetchSummary, refreshData } from '$lib/api.js'
  import { t } from '$lib/i18n.js'
  import DateRangeSelector from '$lib/components/DateRangeSelector.svelte'
  import DeviceSelector from '$lib/components/DeviceSelector.svelte'
  import ToolSelector from '$lib/components/ToolSelector.svelte'

  let data = null
  let error = null
  let loading = true
  let tcTab = 'all'
  let initialized = false

  async function loadData({ showLoading = true } = {}) {
    if (!initialized) return
    if (showLoading) loading = true
    error = null
    try {
      data = await fetchSummary({ ...$dateRange, device: $selectedDevice, tool: $selectedTool })
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load data'
      data = null
    } finally {
      loading = false
    }
  }

  onMount(async () => {
    // Show existing data first; don't block the page on log parsing (issue #40).
    initialized = true
    await loadData()
    // Refresh logs in the background, then reload once it completes. The
    // figures already shown stay up while the reload is in flight.
    refreshData().then(() => loadData({ showLoading: false })).catch(() => {})
  })

  $: $dateRange, $selectedDevice, $selectedTool, loadData()
</script>

<svelte:head>
  <title>{$t('overview.title')} — AIUsage</title>
</svelte:head>

<div class="page-header">
  <h1>{$t('overview.title')}</h1>
  <p>{$t('overview.desc')}</p>
</div>

<div class="filter-bar">
  <DateRangeSelector />
  <DeviceSelector />
  <ToolSelector />
</div>

{#if loading}
  <div class="state-msg">
    <span class="loading-spin"></span>
    <span class="loading-text">{$t('common.loading')}</span>
  </div>
{:else if error}
  <div class="state-msg error">{error}</div>
{:else if !data || data.totalTokens === 0}
  <div class="state-msg">
    <h2>{$t('common.noData')}</h2>
    <p>{$t('common.noDataHint')}</p>
  </div>
{:else}
  <div class="hero-stats">
    <div class="hero-card card-tokens">
      <div class="hero-header">
        <span class="hero-dot"></span>
        <span class="hero-label">{$t('overview.totalTokens')}</span>
      </div>
      <span class="hero-value">{formatTokens(data.totalTokens)}</span>
    </div>
    <div class="hero-card card-cost">
      <div class="hero-header">
        <span class="hero-dot"></span>
        <span class="hero-label">{$t('overview.totalCost')}</span>
      </div>
      <span class="hero-value hero-cost">{formatCost(data.totalCost)}</span>
    </div>
    <div class="hero-card card-days">
      <div class="hero-header">
        <span class="hero-dot"></span>
        <span class="hero-label">{$t('overview.activeDays')}</span>
      </div>
      <span class="hero-value">{data.activeDays}</span>
    </div>
    <div class="hero-card card-sessions">
      <div class="hero-header">
        <span class="hero-dot"></span>
        <span class="hero-label">{$t('overview.totalSessions')}</span>
      </div>
      <span class="hero-value">{formatNumber(data.totalSessions || 0)}</span>
    </div>
  </div>

  <div class="token-breakdown">
    <div class="token-item item-input">
      <div class="token-indicator"></div>
      <span class="token-label">{$t('overview.inputTokens')}</span>
      <span class="token-value">{formatTokens(data.inputTokens)}</span>
    </div>
    <div class="token-item item-output">
      <div class="token-indicator"></div>
      <span class="token-label">{$t('overview.outputTokens')}</span>
      <span class="token-value">{formatTokens(data.outputTokens)}</span>
    </div>
    <div class="token-item item-cr">
      <div class="token-indicator"></div>
      <span class="token-label">{$t('overview.cacheRead')}</span>
      <span class="token-value">{formatTokens(data.cacheReadTokens)}</span>
    </div>
    <div class="token-item item-cw">
      <div class="token-indicator"></div>
      <span class="token-label">{$t('overview.cacheWrite')}</span>
      <span class="token-value">{formatTokens(data.cacheWriteTokens)}</span>
    </div>
  </div>

  <div class="grid-2">
    <div class="card">
      <div class="section-title">{$t('overview.byTool')}</div>
      {#if Object.keys(data.byTool).length === 0}
        <p class="muted">{$t('overview.noToolData')}</p>
      {:else}
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>{$t('overview.tool')}</th>
                <th class="numeric-head">{$t('overview.tokens')}</th>
                <th class="numeric-head">{$t('overview.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {#each Object.entries(data.byTool) as [tool, stats]}
                <tr>
                  <td class="tool-cell">
                    <span class="tool-badge">{tool}</span>
                  </td>
                  <td class="numeric">{formatTokens(stats.tokens)}</td>
                  <td class="numeric accent font-semibold">{formatCost(stats.cost)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>

    <div class="card">
      <div class="card-header">
        <div class="section-title">{$t('overview.topToolCalls')}</div>
        <div class="card-tabs">
          <button class="card-tab" class:active={tcTab === 'all'} on:click={() => tcTab = 'all'}>
            {$t('overview.tabAll')}
          </button>
          <button class="card-tab" class:active={tcTab === 'mcp'} on:click={() => tcTab = 'mcp'}>
            {$t('overview.tabMcp')}
          </button>
        </div>
      </div>
      {#if tcTab === 'all'}
        {#if data.topToolCalls.length === 0}
          <p class="muted">{$t('overview.noToolCalls')}</p>
        {:else}
          <div class="tc-list">
            {#each data.topToolCalls as tc, i}
              <div class="tc-row" style="animation-delay: {i * 35}ms">
                <span class="tc-rank" class:top-rank={i < 3}>#{i + 1}</span>
                <span class="tc-name mono">{tc.name}</span>
                <span class="tc-count numeric">{formatNumber(tc.count)}</span>
              </div>
            {/each}
          </div>
        {/if}
      {:else}
        {#if !data.topMcpServers?.length}
          <p class="muted">{$t('overview.noMcpCalls')}</p>
        {:else}
          <div class="tc-list">
            {#each data.topMcpServers as srv, i}
              <div class="tc-row" style="animation-delay: {i * 35}ms">
                <span class="tc-rank" class:top-rank={i < 3}>#{i + 1}</span>
                <span class="tc-name mono">{srv.server}</span>
                <span class="tc-count numeric">{formatNumber(srv.count)}</span>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  /* ── Hero KPI Cards ─────────────────────────────────────────────────────── */
  .hero-stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1.125rem;
    margin-bottom: 1.5rem;
  }
  .hero-card {
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    padding: 1.35rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    min-width: 0;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .hero-card:hover {
    border-color: var(--border-medium);
    transform: translateY(-2px);
    box-shadow: var(--shadow-md);
  }

  .hero-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .hero-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .card-tokens .hero-dot { background: var(--chart-input); }
  .card-cost .hero-dot { background: var(--accent); }
  .card-days .hero-dot { background: var(--blue); }
  .card-sessions .hero-dot { background: var(--purple); }

  .hero-label {
    font-family: var(--font-sans);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .hero-value {
    font-family: var(--font-numeric);
    font-variant-numeric: tabular-nums;
    font-size: 1.75rem;
    font-weight: 700;
    line-height: 1.2;
    overflow-wrap: anywhere;
    color: var(--text);
    letter-spacing: -0.03em;
  }
  .hero-cost {
    color: var(--accent);
  }

  /* ── Token Breakdown Strip ──────────────────────────────────────────────── */
  .token-breakdown {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }
  .token-item {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 0.875rem 1.125rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    overflow: hidden;
    transition: all 0.16s ease;
  }
  .token-item:hover {
    border-color: var(--border-medium);
  }
  .token-indicator {
    position: absolute;
    top: 0;
    left: 0;
    width: 3px;
    height: 100%;
  }
  .item-input .token-indicator { background: var(--chart-input); }
  .item-output .token-indicator { background: var(--chart-output); }
  .item-cr .token-indicator { background: var(--chart-cache-read); }
  .item-cw .token-indicator { background: var(--chart-cache-write); }

  .token-label {
    font-family: var(--font-sans);
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
  }
  .token-value {
    font-family: var(--font-numeric);
    font-variant-numeric: tabular-nums;
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.01em;
  }

  /* ── 2-Column Grid ──────────────────────────────────────────────────────── */
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.25rem;
  }

  .table-container {
    overflow-x: auto;
  }

  .numeric-head {
    text-align: right;
  }
  .numeric {
    text-align: right;
  }

  .tool-cell {
    display: flex;
    align-items: center;
  }
  .tool-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.175rem 0.5rem;
    border-radius: var(--radius-sm);
    background: var(--raised);
    border: 1px solid var(--border-subtle);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text);
  }

  .font-semibold {
    font-weight: 600;
  }

  .muted {
    color: var(--text-muted);
    font-style: italic;
    font-size: 0.85rem;
    padding: 1.5rem 0;
    text-align: center;
  }

  /* ── Top Tool Calls Ranking List ────────────────────────────────────────── */
  .card-header {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.125rem;
  }
  .card-header .section-title {
    margin-bottom: 0;
  }

  .card-tabs {
    display: flex;
    background: var(--raised);
    padding: 2px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
  }
  .card-tab {
    padding: 0.25rem 0.625rem;
    border: none;
    background: transparent;
    color: var(--text-muted);
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.75rem;
    font-family: var(--font-sans);
    font-weight: 500;
    transition: all 0.16s ease;
  }
  .card-tab:hover {
    color: var(--text);
  }
  .card-tab.active {
    color: var(--accent);
    background: var(--surface);
    font-weight: 600;
    box-shadow: var(--shadow-sm);
  }

  .tc-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .tc-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.875rem;
    border-radius: var(--radius-sm);
    background: var(--raised);
    border: 1px solid transparent;
    transition: all 0.16s cubic-bezier(0.16, 1, 0.3, 1);
    animation: fade 0.25s ease both;
  }
  .tc-row:hover {
    background: var(--hover);
    border-color: var(--border-subtle);
    transform: translateX(2px);
  }

  .tc-rank {
    font-family: var(--font-numeric);
    font-variant-numeric: tabular-nums;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    width: 2.125rem;
    flex-shrink: 0;
  }
  .tc-rank.top-rank {
    color: var(--accent);
    font-weight: 700;
  }

  .tc-name {
    flex: 1;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tc-count {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--accent);
  }

  .loading-spin {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 2px solid var(--border-medium);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-bottom: 0.5rem;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .loading-text {
    font-size: 0.8125rem;
  }

  @keyframes fade {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @media (max-width: 900px) {
    .hero-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .token-breakdown { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .grid-2 { grid-template-columns: 1fr; }
  }

  @media (max-width: 550px) {
    .hero-stats { grid-template-columns: 1fr; }
    .token-breakdown { grid-template-columns: 1fr; }
  }
</style>
