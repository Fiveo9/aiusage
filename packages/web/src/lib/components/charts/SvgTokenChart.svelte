<script>
  import { formatTokens } from '$lib/stores.js'
  import { t } from '$lib/i18n.js'

  export let days = []
  export let mode = 'breakdown' // 'breakdown' | 'total'

  let containerWidth = 720
  let hoveredIdx = null
  let hoverY = 0
  let hiddenKeys = new Set()

  const HEIGHT = 248
  const PAD_LEFT = 54
  const PAD_RIGHT = 14
  const PAD_TOP = 16
  const PAD_BOTTOM = 26

  $: seriesDefs = [
    { key: 'inputTokens',      label: $t('tokens.input'),      color: 'var(--chart-input)' },
    { key: 'outputTokens',     label: $t('tokens.output'),     color: 'var(--chart-output)' },
    { key: 'cacheReadTokens',  label: $t('tokens.cacheRead'),  color: 'var(--chart-cache-read)' },
    { key: 'cacheWriteTokens', label: $t('tokens.cacheWrite'), color: 'var(--chart-cache-write)' },
    { key: 'thinkingTokens',   label: $t('tokens.thinking'),   color: 'var(--chart-thinking)' },
  ]

  function toggleSeries(key) {
    const next = new Set(hiddenKeys)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    hiddenKeys = next
  }

  function getDayTotal(d) {
    return (
      (d.inputTokens || 0) +
      (d.outputTokens || 0) +
      (d.cacheReadTokens || 0) +
      (d.cacheWriteTokens || 0) +
      (d.thinkingTokens || 0)
    )
  }

  function getVisibleDayTotal(d, activeSeries) {
    return activeSeries.reduce((sum, s) => sum + (d[s.key] || 0), 0)
  }

  function niceScale(max) {
    if (max <= 0) return [0]
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

  $: activeSeries = mode === 'total'
    ? seriesDefs
    : seriesDefs.filter((s) => !hiddenKeys.has(s.key))

  $: innerW = Math.max(180, containerWidth - PAD_LEFT - PAD_RIGHT)
  $: innerH = HEIGHT - PAD_TOP - PAD_BOTTOM

  $: maxVal = days.length
    ? Math.max(
        0,
        ...days.map((d) => (mode === 'total' ? getDayTotal(d) : getVisibleDayTotal(d, activeSeries)))
      )
    : 0

  $: ticks = niceScale(maxVal)
  $: scaleMax = ticks.length > 1 ? ticks[ticks.length - 1] : Math.max(1, maxVal)

  $: avgTotal = days.length
    ? days.reduce((sum, d) => sum + getDayTotal(d), 0) / days.length
    : 0

  $: slotW = innerW / Math.max(1, days.length)
  $: barW = Math.min(28, Math.max(4, slotW * 0.62))
  $: xStep = Math.max(1, Math.ceil((days.length * 48) / innerW))

  function yPos(val) {
    if (scaleMax <= 0) return PAD_TOP + innerH
    return PAD_TOP + innerH - (val / scaleMax) * innerH
  }

  function buildSegments(day, active) {
    let acc = 0
    const segs = []
    for (const s of active) {
      const val = day[s.key] || 0
      if (val <= 0) continue
      const yBottom = yPos(acc)
      acc += val
      const yTop = yPos(acc)
      segs.push({
        key: s.key,
        color: s.color,
        y: yTop,
        h: Math.max(1.5, yBottom - yTop),
      })
    }
    return segs
  }

  function handleColMove(e, idx) {
    const svg = e.currentTarget.ownerSVGElement
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    hoverY = Math.max(24, Math.min(HEIGHT - 24, e.clientY - rect.top))
    hoveredIdx = idx
  }

  $: hoveredDay = hoveredIdx != null ? days[hoveredIdx] : null
  $: hoverCenterX = hoveredIdx != null ? PAD_LEFT + (hoveredIdx + 0.5) * slotW : 0
  $: flipLeft = hoverCenterX > containerWidth * 0.62
</script>

<div class="svg-chart-root">
  <div class="chart-wrap" bind:clientWidth={containerWidth}>
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <svg
      width={containerWidth}
      height={HEIGHT}
      viewBox="0 0 {containerWidth} {HEIGHT}"
      class="chart-svg"
      on:mouseleave={() => { hoveredIdx = null }}
    >
      <!-- Horizontal gridlines & Y ticks -->
      {#each ticks as tick}
        {@const y = yPos(tick)}
        <line
          x1={PAD_LEFT}
          x2={containerWidth - PAD_RIGHT}
          y1={y}
          y2={y}
          class="grid-line"
          class:baseline={tick === 0}
        />
        <text
          x={PAD_LEFT - 8}
          y={y + 3.5}
          text-anchor="end"
          class="axis-label numeric"
        >
          {formatTokens(tick)}
        </text>
      {/each}

      <!-- Hover vertical highlight band -->
      {#if hoveredIdx != null}
        <rect
          x={PAD_LEFT + hoveredIdx * slotW}
          y={PAD_TOP}
          width={slotW}
          height={innerH}
          class="hover-band"
        />
        <line
          x1={hoverCenterX}
          x2={hoverCenterX}
          y1={PAD_TOP}
          y2={PAD_TOP + innerH}
          class="hover-line"
        />
      {/if}

      <!-- Bars & hit targets -->
      {#each days as day, i (day.date)}
        {@const cx = PAD_LEFT + (i + 0.5) * slotW}
        {@const bx = cx - barW / 2}
        {#if mode === 'total'}
          {@const total = getDayTotal(day)}
          {@const barY = yPos(total)}
          {@const barH = Math.max(total > 0 ? 2 : 0, PAD_TOP + innerH - barY)}
          {#if barH > 0}
            <rect
              x={bx}
              y={barY}
              width={barW}
              height={barH}
              rx={barW >= 8 ? 2.5 : 1.5}
              fill="var(--chart-total)"
              class="bar-rect"
              class:dimmed={hoveredIdx != null && hoveredIdx !== i}
            />
          {/if}
        {:else}
          {@const segs = buildSegments(day, activeSeries)}
          {#each segs as seg, si (seg.key)}
            <rect
              x={bx}
              y={seg.y}
              width={barW}
              height={seg.h}
              rx={si === segs.length - 1 && barW >= 8 ? 2 : 0}
              fill={seg.color}
              class="bar-rect"
              class:dimmed={hoveredIdx != null && hoveredIdx !== i}
            />
          {/each}
        {/if}

        {#if i % xStep === 0}
          <text
            x={cx}
            y={HEIGHT - 7}
            text-anchor="middle"
            class="axis-label numeric"
            class:axis-active={hoveredIdx === i}
          >
            {day.date.slice(5)}
          </text>
        {/if}

        <!-- Full-height transparent hit area -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <rect
          x={PAD_LEFT + i * slotW}
          y={PAD_TOP}
          width={slotW}
          height={innerH}
          fill="transparent"
          class="hit-col"
          on:mouseenter={(e) => handleColMove(e, i)}
          on:mousemove={(e) => handleColMove(e, i)}
        />
      {/each}

      <!-- Daily average reference line in Total mode -->
      {#if mode === 'total' && avgTotal > 0 && days.length > 1}
        {@const avgY = yPos(avgTotal)}
        <line
          x1={PAD_LEFT}
          x2={containerWidth - PAD_RIGHT}
          y1={avgY}
          y2={avgY}
          class="avg-line"
        />
        <g transform="translate({containerWidth - PAD_RIGHT - 4}, {Math.max(PAD_TOP + 10, avgY - 5)})">
          <text text-anchor="end" class="avg-label numeric">
            {$t('common.dailyAvg')} {formatTokens(Math.round(avgTotal))}
          </text>
        </g>
      {/if}
    </svg>

    {#if hoveredDay}
      <div
        class="chart-tooltip"
        class:flip-left={flipLeft}
        style="left: {hoverCenterX}px; top: {hoverY}px;"
      >
        <div class="tt-date numeric">{hoveredDay.date}</div>
        {#if mode === 'total'}
          <div class="tt-row tt-total-only">
            <span class="tt-dot" style="background: var(--chart-total)"></span>
            <span class="tt-name">{$t('tokens.total')}</span>
            <span class="tt-val numeric">{formatTokens(getDayTotal(hoveredDay))}</span>
          </div>
        {:else}
          <div class="tt-rows">
            {#each activeSeries as s}
              {@const v = hoveredDay[s.key] || 0}
              {#if v > 0 || s.key === 'inputTokens' || s.key === 'outputTokens'}
                <div class="tt-row">
                  <span class="tt-dot" style="background: {s.color}"></span>
                  <span class="tt-name">{s.label}</span>
                  <span class="tt-val numeric">{formatTokens(v)}</span>
                </div>
              {/if}
            {/each}
          </div>
          <div class="tt-divider"></div>
          <div class="tt-row tt-sum">
            <span class="tt-name">{$t('tokens.total')}</span>
            <span class="tt-val numeric">{formatTokens(getVisibleDayTotal(hoveredDay, activeSeries))}</span>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Legend -->
  <div class="legend">
    {#if mode === 'breakdown'}
      {#each seriesDefs as s}
        {@const isHidden = hiddenKeys.has(s.key)}
        <button
          type="button"
          class="legend-btn"
          class:off={isHidden}
          aria-pressed={!isHidden}
          on:click={() => toggleSeries(s.key)}
        >
          <span class="leg-dot" style="background: {s.color}"></span>
          <span>{s.label}</span>
        </button>
      {/each}
    {:else}
      <span class="legend-static">
        <span class="leg-dot" style="background: var(--chart-total)"></span>
        <span>{$t('tokens.total')}</span>
      </span>
    {/if}
  </div>
</div>

<style>
  .svg-chart-root {
    width: 100%;
    min-width: 0;
  }

  .chart-wrap {
    position: relative;
    width: 100%;
    min-width: 0;
    user-select: none;
  }

  .chart-svg {
    display: block;
    width: 100%;
    overflow: visible;
  }

  .grid-line {
    stroke: var(--border-subtle);
    stroke-width: 1;
    stroke-dasharray: 2 3;
  }

  .grid-line.baseline {
    stroke: var(--border-medium);
    stroke-dasharray: none;
  }

  .axis-label {
    fill: var(--text-muted);
    font-size: 11px;
    font-weight: 500;
  }

  .axis-label.axis-active {
    fill: var(--text);
    font-weight: 600;
  }

  .hover-band {
    fill: var(--hover);
    opacity: 0.65;
  }

  .hover-line {
    stroke: var(--border-medium);
    stroke-width: 1;
  }

  .bar-rect {
    transition: opacity 0.12s ease;
  }

  .bar-rect.dimmed {
    opacity: 0.48;
  }

  .hit-col {
    cursor: crosshair;
  }

  .avg-line {
    stroke: var(--text-muted);
    stroke-width: 1;
    stroke-dasharray: 4 3;
    opacity: 0.8;
    pointer-events: none;
  }

  .avg-label {
    fill: var(--text-muted);
    font-size: 10px;
    font-weight: 600;
    pointer-events: none;
  }

  .chart-tooltip {
    position: absolute;
    z-index: 40;
    pointer-events: none;
    transform: translate(12px, -50%);
    min-width: 165px;
    padding: 0.55rem 0.75rem;
    background: var(--surface-elevated);
    border: 1px solid var(--border-medium);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-md);
  }

  .chart-tooltip.flip-left {
    transform: translate(calc(-100% - 12px), -50%);
  }

  .tt-date {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 0.3rem;
  }

  .tt-rows {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .tt-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .tt-dot {
    width: 7px;
    height: 7px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .tt-name {
    flex: 1;
    white-space: nowrap;
  }

  .tt-val {
    font-weight: 600;
    color: var(--text);
  }

  .tt-divider {
    height: 1px;
    background: var(--border-subtle);
    margin: 0.3rem 0;
  }

  .tt-sum .tt-name,
  .tt-sum .tt-val {
    font-weight: 650;
    color: var(--text);
  }

  .legend {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.4rem 1rem;
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border-subtle);
  }

  .legend-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.2rem 0.45rem;
    border: 1px solid transparent;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.14s ease, background-color 0.14s ease, color 0.14s ease;
  }

  .legend-btn:hover {
    background: var(--hover);
    color: var(--text);
  }

  .legend-btn.off {
    opacity: 0.42;
    text-decoration: line-through;
  }

  .legend-static {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-secondary);
  }

  .leg-dot {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex-shrink: 0;
  }
</style>
