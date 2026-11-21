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
  import { createRequestTracker } from '$lib/sessions-paging.js'

  let data = null
  let error = null
  let loading = true

  let tooltip = null
  let chartEl = null
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

  function getMaxCost() {
    if (!data?.data.length) return 0
    return Math.max(...data.data.map(d => d.cost))
  }

  function getTotalCost() {
    if (!data?.data.length) return 0
    return data.data.reduce((sum, d) => sum + d.cost, 0)
  }

  function getTopEntries(obj, limit) {
    return Object.entries(obj)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
  }

  function niceScale(max) {
    if (max <= 0) return []
    const magnitude = Math.pow(10, Math.floor(Math.log10(max)))
    let step = magnitude
    if (max / step < 3) step = magnitude / 2
    if (max / step > 6) step = magnitude * 2
    const ticks = []
    for (let v = 0; v <= max; v += step) {
      ticks.push(v)
    }
    if (ticks[ticks.length - 1] < max) {
      ticks.push(ticks[ticks.length - 1] + step)
    }
    return ticks
  }

  function showTooltip(e, day) {
    const rect = chartEl?.getBoundingClientRect()
    if (!rect) return
    tooltip = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      date: day.date,
      cost: day.cost,
    }
  }

  function hideTooltip() {
    tooltip = null
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

{#if loading}
  <div class="state-msg">
    <span class="loading-spin"></span>
    <span class="loading-text">{$t('common.loading')}</span>
  </div>
{:else if error}
  <div class="state-msg error">{error}</div>
{:else if !data?.data.length}
  <div class="state-msg">
    <h2>{$t('cost.noData')}</h2>
    <p>{$t('cost.noDataHint')}</p>
  </div>
{:else}
  {@const max = getMaxCost()}
  {@const ticks = niceScale(max)}
  {@const scaleMax = ticks.length ? ticks[ticks.length - 1] : max}
  
  <div class="hero-card">
    <div class="hero-header">
      <span class="hero-dot"></span>
      <span class="hero-label">{$t('cost.totalCost')}</span>
    </div>
    <span class="hero-value">{formatCost(getTotalCost())}</span>
  </div>

  <div class="provenance-wrap">
    <CostProvenance provenance={data.provenance} />
  </div>

  <div class="card chart-section">
    <div class="section-title">{$t('cost.chartTitle')}</div>
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="chart-area" bind:this={chartEl} on:mouseleave={hideTooltip}>
      <div class="y-axis">
        {#each ticks as tick}
          <div class="y-tick" style="bottom: {scaleMax > 0 ? (tick / scaleMax) * 220 : 0}px">
            <span class="y-label numeric">{formatCost(tick)}</span>
            <span class="y-line"></span>
          </div>
        {/each}
      </div>
      <div class="chart">
        {#each data.data as day, i}
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div
            class="bar-group"
            style="animation-delay: {i * 25}ms"
            on:mouseenter={(e) => showTooltip(e, day)}
            on:mousemove={(e) => showTooltip(e, day)}
          >
            <div
              class="bar"
              style="height: {scaleMax > 0 ? (day.cost / scaleMax) * 220 : 0}px"
            ></div>
            <div class="label numeric">{day.date.slice(5)}</div>
          </div>
        {/each}
      </div>
      {#if tooltip}
        <div class="tooltip" style="left:{tooltip.x}px;top:{tooltip.y}px">
          <div class="tooltip-date numeric">{tooltip.date}</div>
          <div class="tooltip-cost numeric">{formatCost(tooltip.cost)}</div>
        </div>
      {/if}
    </div>
  </div>

  <div class="grid-2">
    <div class="card">
      <div class="section-title">{$t('cost.byTool')}</div>
      <div class="breakdown-list">
        {#each getTopEntries(data.byTool, 10) as [tool, cost], i}
          <div class="breakdown-row" style="animation-delay: {i * 30}ms">
            <span class="tool-tag">{tool}</span>
            <span class="numeric accent font-semibold">{formatCost(cost)}</span>
          </div>
        {/each}
      </div>
    </div>
    <div class="card">
      <div class="section-title">{$t('cost.byModel')}</div>
      <div class="breakdown-list">
        {#each getTopEntries(modelCosts, 10) as [model, cost], i}
          <div class="breakdown-row" style="animation-delay: {i * 30}ms">
            <span class="mono model-name">{model}</span>
            <span class="numeric accent font-semibold">{formatCost(cost)}</span>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Hero Total Cost Card ───────────────────────────────────────────────── */
  .hero-card {
    display: inline-flex;
    flex-direction: column;
    gap: 0.5rem;
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    padding: 1.25rem 2rem;
    margin-bottom: 1.5rem;
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
    background: var(--accent);
  }
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
    font-size: 2rem;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: -0.03em;
  }

  .provenance-wrap {
    margin-bottom: 1.5rem;
  }

  /* ── Cost Chart Section ─────────────────────────────────────────────────── */
  .chart-section {
    margin-bottom: 1.5rem;
    padding-bottom: 1.5rem;
  }

  .chart-area {
    position: relative;
    display: flex;
    padding-bottom: 18px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .y-axis {
    position: relative;
    width: 60px;
    height: 220px;
    flex-shrink: 0;
  }
  .y-tick {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    transform: translateY(50%);
  }
  .y-label {
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
    white-space: nowrap;
    text-align: right;
    flex-shrink: 0;
    width: 54px;
    padding-right: 8px;
  }
  .y-line {
    position: absolute;
    left: 60px;
    right: -9999px;
    height: 1px;
    background: var(--border-subtle);
    opacity: 0.7;
    pointer-events: none;
  }

  .chart {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    height: 220px;
    overflow-x: auto;
    overflow-y: hidden;
    min-width: 0;
    flex: 1;
    padding-left: 4px;
    scrollbar-width: thin;
  }
  .bar-group {
    flex: 0 0 auto;
    min-width: 22px;
    display: flex;
    flex-direction: column;
    align-items: center;
    animation: fade 0.25s ease both;
    cursor: pointer;
    padding: 0 2px;
    border-radius: 4px;
    transition: background-color 0.15s ease;
  }
  .bar-group:hover {
    background-color: var(--hover);
  }
  .bar {
    width: 14px;
    min-height: 2px;
    background: linear-gradient(180deg, var(--accent) 0%, var(--accent-hover) 100%);
    box-shadow: 0 0 8px var(--accent-dim);
    border-radius: 3px 3px 0 0;
    transition: height 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .label {
    font-family: var(--font-numeric);
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
    margin-top: 8px;
  }

  /* ── Modern Tooltip ─────────────────────────────────────────────────────── */
  .tooltip {
    position: absolute;
    pointer-events: none;
    z-index: 50;
    background: var(--surface);
    border: 1px solid var(--border-medium);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.75rem;
    box-shadow: var(--shadow-md);
    transform: translate(-50%, calc(-100% - 12px));
    white-space: nowrap;
    text-align: center;
    backdrop-filter: blur(12px);
    animation: tooltipIn 0.12s ease-out;
  }
  @keyframes tooltipIn {
    from { opacity: 0; transform: translate(-50%, calc(-100% - 8px)); }
    to { opacity: 1; transform: translate(-50%, calc(-100% - 12px)); }
  }
  .tooltip-date {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 0.15rem;
  }
  .tooltip-cost {
    font-size: 0.875rem;
    font-weight: 700;
    color: var(--accent);
  }

  /* ── Breakdown List ─────────────────────────────────────────────────────── */
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.25rem;
  }
  .breakdown-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .breakdown-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 0.875rem;
    border-radius: var(--radius-sm);
    background: var(--raised);
    border: 1px solid transparent;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    transition: all 0.16s ease;
    animation: fade 0.25s ease both;
  }
  .breakdown-row:hover {
    background: var(--hover);
    border-color: var(--border-subtle);
    transform: translateX(2px);
  }

  .tool-tag {
    font-weight: 600;
    color: var(--text);
  }
  .model-name {
    color: var(--text);
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .font-semibold {
    font-weight: 600;
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

  @media (max-width: 800px) {
    .grid-2 { grid-template-columns: 1fr; }
  }
</style>
