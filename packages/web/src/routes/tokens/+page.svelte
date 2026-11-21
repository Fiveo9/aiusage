<script>
  import { dateRange, selectedDevice, selectedTool, formatTokens } from '$lib/stores.js'
  import { fetchTokens } from '$lib/api.js'
  import { t } from '$lib/i18n.js'
  import DateRangeSelector from '$lib/components/DateRangeSelector.svelte'
  import DeviceSelector from '$lib/components/DeviceSelector.svelte'
  import ToolSelector from '$lib/components/ToolSelector.svelte'

  let data = null
  let error = null
  let loading = true
  let chartMode = 'breakdown' // 'breakdown' | 'total'

  let tooltip = null  // { x, y, lines }
  let chartEl = null

  async function loadData() {
    loading = true
    error = null
    try {
      data = await fetchTokens({ ...$dateRange, device: $selectedDevice, tool: $selectedTool })
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load data'
      data = null
    } finally {
      loading = false
    }
  }

  $: $dateRange, $selectedDevice, $selectedTool, loadData()

  function getTotal(d) {
    return d.inputTokens + d.outputTokens + (d.cacheReadTokens || 0) + (d.cacheWriteTokens || 0) + (d.thinkingTokens || 0)
  }

  function getMaxTokens() {
    if (!data?.data.length) return 0
    return Math.max(...data.data.map(d => getTotal(d)))
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
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const lines = []
    if (chartMode === 'total') {
      lines.push({ label: day.date, value: formatTokens(getTotal(day)), color: null })
    } else {
      lines.push({ label: day.date, value: '', color: null })
      lines.push({ label: $t('tokens.input'), value: formatTokens(day.inputTokens), color: 'var(--chart-input)' })
      lines.push({ label: $t('tokens.output'), value: formatTokens(day.outputTokens), color: 'var(--chart-output)' })
      if (day.cacheReadTokens) lines.push({ label: $t('tokens.cacheRead'), value: formatTokens(day.cacheReadTokens), color: 'var(--chart-cache-read)' })
      if (day.cacheWriteTokens) lines.push({ label: $t('tokens.cacheWrite'), value: formatTokens(day.cacheWriteTokens), color: 'var(--chart-cache-write)' })
      if (day.thinkingTokens) lines.push({ label: $t('tokens.thinking'), value: formatTokens(day.thinkingTokens), color: 'var(--chart-thinking)' })
      lines.push({ label: $t('tokens.total'), value: formatTokens(getTotal(day)), color: null, bold: true })
    }
    tooltip = { x, y, lines }
  }

  function hideTooltip() {
    tooltip = null
  }
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

