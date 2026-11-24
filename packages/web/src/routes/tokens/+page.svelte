<script>
  import { onDestroy } from 'svelte'
  import { dateRange, selectedDevice, selectedTool, formatTokens } from '$lib/stores.js'
  import { fetchTokens } from '$lib/api.js'
  import { t } from '$lib/i18n.js'
  import DateRangeSelector from '$lib/components/DateRangeSelector.svelte'
  import DeviceSelector from '$lib/components/DeviceSelector.svelte'
  import ToolSelector from '$lib/components/ToolSelector.svelte'
  import SvgTokenChart from '$lib/components/charts/SvgTokenChart.svelte'
  import { createRequestTracker } from '$lib/sessions-paging.js'

  let data = null
  let error = null
  let loading = true
  let chartMode = 'breakdown' // 'breakdown' | 'total'
  const beginRequest = createRequestTracker()
  onDestroy(() => { beginRequest() })

  async function loadData() {
    const isLatest = beginRequest()
    loading = true
    error = null
    try {
      const response = await fetchTokens({ ...$dateRange, device: $selectedDevice, tool: $selectedTool })
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

  function getTotal(d) {
    return d.inputTokens + d.outputTokens + (d.cacheReadTokens || 0) + (d.cacheWriteTokens || 0) + (d.thinkingTokens || 0)
  }

  $: days = data?.data || []
  $: periodTotal = days.reduce((sum, d) => sum + getTotal(d), 0)
  $: periodCacheRead = days.reduce((sum, d) => sum + (d.cacheReadTokens || 0), 0)
  $: dailyAvg = days.length ? Math.round(periodTotal / days.length) : 0
  $: peakDay = days.reduce((best, d) => (!best || getTotal(d) > getTotal(best) ? d : best), null)
  $: cacheHitPct = periodTotal > 0 ? ((periodCacheRead / periodTotal) * 100).toFixed(1) : '0.0'
</script>

<svelte:head>
  <title>{$t('tokens.title')} — AIUsage</title>
</svelte:head>

<div class="page-header">
  <h1>{$t('tokens.title')}</h1>
  <p>{$t('tokens.desc')}</p>
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
  <div class="card">
    <div class="skeleton skeleton-line" style="width: 150px; margin-bottom: 1rem;"></div>
    <div class="skeleton" style="height: 220px;"></div>
  </div>
{:else if error}
  <div class="state-msg error">{error}</div>
{:else if !days.length}
  <div class="state-msg">
    <h2>{$t('tokens.noData')}</h2>
    <p>{$t('tokens.noDataHint')}</p>
  </div>
{:else}
  <div class:is-stale={loading}>
    <div class="kpi-grid">
      <div class="kpi-card">
        <span class="kpi-label">{$t('tokens.total')}</span>
        <span class="kpi-value numeric">{formatTokens(periodTotal)}</span>
        <span class="kpi-sub numeric">{days.length} {$t('common.activeDaysCount')}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">{$t('common.dailyAvg')}</span>
        <span class="kpi-value numeric">{formatTokens(dailyAvg)}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">{$t('common.peakDay')}</span>
        <span class="kpi-value accent numeric">{peakDay ? formatTokens(getTotal(peakDay)) : '—'}</span>
        {#if peakDay}<span class="kpi-sub numeric">{peakDay.date}</span>{/if}
      </div>
      <div class="kpi-card">
        <span class="kpi-label">{$t('common.cacheHit')}</span>
        <span class="kpi-value numeric">{cacheHitPct}%</span>
        <span class="kpi-sub numeric">{formatTokens(periodCacheRead)}</span>
      </div>
    </div>

    <div class="card chart-section">
      <div class="chart-header">
        <div class="section-title">{$t('tokens.chartTitle')}</div>
        <div class="segmented" role="group" aria-label={$t('tokens.chartTitle')}>
          <button
            type="button"
            class="segmented-btn"
            class:active={chartMode === 'breakdown'}
            on:click={() => chartMode = 'breakdown'}
          >{$t('tokens.modeBreakdown')}</button>
          <button
            type="button"
            class="segmented-btn"
            class:active={chartMode === 'total'}
            on:click={() => chartMode = 'total'}
          >{$t('tokens.modeTotal')}</button>
        </div>
      </div>

      <SvgTokenChart {days} mode={chartMode} />
    </div>

    <div class="card table-card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>{$t('tokens.date')}</th>
              <th class="numeric-th">{$t('tokens.input')}</th>
              <th class="numeric-th">{$t('tokens.output')}</th>
              <th class="numeric-th">{$t('tokens.cacheRead')}</th>
              <th class="numeric-th">{$t('tokens.cacheWrite')}</th>
              <th class="numeric-th">{$t('tokens.thinking')}</th>
              <th class="numeric-th">{$t('tokens.total')}</th>
            </tr>
          </thead>
          <tbody>
            {#each days as day (day.date)}
              <tr>
                <td class="numeric font-medium date-cell">{day.date}</td>
                <td class="numeric color-input">{formatTokens(day.inputTokens)}</td>
                <td class="numeric color-output">{formatTokens(day.outputTokens)}</td>
                <td class="numeric color-cr">{formatTokens(day.cacheReadTokens || 0)}</td>
                <td class="numeric color-cw">{formatTokens(day.cacheWriteTokens || 0)}</td>
                <td class="numeric color-thinking">{formatTokens(day.thinkingTokens || 0)}</td>
                <td class="numeric font-bold color-total">
                  {formatTokens(getTotal(day))}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>
{/if}

<style>
  .chart-section {
    margin-bottom: 1.25rem;
  }

  .chart-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 0.875rem;
  }

  .chart-header .section-title {
    margin-bottom: 0;
  }

  .table-card {
    padding: 0;
    overflow: hidden;
  }

  .table-container {
    overflow-x: auto;
  }

  .numeric-th,
  .numeric {
    text-align: right;
  }

  .date-cell {
    text-align: left;
    color: var(--text);
  }

  .font-medium { font-weight: 500; }
  .font-bold { font-weight: 650; }
  .color-input { color: var(--chart-input); font-weight: 500; }
  .color-output { color: var(--chart-output); font-weight: 500; }
  .color-cr { color: var(--chart-cache-read); font-weight: 500; }
  .color-cw { color: var(--chart-cache-write); font-weight: 500; }
  .color-thinking { color: var(--chart-thinking); font-weight: 500; }
  .color-total { color: var(--text); }
</style>
