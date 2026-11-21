<script>
  import { onDestroy } from 'svelte'
  import { dateRange, selectedDevice, selectedTool, modelDisplayMode, formatCost } from '$lib/stores.js'
  import { fetchCost } from '$lib/api.js'
  import { groupModelCosts } from '$lib/model-display.js'
  import { t } from '$lib/i18n.js'
  import DateRangeSelector from '$lib/components/DateRangeSelector.svelte'
  import DeviceSelector from '$lib/components/DeviceSelector.svelte'
  import ToolSelector from '$lib/components/ToolSelector.svelte'
  import ModelDisplaySelector from '$lib/components/ModelDisplaySelector.svelte'
  import CostProvenance from '$lib/components/CostProvenance.svelte'
  import SvgCostChart from '$lib/components/charts/SvgCostChart.svelte'
  import { createRequestTracker } from '$lib/sessions-paging.js'

  let data = null
  let error = null
  let loading = true

  const beginRequest = createRequestTracker()
  onDestroy(() => { beginRequest() })

  async function loadData() {
    const isLatest = beginRequest()
    loading = true
    error = null
    try {
      const response = await fetchCost({ ...$dateRange, device: $selectedDevice, tool: $selectedTool })
      if (!isLatest()) return
      data = response
    } catch (e) {
      if (!isLatest()) return
      error = e instanceof Error ? e.message : 'Failed to load data'
      data = null
    } finally {
      if (isLatest()) loading = false
    }
  }

  $: $dateRange, $selectedDevice, $selectedTool, loadData()
  $: modelCosts = groupModelCosts(data?.byModel || {}, $modelDisplayMode)
  $: days = data?.data || []
  $: totalCost = getTotalCost()
  $: dailyAvg = days.length ? totalCost / days.length : 0
  $: peakDay = getPeakDay(days)

  function getTotalCost() {
    if (!data?.data.length) return 0
    return data.data.reduce((sum, d) => sum + d.cost, 0)
  }

  function getPeakDay(list) {
    if (!list?.length) return null
    return list.reduce((best, d) => (!best || d.cost > best.cost ? d : best), null)
  }

  function getTopEntries(obj, limit) {
    return Object.entries(obj)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
  }

  function getMaxEntryValue(entries) {
    if (!entries.length) return 1
    return Math.max(...entries.map(([, v]) => v), 0.0001)
  }
</script>

<svelte:head>
  <title>{$t('cost.title')} — AIUsage</title>
</svelte:head>

<div class="page-header">
  <h1>{$t('cost.title')}</h1>
  <p>{$t('cost.desc')}</p>
</div>

<div class="filter-bar">
  <DateRangeSelector />
  <DeviceSelector />
  <ToolSelector />
  <ModelDisplaySelector />
</div>

{#if loading && !data}
  <div class="kpi-grid kpi-grid-3">
    {#each [1, 2, 3] as _}
      <div class="kpi-card">
        <div class="skeleton skeleton-line" style="width: 45%;"></div>
        <div class="skeleton skeleton-value"></div>
      </div>
    {/each}
  </div>
  <div class="card">
    <div class="skeleton skeleton-line" style="width: 140px; margin-bottom: 1rem;"></div>
    <div class="skeleton" style="height: 220px;"></div>
  </div>
{:else if error}
  <div class="state-msg error">{error}</div>
{:else if !days.length}
  <div class="state-msg">
    <h2>{$t('cost.noData')}</h2>
    <p>{$t('cost.noDataHint')}</p>
  </div>
{:else}
  {@const toolEntries = getTopEntries(data.byTool || {}, 10)}
  {@const maxToolCost = getMaxEntryValue(toolEntries)}
  {@const modelEntries = getTopEntries(modelCosts || {}, 10)}
  {@const maxModelCost = getMaxEntryValue(modelEntries)}

  <div class:is-stale={loading}>
    <div class="kpi-grid kpi-grid-3">
      <div class="kpi-card">
        <span class="kpi-label">{$t('cost.totalCost')}</span>
        <span class="kpi-value accent numeric">{formatCost(totalCost)}</span>
        <span class="kpi-sub numeric">{days.length} {$t('common.activeDaysCount')}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">{$t('common.dailyAvg')}</span>
        <span class="kpi-value numeric">{formatCost(dailyAvg)}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">{$t('common.peakDay')}</span>
        <span class="kpi-value numeric">{peakDay ? formatCost(peakDay.cost) : '—'}</span>
        {#if peakDay}<span class="kpi-sub numeric">{peakDay.date}</span>{/if}
      </div>
    </div>

    <div class="provenance-wrap">
      <CostProvenance provenance={data.provenance} />
    </div>

    <div class="card chart-section">
      <div class="section-title">{$t('cost.chartTitle')}</div>
      <SvgCostChart {days} {totalCost} />
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="section-title">{$t('cost.byTool')}</div>
        <div class="breakdown-list">
          {#each toolEntries as [tool, cost]}
            <div class="breakdown-row">
              <div class="breakdown-fill" style="width: {(cost / maxToolCost) * 100}%"></div>
              <span class="tool-tag">{tool}</span>
              <span class="row-right">
                {#if totalCost > 0}
                  <span class="row-share numeric">{((cost / totalCost) * 100).toFixed(1)}%</span>
                {/if}
                <span class="numeric accent font-semibold row-val">{formatCost(cost)}</span>
              </span>
            </div>
          {/each}
        </div>
      </div>

      <div class="card">
        <div class="section-title">{$t('cost.byModel')}</div>
        <div class="breakdown-list">
          {#each modelEntries as [model, cost]}
            <div class="breakdown-row">
              <div class="breakdown-fill" style="width: {(cost / maxModelCost) * 100}%"></div>
              <span class="mono model-name" title={model}>{model}</span>
              <span class="row-right">
                {#if totalCost > 0}
                  <span class="row-share numeric">{((cost / totalCost) * 100).toFixed(1)}%</span>
                {/if}
                <span class="numeric accent font-semibold row-val">{formatCost(cost)}</span>
              </span>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .provenance-wrap {
    margin-bottom: 1.25rem;
  }

  .chart-section {
    margin-bottom: 1.25rem;
  }

  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  .breakdown-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .breakdown-row {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.5rem 0.65rem;
    border-radius: var(--radius-xs);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    overflow: hidden;
    transition: background-color 0.12s ease;
  }

  .breakdown-row:hover {
    background: var(--hover);
  }

  .breakdown-fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    background: var(--raised);
    z-index: 0;
    pointer-events: none;
    transition: width 0.35s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .tool-tag,
  .model-name,
  .row-right {
    position: relative;
    z-index: 1;
  }

  .tool-tag {
    font-weight: 600;
    color: var(--text);
  }

  .model-name {
    color: var(--text);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .row-right {
    display: inline-flex;
    align-items: baseline;
    gap: 0.625rem;
    flex-shrink: 0;
  }

  .row-share {
    font-size: var(--text-2xs);
    color: var(--text-muted);
  }

  .row-val {
    min-width: 4.25rem;
    text-align: right;
  }

  .font-semibold {
    font-weight: 600;
  }

  @media (max-width: 800px) {
    .grid-2 { grid-template-columns: 1fr; }
  }
</style>
