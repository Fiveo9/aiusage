<script>
  import { formatCost } from '$lib/stores.js'
  import { t } from '$lib/i18n.js'

  export let days = []
  export let totalCost = 0

  let containerWidth = 720
  let hoveredIdx = null
  let hoverY = 0

  const HEIGHT = 240
  const PAD_LEFT = 60
  const PAD_RIGHT = 14
  const PAD_TOP = 16
  const PAD_BOTTOM = 26

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

  $: innerW = Math.max(180, containerWidth - PAD_LEFT - PAD_RIGHT)
  $: innerH = HEIGHT - PAD_TOP - PAD_BOTTOM
  $: maxCost = days.length ? Math.max(0, ...days.map((d) => d.cost || 0)) : 0
  $: ticks = niceScale(maxCost)
  $: scaleMax = ticks.length > 1 ? ticks[ticks.length - 1] : Math.max(0.01, maxCost)
  $: avgCost = days.length ? totalCost / days.length : 0

  $: slotW = innerW / Math.max(1, days.length)
  $: barW = Math.min(28, Math.max(4, slotW * 0.6))
  $: xStep = Math.max(1, Math.ceil((days.length * 48) / innerW))

  function yPos(val) {
    if (scaleMax <= 0) return PAD_TOP + innerH
    return PAD_TOP + innerH - (val / scaleMax) * innerH
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
  $: hoverShare = hoveredDay && totalCost > 0 ? ((hoveredDay.cost / totalCost) * 100).toFixed(1) : '0.0'
</script>

<div class="svg-cost-root">
  <div class="chart-wrap" bind:clientWidth={containerWidth}>
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <svg
      width={containerWidth}
      height={HEIGHT}
      viewBox="0 0 {containerWidth} {HEIGHT}"
      class="chart-svg"
      on:mouseleave={() => { hoveredIdx = null }}
    >
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
        <text x={PAD_LEFT - 8} y={y + 3.5} text-anchor="end" class="axis-label numeric">
          {formatCost(tick)}
        </text>
      {/each}

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

      {#each days as day, i (day.date)}
        {@const cx = PAD_LEFT + (i + 0.5) * slotW}
        {@const bx = cx - barW / 2}
        {@const barY = yPos(day.cost || 0)}
        {@const barH = Math.max((day.cost || 0) > 0 ? 2 : 0, PAD_TOP + innerH - barY)}
        {#if barH > 0}
          <rect
            x={bx}
            y={barY}
            width={barW}
            height={barH}
            rx={barW >= 8 ? 2.5 : 1.5}
            fill="var(--accent)"
            class="bar-rect"
            class:dimmed={hoveredIdx != null && hoveredIdx !== i}
          />
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

      {#if avgCost > 0 && days.length > 1}
        {@const avgY = yPos(avgCost)}
        <line
          x1={PAD_LEFT}
          x2={containerWidth - PAD_RIGHT}
          y1={avgY}
          y2={avgY}
          class="avg-line"
        />
        <g transform="translate({containerWidth - PAD_RIGHT - 4}, {Math.max(PAD_TOP + 10, avgY - 5)})">
          <text text-anchor="end" class="avg-label numeric">
            {$t('common.dailyAvg')} {formatCost(avgCost)}
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
        <div class="tt-cost numeric">{formatCost(hoveredDay.cost)}</div>
        {#if totalCost > 0}
          <div class="tt-share numeric">{$t('common.share')}: {hoverShare}%</div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .svg-cost-root {
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
    padding: 0.5rem 0.7rem;
    background: var(--surface-elevated);
    border: 1px solid var(--border-medium);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-md);
    white-space: nowrap;
  }

  .chart-tooltip.flip-left {
    transform: translate(calc(-100% - 12px), -50%);
  }

  .tt-date {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 0.15rem;
  }

  .tt-cost {
    font-size: 0.9375rem;
    font-weight: 700;
    color: var(--accent);
  }

  .tt-share {
    font-size: 0.6875rem;
    color: var(--text-secondary);
    margin-top: 0.1rem;
  }
</style>
