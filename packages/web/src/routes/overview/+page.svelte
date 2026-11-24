<script>
  import { onMount, onDestroy } from 'svelte'
  import { dateRange, selectedDevice, selectedTool, formatNumber, formatCost, formatTokens } from '$lib/stores.js'
  import { fetchSummary, refreshData } from '$lib/api.js'
  import { tokenComposition, displayOutputTokens } from '$lib/token-composition.js'
  import { createRequestTracker } from '$lib/sessions-paging.js'
  import { t } from '$lib/i18n.js'
  import DateRangeSelector from '$lib/components/DateRangeSelector.svelte'
  import DeviceSelector from '$lib/components/DeviceSelector.svelte'
  import ToolSelector from '$lib/components/ToolSelector.svelte'

  let data = null
  let error = null
  let loading = true
  let tcTab = 'all'
  let initialized = false
  let destroyed = false
  const beginRequest = createRequestTracker()
  onDestroy(() => { destroyed = true; beginRequest() })

  async function loadData({ showLoading = true } = {}) {
    if (!initialized || destroyed) return
    const isLatest = beginRequest()
    if (showLoading) loading = true
    error = null
    try {
      const response = await fetchSummary({ ...$dateRange, device: $selectedDevice, tool: $selectedTool })
      if (!isLatest() || destroyed) return
      data = response
    } catch (e) {
      if (!isLatest() || destroyed) return
      error = e instanceof Error ? e.message : 'Failed to load data'
      data = null
    } finally {
      if (isLatest() && !destroyed) loading = false
    }
  }

  onMount(async () => {
    // Show existing data first; don't block the page on log parsing (issue #40).
    initialized = true
    await loadData()
    if (destroyed) return
    // Refresh logs in the background, then reload once it completes. The
    // figures already shown stay up while the reload is in flight.
    refreshData().then(() => destroyed ? undefined : loadData({ showLoading: false })).catch(() => {})
  })

  $: $dateRange, $selectedDevice, $selectedTool, loadData()
  $: ({ inputPct, outputPct, cacheReadPct, cacheWritePct } = tokenComposition(data))
  $: outputTotal = displayOutputTokens(data)
  $: toolEntries = data?.byTool
    ? Object.entries(data.byTool).sort(([, a], [, b]) => b.tokens - a.tokens)
    : []
  $: maxToolTokens = toolEntries.length ? Math.max(...toolEntries.map(([, s]) => s.tokens || 0), 1) : 1
  $: maxTcCount = data?.topToolCalls?.length ? Math.max(...data.topToolCalls.map((c) => c.count || 0), 1) : 1
  $: maxMcpCount = data?.topMcpServers?.length ? Math.max(...data.topMcpServers.map((s) => s.count || 0), 1) : 1
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

