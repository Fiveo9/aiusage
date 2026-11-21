<script>
  import { dateRange, selectedDevice, selectedTool, modelDisplayMode, formatTokens, formatNumber, formatCost } from '$lib/stores.js'
  import { fetchModels } from '$lib/api.js'
  import { groupModels } from '$lib/model-display.js'
  import { t } from '$lib/i18n.js'
  import DateRangeSelector from '$lib/components/DateRangeSelector.svelte'
  import DeviceSelector from '$lib/components/DeviceSelector.svelte'
  import ToolSelector from '$lib/components/ToolSelector.svelte'
  import ModelDisplaySelector from '$lib/components/ModelDisplaySelector.svelte'

  let data = null
  let error = null
  let loading = true
  let chartMode = 'tokens'

  async function loadData() {
    loading = true
    error = null
    try {
      data = await fetchModels({ ...$dateRange, device: $selectedDevice, tool: $selectedTool })
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load data'
      data = null
    } finally {
      loading = false
    }
  }

  $: $dateRange, $selectedDevice, $selectedTool, loadData()

  $: sortedModels = groupModels(data?.models || [], $modelDisplayMode).sort((a, b) => {
    if (chartMode === 'cost') return b.totalCost - a.totalCost
    return b.totalTokens - a.totalTokens
  })

  $: maxMetricValue = sortedModels.length
    ? Math.max(...sortedModels.map(model => chartMode === 'cost' ? model.totalCost : model.totalTokens))
    : 0

  function getChartValue(model) {
    return chartMode === 'cost' ? model.totalCost : model.totalTokens
  }

  function getChartWidth(model) {
    const value = getChartValue(model)
    return maxMetricValue > 0 ? (value / maxMetricValue) * 100 : 0
  }

  function formatChartValue(model) {
    return chartMode === 'cost' ? formatCost(model.totalCost) : formatTokens(model.totalTokens)
  }

  function formatPercentage(value) {
    return `${Number(value || 0).toFixed(1)}%`
  }

  function getStackedSegments(model) {
    const max = maxMetricValue || 1
    return [
      { cls: 'seg-input',    w: (model.inputTokens || 0) / max * 100 },
      { cls: 'seg-output',   w: (model.outputTokens || 0) / max * 100 },
      { cls: 'seg-cr',       w: (model.cacheReadTokens || 0) / max * 100 },
      { cls: 'seg-cw',       w: (model.cacheWriteTokens || 0) / max * 100 },
      { cls: 'seg-thinking', w: (model.thinkingTokens || 0) / max * 100 },
    ]
  }
</script>

<svelte:head>
  <title>{$t('models.title')} — AIUsage</title>
</svelte:head>

<div class="page-header">
  <h1>{$t('models.title')}</h1>
  <p>{$t('models.desc')}</p>
</div>

<div class="filter-bar">
  <DateRangeSelector />
  <DeviceSelector />
  <ToolSelector />
  <ModelDisplaySelector />
</div>

