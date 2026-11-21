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

{#if loading}
  <div class="card state-msg">
    <span class="loading-spin"></span>
    <span>{$t('common.loading')}</span>
  </div>
{:else if error}
  <div class="card state-msg error">{error}</div>
{:else if !data?.models.length}
  <div class="card state-msg">
    <h2>{$t('models.noData')}</h2>
    <p>{$t('models.noDataHint')}</p>
  </div>
{:else}
  <div class="card chart-card">
    <div class="chart-header">
      <div class="section-title">{$t('models.chartTitle')}</div>
      <div class="mode-toggle" role="group" aria-label={$t('models.chartTitle')}>
        <button
          class="mode-btn"
          class:active={chartMode === 'tokens'}
          aria-pressed={chartMode === 'tokens'}
          on:click={() => chartMode = 'tokens'}
        >{$t('models.modeTokens')}</button>
        <button
          class="mode-btn"
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
      {#each sortedModels as model, i (JSON.stringify([model.model, model.provider]))}
        <div class="model-row animate-row" style="animation-delay: {i * 25}ms">
          <div class="model-meta">
            <span class="mono model-name" title={model.originalModels.join('\n')}>{model.model}</span>
            <span class="model-provider">{model.provider}</span>
          </div>

          <div class="bar-area">
            <div class="bar-track">
              {#if chartMode === 'tokens'}
                {#each getStackedSegments(model) as seg}
                  <div class="stack-seg {seg.cls}" style="width: {seg.w}%"></div>
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
    padding: 1.5rem;
  }
  /* ── Header ── */
  .chart-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1rem;
  }
  .chart-header .section-title { margin-bottom: 0; }
  .mode-toggle {
    display: flex;
    gap: 2px;
    background: var(--raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 2px;
  }
  .mode-btn {
    font-family: var(--font-sans);
    font-size: 0.75rem;
    font-weight: 500;
    padding: 0.25rem 0.75rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.16s ease;
  }
  .mode-btn:hover { color: var(--text); }
  .mode-btn.active {
    background: var(--surface);
    color: var(--accent);
    font-weight: 600;
    box-shadow: var(--shadow-sm);
  }

  /* ── Legend ── */
  .comp-legend {
    display: flex;
    gap: 1.25rem;
    margin-bottom: 1.25rem;
    flex-wrap: wrap;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .leg {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-family: var(--font-sans);
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-secondary);
  }
  .leg-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
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
    gap: 0.5rem;
  }
  .model-row {
    display: grid;
    grid-template-columns: minmax(0, 190px) minmax(0, 1fr) auto;
    gap: 1rem 1.5rem;
    align-items: center;
    padding: 0.875rem 1rem;
    border-radius: var(--radius-sm);
    background: var(--raised);
    border: 1px solid transparent;
    transition: all 0.16s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .model-row:hover {
    background: var(--hover);
    border-color: var(--border-subtle);
    transform: translateX(2px);
  }

  .model-meta {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }
  .model-name {
    font-size: 0.8125rem;
    font-weight: 700;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: -0.01em;
  }
  .model-provider {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  /* ── Bar area ── */
  .bar-area {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-rows: auto auto;
    gap: 0.35rem 0.875rem;
    align-items: center;
    min-width: 0;
  }
  .bar-track {
    display: flex;
    height: 7px;
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    overflow: hidden;
    min-width: 0;
  }
  .bar-value {
    font-family: var(--font-numeric);
    font-size: 0.875rem;
    font-weight: 700;
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
    font-size: 0.75rem;
    font-weight: 500;
  }
  .leg-i-val { color: var(--chart-input); }
  .leg-o-val { color: var(--chart-output); }
  .leg-cr-val { color: var(--chart-cache-read); }
  .leg-cw-val { color: var(--chart-cache-write); }
  .leg-thinking-val { color: var(--chart-thinking); }

  .ranking-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent) 0%, var(--accent-hover) 100%);
    box-shadow: 0 0 6px var(--accent-dim);
    transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .stack-seg {
    height: 100%;
    flex-shrink: 0;
    transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .seg-input    { background: var(--chart-input); }
  .seg-output   { background: var(--chart-output); }
  .seg-cr       { background: var(--chart-cache-read); }
  .seg-cw       { background: var(--chart-cache-write); }
  .seg-thinking { background: var(--chart-thinking); }

  /* ── Stats ── */
  .model-stats {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    align-items: flex-end;
  }
  .stat-item {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
  }
  .stat-label {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .stat-value {
    font-family: var(--font-numeric);
    font-size: 0.8125rem;
    color: var(--text);
  }
  .font-bold { font-weight: 700; }
  .font-medium { font-weight: 500; }

  .animate-row {
    animation: fadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .loading-spin {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 2px solid var(--border-medium);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-right: 0.5rem;
    vertical-align: middle;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (max-width: 800px) {
    .chart-header { flex-direction: column; align-items: stretch; }
    .mode-toggle { width: fit-content; }
    .model-row {
      grid-template-columns: 1fr auto;
      grid-template-rows: auto auto;
    }
    .bar-area { grid-column: 1 / -1; }
    .model-stats { flex-direction: row; gap: 0.75rem; align-items: center; }
  }
</style>