{#if loading && !data}
  <div class="kpi-grid">
    {#each [1, 2, 3, 4] as _}
      <div class="kpi-card">
        <div class="skeleton skeleton-line" style="width: 45%;"></div>
        <div class="skeleton skeleton-value"></div>
      </div>
    {/each}
  </div>
  <div class="card" style="margin-bottom: 1.25rem;">
    <div class="skeleton skeleton-line" style="width: 140px; margin-bottom: 1rem;"></div>
    <div class="skeleton" style="height: 8px; margin-bottom: 1rem;"></div>
    <div class="skeleton skeleton-line" style="width: 65%;"></div>
  </div>
{:else if error}
  <div class="state-msg error">{error}</div>
{:else if !data || data.totalTokens === 0}
  <div class="state-msg">
    <h2>{$t('common.noData')}</h2>
    <p>{$t('common.noDataHint')}</p>
  </div>
{:else}
  <div class:is-stale={loading}>
    <div class="kpi-grid">
      <div class="kpi-card">
        <span class="kpi-label">{$t('overview.totalTokens')}</span>
        <span class="kpi-value numeric">{formatTokens(data.totalTokens)}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">{$t('overview.totalCost')}</span>
        <span class="kpi-value accent numeric">{$formatCost(data.totalCost)}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">{$t('overview.activeDays')}</span>
        <span class="kpi-value numeric">{data.activeDays}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">{$t('overview.totalSessions')}</span>
        <span class="kpi-value numeric">{formatNumber(data.totalSessions || 0)}</span>
      </div>
    </div>

    <div class="card breakdown-card">
      <div class="breakdown-head">
        <span class="section-title">{$t('home.composition')}</span>
        <span class="breakdown-total numeric">{formatTokens(data.totalTokens)}</span>
      </div>
      <div class="comp-bar" aria-hidden="true">
        {#if inputPct > 0}<div class="seg seg-input" style="width: {inputPct}%"></div>{/if}
        {#if outputPct > 0}<div class="seg seg-output" style="width: {outputPct}%"></div>{/if}
        {#if cacheReadPct > 0}<div class="seg seg-cr" style="width: {cacheReadPct}%"></div>{/if}
        {#if cacheWritePct > 0}<div class="seg seg-cw" style="width: {cacheWritePct}%"></div>{/if}
      </div>
      <div class="token-breakdown-grid">
        <div class="token-cell">
          <div class="token-cell-head">
            <span class="swatch seg-input"></span>
            <span class="token-label">{$t('overview.inputTokens')}</span>
            <span class="token-pct numeric">{inputPct.toFixed(1)}%</span>
          </div>
          <span class="token-value numeric">{formatTokens(data.inputTokens)}</span>
        </div>
        <div class="token-cell">
          <div class="token-cell-head">
            <span class="swatch seg-output"></span>
            <span class="token-label">{$t('overview.outputWithThinking')}</span>
            <span class="token-pct numeric">{outputPct.toFixed(1)}%</span>
          </div>
          <span class="token-value numeric">{formatTokens(outputTotal)}</span>
        </div>
        <div class="token-cell">
          <div class="token-cell-head">
            <span class="swatch seg-cr"></span>
            <span class="token-label">{$t('overview.cacheRead')}</span>
            <span class="token-pct numeric">{cacheReadPct.toFixed(1)}%</span>
          </div>
          <span class="token-value numeric">{formatTokens(data.cacheReadTokens)}</span>
        </div>
        <div class="token-cell">
          <div class="token-cell-head">
            <span class="swatch seg-cw"></span>
            <span class="token-label">{$t('overview.cacheWrite')}</span>
            <span class="token-pct numeric">{cacheWritePct.toFixed(1)}%</span>
          </div>
          <span class="token-value numeric">{formatTokens(data.cacheWriteTokens)}</span>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="section-title">{$t('overview.byTool')}</div>
        {#if toolEntries.length === 0}
          <p class="empty-inline">{$t('overview.noToolData')}</p>
        {:else}
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>{$t('overview.tool')}</th>
                  <th class="bar-head"></th>
                  <th class="numeric-head">{$t('overview.tokens')}</th>
                  <th class="numeric-head">{$t('overview.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {#each toolEntries as [tool, stats]}
                  <tr>
                    <td><span class="tool-badge">{tool}</span></td>
                    <td class="share-cell">
                      <div class="mini-track" aria-hidden="true">
                        <div class="mini-fill" style="width: {((stats.tokens || 0) / maxToolTokens) * 100}%"></div>
                      </div>
                    </td>
                    <td class="numeric">{formatTokens(stats.tokens)}</td>
                    <td class="numeric accent font-semibold">{$formatCost(stats.cost)}</td>
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
          <div class="segmented" role="group">
            <button type="button" class="segmented-btn" class:active={tcTab === 'all'} on:click={() => tcTab = 'all'}>
              {$t('overview.tabAll')}
            </button>
            <button type="button" class="segmented-btn" class:active={tcTab === 'mcp'} on:click={() => tcTab = 'mcp'}>
              {$t('overview.tabMcp')}
            </button>
          </div>
        </div>
        {#if tcTab === 'all'}
          {#if data.topToolCalls.length === 0}
            <p class="empty-inline">{$t('overview.noToolCalls')}</p>
          {:else}
            <div class="tc-list">
              {#each data.topToolCalls as tc, i}
                <div class="tc-row">
                  <div class="tc-fill" style="width: {(tc.count / maxTcCount) * 100}%"></div>
                  <span class="tc-rank numeric" class:top-rank={i < 3}>{String(i + 1).padStart(2, '0')}</span>
                  <span class="tc-name mono">{tc.name}</span>
                  <span class="tc-count numeric">{formatNumber(tc.count)}</span>
                </div>
              {/each}
            </div>
          {/if}
        {:else}
          {#if !data.topMcpServers?.length}
            <p class="empty-inline">{$t('overview.noMcpCalls')}</p>
          {:else}
            <div class="tc-list">
              {#each data.topMcpServers as srv, i}
                <div class="tc-row">
                  <div class="tc-fill" style="width: {(srv.count / maxMcpCount) * 100}%"></div>
                  <span class="tc-rank numeric" class:top-rank={i < 3}>{String(i + 1).padStart(2, '0')}</span>
                  <span class="tc-name mono">{srv.server}</span>
                  <span class="tc-count numeric">{formatNumber(srv.count)}</span>
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Consolidated Token Breakdown Card ──────────────────────────────────── */
  .breakdown-card {
    margin-bottom: 1.25rem;
  }

  .breakdown-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }

  .breakdown-head .section-title {
    margin-bottom: 0;
  }

  .breakdown-total {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-muted);
  }

  .comp-bar {
    display: flex;
    height: 8px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--raised);
    gap: 2px;
  }

  .seg {
    height: 100%;
    min-width: 2px;
    transition: width 0.5s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .seg-input  { background: var(--chart-input); }
  .seg-output { background: var(--chart-output); }
  .seg-cr     { background: var(--chart-cache-read); }
  .seg-cw     { background: var(--chart-cache-write); }

  .token-breakdown-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.75rem;
    margin-top: 0.875rem;
    padding-top: 0.875rem;
    border-top: 1px solid var(--border-subtle);
  }

  .token-cell {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .token-cell-head {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .swatch {
    width: 7px;
    height: 7px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .token-label {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .token-pct {
    margin-left: auto;
    font-size: var(--text-2xs);
    color: var(--text-muted);
  }

  .token-value {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--text);
  }

  /* ── 2-Column Grid ──────────────────────────────────────────────────────── */
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  .table-container {
    overflow-x: auto;
  }

  .numeric-head,
  .numeric {
    text-align: right;
  }

  .bar-head {
    width: 28%;
  }

  .share-cell {
    width: 28%;
    min-width: 64px;
  }

  .mini-track {
    height: 5px;
    border-radius: 3px;
    background: var(--raised);
    overflow: hidden;
  }

  .mini-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
    transition: width 0.35s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .tool-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.125rem 0.45rem;
    border-radius: var(--radius-xs);
    background: var(--raised);
    border: 1px solid var(--border-subtle);
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text);
  }

  .font-semibold { font-weight: 600; }

  .empty-inline {
    color: var(--text-muted);
    font-size: var(--text-sm);
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
    margin-bottom: 0.875rem;
  }

  .card-header .section-title {
    margin-bottom: 0;
  }

  .tc-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .tc-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.45rem 0.65rem;
    border-radius: var(--radius-xs);
    overflow: hidden;
    transition: background-color 0.12s ease;
  }

  .tc-row:hover {
    background: var(--hover);
  }

  .tc-fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    background: var(--raised);
    z-index: 0;
    pointer-events: none;
    transition: width 0.35s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .tc-rank,
  .tc-name,
  .tc-count {
    position: relative;
    z-index: 1;
  }

  .tc-rank {
    font-size: var(--text-2xs);
    font-weight: 600;
    color: var(--text-muted);
    width: 1.5rem;
    flex-shrink: 0;
  }

  .tc-rank.top-rank {
    color: var(--accent);
    font-weight: 700;
  }

  .tc-name {
    flex: 1;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tc-count {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-secondary);
  }

  @media (max-width: 960px) {
    .token-breakdown-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .grid-2 { grid-template-columns: 1fr; }
  }

  @media (max-width: 550px) {
    .token-breakdown-grid { grid-template-columns: 1fr; }
  }
</style>