{#if loading && !data}
  <div class="card">
    <div class="skeleton skeleton-line" style="width: 140px; margin-bottom: 1rem;"></div>
    {#each [1, 2, 3, 4] as _}
      <div class="skeleton" style="height: 52px; margin-bottom: 0.5rem;"></div>
    {/each}
  </div>
{:else if error}
  <div class="card state-msg error">{error}</div>
{:else if !data?.models.length}
  <div class="card state-msg">
    <h2>{$t('models.noData')}</h2>
    <p>{$t('models.noDataHint')}</p>
  </div>
{:else}
  <div class="card chart-card" class:is-stale={loading}>
    <div class="chart-header">
      <div class="section-title">{$t('models.chartTitle')}</div>
      <div class="segmented" role="group" aria-label={$t('models.chartTitle')}>
        <button
          type="button"
          class="segmented-btn"
          class:active={chartMode === 'tokens'}
          aria-pressed={chartMode === 'tokens'}
          on:click={() => chartMode = 'tokens'}
        >{$t('models.modeTokens')}</button>
        <button
          type="button"
          class="segmented-btn"
          class:active={chartMode === 'cost'}
          aria-pressed={chartMode === 'cost'}
          on:click={() => chartMode = 'cost'}
        >{$t('models.modeCost')}</button>
      </div>
    </div>

    {#if chartMode === 'tokens'}
      <div class="comp-legend">
        <span class="leg leg-i"><span class="leg-dot"></span>{$t('models.input')}</span>
        <span class="leg leg-o"><span class="leg-dot"></span>{$t('models.output')}</span>
        <span class="leg leg-cr"><span class="leg-dot"></span>{$t('models.cacheRead')}</span>
        <span class="leg leg-cw"><span class="leg-dot"></span>{$t('models.cacheWrite')}</span>
        <span class="leg leg-thinking"><span class="leg-dot"></span>{$t('models.thinking')}</span>
      </div>
    {/if}

    <div class="model-list">
      {#each sortedModels as model (JSON.stringify([model.model, model.provider]))}
        <div class="model-row">
          <div class="model-meta">
            <span class="mono model-name" title={model.originalModels.join('\n')}>{model.model}</span>
            <span class="model-provider">{model.provider}</span>
          </div>

          <div class="bar-area">
            <div class="bar-track">
              {#if chartMode === 'tokens'}
                {#each getStackedSegments(model) as seg}
                  {#if seg.w > 0}
                    <div class="stack-seg {seg.cls}" style="width: {seg.w}%"></div>
                  {/if}
                {/each}
              {:else}
                <div class="ranking-bar-fill" style="width: {getChartWidth(model)}%"></div>
              {/if}
            </div>
            <span class="numeric bar-value">{formatChartValue(model)}</span>
            {#if chartMode === 'tokens'}
              <div class="token-breakdown">
                <span class="numeric leg-i-val">{formatTokens(model.inputTokens)}</span>
                <span class="numeric leg-o-val">{formatTokens(model.outputTokens)}</span>
                {#if model.cacheReadTokens}
                  <span class="numeric leg-cr-val">{formatTokens(model.cacheReadTokens)}</span>
                {/if}
                {#if model.cacheWriteTokens}
                  <span class="numeric leg-cw-val">{formatTokens(model.cacheWriteTokens)}</span>
                {/if}
                {#if model.thinkingTokens}
                  <span class="numeric leg-thinking-val">{formatTokens(model.thinkingTokens)}</span>
                {/if}
              </div>
            {/if}
          </div>

          <div class="model-stats">
            <span class="stat-item">
              <span class="stat-label">{$t('models.cost')}</span>
              <span class="numeric stat-value accent font-bold">{formatCost(model.totalCost)}</span>
            </span>
            <span class="stat-item">
              <span class="stat-label">{$t('models.calls')}</span>
              <span class="numeric stat-value">{formatNumber(model.callCount)}</span>
            </span>
            <span class="stat-item">
              <span class="stat-label">{$t('models.share')}</span>
              <span class="numeric stat-value font-medium">{formatPercentage(model.percentage)}</span>
            </span>
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .chart-card {
    padding: 1.25rem;
  }

  .chart-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.875rem;
  }

  .chart-header .section-title {
    margin-bottom: 0;
  }

  .comp-legend {
    display: flex;
    gap: 0.5rem 1rem;
    margin-bottom: 0.875rem;
    flex-wrap: wrap;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .leg {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-secondary);
  }

  .leg-dot {
    width: 7px;
    height: 7px;
    border-radius: 2px;
  }

  .leg-i .leg-dot        { background: var(--chart-input); }
  .leg-o .leg-dot        { background: var(--chart-output); }
  .leg-cr .leg-dot       { background: var(--chart-cache-read); }
  .leg-cw .leg-dot       { background: var(--chart-cache-write); }
  .leg-thinking .leg-dot { background: var(--chart-thinking); }

  /* ── Model rows ── */
  .model-list {
    display: flex;
    flex-direction: column;
  }

  .model-row {
    display: grid;
    grid-template-columns: minmax(0, 200px) minmax(0, 1fr) auto;
    gap: 0.75rem 1.25rem;
    align-items: center;
    padding: 0.75rem 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
    transition: background-color 0.12s ease;
  }

  .model-row:last-child {
    border-bottom: none;
  }

  .model-row:hover {
    background: var(--hover);
  }

  .model-meta {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .model-name {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .model-provider {
    font-size: var(--text-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .bar-area {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-rows: auto auto;
    gap: 0.35rem 0.75rem;
    align-items: center;
    min-width: 0;
  }

  .bar-track {
    display: flex;
    height: 6px;
    background: var(--raised);
    border-radius: 3px;
    overflow: hidden;
    min-width: 0;
  }

  .bar-value {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    text-align: right;
  }

  .token-breakdown {
    grid-column: 1 / -1;
    display: flex;
    gap: 0.625rem;
    flex-wrap: wrap;
  }

  .token-breakdown span {
    font-size: var(--text-2xs);
    font-weight: 500;
  }

  .leg-i-val { color: var(--chart-input); }
  .leg-o-val { color: var(--chart-output); }
  .leg-cr-val { color: var(--chart-cache-read); }
  .leg-cw-val { color: var(--chart-cache-write); }
  .leg-thinking-val { color: var(--chart-thinking); }

  .ranking-bar-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.35s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .stack-seg {
    height: 100%;
    flex-shrink: 0;
    transition: width 0.35s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .seg-input    { background: var(--chart-input); }
  .seg-output   { background: var(--chart-output); }
  .seg-cr       { background: var(--chart-cache-read); }
  .seg-cw       { background: var(--chart-cache-write); }
  .seg-thinking { background: var(--chart-thinking); }

  .model-stats {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    align-items: flex-end;
    min-width: 6.5rem;
  }

  .stat-item {
    display: flex;
    gap: 0.45rem;
    align-items: baseline;
  }

  .stat-label {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .stat-value {
    font-size: var(--text-xs);
    color: var(--text);
  }

  .font-bold { font-weight: 650; }
  .font-medium { font-weight: 500; }

  @media (max-width: 800px) {
    .chart-header { flex-direction: column; align-items: stretch; }
    .model-row {
      grid-template-columns: 1fr auto;
      grid-template-rows: auto auto;
    }
    .bar-area { grid-column: 1 / -1; }
    .model-stats { flex-direction: row; gap: 0.75rem; align-items: center; }
  }
</style>