{#if loading}
  <div class="state-msg">
    <span class="loading-spin"></span>
    <span class="loading-text">{$t('common.loading')}</span>
  </div>
{:else if error}
  <div class="state-msg error">{error}</div>
{:else if !data?.data.length}
  <div class="state-msg">
    <h2>{$t('tokens.noData')}</h2>
    <p>{$t('tokens.noDataHint')}</p>
  </div>
{:else}
  {@const max = getMaxTokens()}
  {@const ticks = niceScale(max)}
  {@const scaleMax = ticks.length ? ticks[ticks.length - 1] : max}
  <div class="card chart-section">
    <div class="chart-header">
      <div class="section-title">{$t('tokens.chartTitle')}</div>
      <div class="mode-toggle">
        <button
          class="mode-btn"
          class:active={chartMode === 'breakdown'}
          on:click={() => chartMode = 'breakdown'}
        >{$t('tokens.modeBreakdown')}</button>
        <button
          class="mode-btn"
          class:active={chartMode === 'total'}
          on:click={() => chartMode = 'total'}
        >{$t('tokens.modeTotal')}</button>
      </div>
    </div>
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="chart-area" bind:this={chartEl} on:mouseleave={hideTooltip}>
      <div class="y-axis">
        {#each ticks as tick}
          <div class="y-tick" style="bottom: {scaleMax > 0 ? (tick / scaleMax) * 220 : 0}px">
            <span class="y-label numeric">{formatTokens(tick)}</span>
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
            <div class="bars">
              {#if chartMode === 'total'}
                <div
                  class="bar total-bar"
                  style="height: {scaleMax > 0 ? (getTotal(day) / scaleMax) * 220 : 0}px"
                ></div>
              {:else}
                <div
                  class="bar input"
                  style="height: {scaleMax > 0 ? (day.inputTokens / scaleMax) * 220 : 0}px"
                ></div>
                <div
                  class="bar output"
                  style="height: {scaleMax > 0 ? (day.outputTokens / scaleMax) * 220 : 0}px"
                ></div>
                {#if (day.cacheReadTokens || 0) > 0}
                  <div
                    class="bar cache-read"
                    style="height: {scaleMax > 0 ? (day.cacheReadTokens / scaleMax) * 220 : 0}px"
                  ></div>
                {/if}
                {#if (day.cacheWriteTokens || 0) > 0}
                  <div
                    class="bar cache-write"
                    style="height: {scaleMax > 0 ? (day.cacheWriteTokens / scaleMax) * 220 : 0}px"
                  ></div>
                {/if}
                {#if day.thinkingTokens > 0}
                  <div
                    class="bar thinking"
                    style="height: {scaleMax > 0 ? (day.thinkingTokens / scaleMax) * 220 : 0}px"
                  ></div>
                {/if}
              {/if}
            </div>
            <div class="label numeric">{day.date.slice(5)}</div>
          </div>
        {/each}
      </div>
      {#if tooltip}
        <div class="tooltip" style="left:{tooltip.x}px;top:{tooltip.y}px">
          {#each tooltip.lines as line}
            <div class="tooltip-row" class:tooltip-bold={line.bold}>
              {#if line.color}
                <span class="tooltip-dot" style="background:{line.color}"></span>
              {/if}
              <span class="tooltip-label">{line.label}</span>
              {#if line.value}
                <span class="tooltip-val numeric">{line.value}</span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
    {#if chartMode === 'breakdown'}
      <div class="legend">
        <span class="legend-item"><span class="dot input"></span> {$t('tokens.input')}</span>
        <span class="legend-item"><span class="dot output"></span> {$t('tokens.output')}</span>
        <span class="legend-item"><span class="dot cache-read"></span> {$t('tokens.cacheRead')}</span>
        <span class="legend-item"><span class="dot cache-write"></span> {$t('tokens.cacheWrite')}</span>
        <span class="legend-item"><span class="dot thinking"></span> {$t('tokens.thinking')}</span>
      </div>
    {:else}
      <div class="legend">
        <span class="legend-item"><span class="dot total-bar"></span> {$t('tokens.total')}</span>
      </div>
    {/if}
  </div>

  <div class="card table-card" style="margin-top: 1.25rem;">
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
          {#each data.data as day}
            <tr>
              <td class="numeric font-medium">{day.date}</td>
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
{/if}

<style>
  .chart-section {
    padding-bottom: 1.5rem;
  }
  .chart-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }
  .chart-header .section-title {
    margin-bottom: 0;
  }

  /* ── Segmented Mode Switcher ────────────────────────────────────────────── */
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
  .mode-btn:hover {
    color: var(--text);
  }
  .mode-btn.active {
    background: var(--surface);
    color: var(--accent);
    font-weight: 600;
    box-shadow: var(--shadow-sm);
  }

  /* ── Chart Container with Y-Axis ────────────────────────────────────────── */
  .chart-area {
    position: relative;
    display: flex;
    padding-bottom: 18px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .y-axis {
    position: relative;
    width: 56px;
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
    width: 50px;
    padding-right: 8px;
  }
  .y-line {
    position: absolute;
    left: 56px;
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
  .bars {
    display: flex;
    gap: 1.5px;
    align-items: flex-end;
  }
  .bar {
    width: 9px;
    min-height: 2px;
    border-radius: 3px 3px 0 0;
    transition: height 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.15s;
  }
  .bar.input { background: var(--chart-input); }
  .bar.output { background: var(--chart-output); }
  .bar.cache-read { background: var(--chart-cache-read); }
  .bar.cache-write { background: var(--chart-cache-write); }
  .bar.thinking { background: var(--chart-thinking); }
  .bar.total-bar {
    background: linear-gradient(180deg, var(--accent) 0%, var(--accent-hover) 100%);
    width: 14px;
  }

  .label {
    font-family: var(--font-numeric);
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
    margin-top: 8px;
  }

  /* ── Chart Legend ───────────────────────────────────────────────────────── */
  .legend {
    display: flex;
    gap: 1.25rem;
    margin-top: 1.125rem;
    justify-content: center;
    flex-wrap: wrap;
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-secondary);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
  .dot.input { background: var(--chart-input); }
  .dot.output { background: var(--chart-output); }
  .dot.cache-read { background: var(--chart-cache-read); }
  .dot.cache-write { background: var(--chart-cache-write); }
  .dot.thinking { background: var(--chart-thinking); }
  .dot.total-bar { background: var(--chart-total); }

  /* ── Modern Vercel/Linear Tooltip ───────────────────────────────────────── */
  .tooltip {
    position: absolute;
    pointer-events: none;
    z-index: 50;
    background: var(--surface);
    border: 1px solid var(--border-medium);
    border-radius: var(--radius-sm);
    padding: 0.625rem 0.875rem;
    box-shadow: var(--shadow-md);
    transform: translate(-50%, calc(-100% - 12px));
    white-space: nowrap;
    min-width: 150px;
    backdrop-filter: blur(12px);
    animation: tooltipIn 0.12s ease-out;
  }
  @keyframes tooltipIn {
    from { opacity: 0; transform: translate(-50%, calc(-100% - 8px)); }
    to { opacity: 1; transform: translate(-50%, calc(-100% - 12px)); }
  }

  .tooltip-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
    padding: 0.125rem 0;
  }
  .tooltip-row:first-child {
    font-family: var(--font-numeric);
    font-weight: 700;
    color: var(--text);
    margin-bottom: 0.25rem;
    font-size: 0.8125rem;
  }
  .tooltip-bold {
    border-top: 1px solid var(--border-subtle);
    margin-top: 0.35rem;
    padding-top: 0.35rem;
    font-weight: 700;
    color: var(--text);
  }
  .tooltip-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .tooltip-label {
    flex: 1;
  }
  .tooltip-val {
    font-size: 0.75rem;
    text-align: right;
  }

  /* ── Table Styling ──────────────────────────────────────────────────────── */
  .table-card {
    padding: 0;
    overflow: hidden;
  }
  .table-container {
    overflow-x: auto;
  }
  .numeric-th {
    text-align: right;
  }
  .font-medium {
    font-weight: 500;
    color: var(--text);
  }
  .font-bold {
    font-weight: 700;
  }
  .color-input { color: var(--chart-input); }
  .color-output { color: var(--chart-output); }
  .color-cr { color: var(--chart-cache-read); }
  .color-cw { color: var(--chart-cache-write); }
  .color-thinking { color: var(--chart-thinking); }
  .color-total { color: var(--text); }

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
</style>
