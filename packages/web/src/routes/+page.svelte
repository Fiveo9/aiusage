<script>
  import { onMount, onDestroy } from 'svelte'
  import { tweened } from 'svelte/motion'
  import { cubicOut } from 'svelte/easing'
  import { fetchHomeSummary, refreshData as triggerRefresh, fetchConfig, fetchQuotas, SETTINGS_UPDATED_EVENT } from '$lib/api.js'
  import { t } from '$lib/i18n.js'
  import { formatCost, displayCurrency, exchangeRate } from '$lib/stores.js'
  import { tokenComposition } from '$lib/token-composition.js'
  import { SlidersHorizontal, RefreshCw, AlertTriangle, ArrowRight, X } from 'lucide-svelte'

  const DISPLAY_KEY = 'aiusage-home-display'

  const RANGE_OPTIONS = [
    { tKey: 'range.allTime', value: 'all' },
    { tKey: 'range.today',   value: 'day' },
    { tKey: 'range.week',    value: 'week' },
    { tKey: 'range.month',   value: 'month' },
    { tKey: 'range.last30',  value: 'last30' },
  ]

  function defaultDisplay() {
    return { range: 'all', precision: 'exact' }
  }

  function loadDisplay() {
    if (typeof window === 'undefined') return defaultDisplay()
    try { return { ...defaultDisplay(), ...JSON.parse(localStorage.getItem(DISPLAY_KEY) || '{}') } }
    catch { return defaultDisplay() }
  }

  function saveDisplay(d) {
    if (typeof window !== 'undefined') localStorage.setItem(DISPLAY_KEY, JSON.stringify(d))
  }

  let display = defaultDisplay()
  let showConfig = false

  let globalRefreshMs = 30000

  $: fmtMain = (n) => {
    const r = Math.round(n)
    if (display.precision === 'abbr') {
      if (r >= 1_000_000_000) return (r / 1_000_000_000).toFixed(3) + 'B'
      if (r >= 1_000_000)     return (r / 1_000_000).toFixed(3) + 'M'
      if (r >= 1_000)         return (r / 1_000).toFixed(1) + 'K'
    }
    return r.toLocaleString()
  }

  let data       = null
  let error      = null
  let loading    = true
  let refreshing = false
  let barsReady  = false

  const tTokens   = tweened(0, { duration: 1800, easing: cubicOut })
  const tCost     = tweened(0, { duration: 1500, easing: cubicOut })
  const tSessions = tweened(0, { duration: 1300, easing: cubicOut })
  const tDays     = tweened(0, { duration: 1100, easing: cubicOut })

  async function fetchAndApply(fast = false) {
    const d = fast ? 400 : 1800
    error = null
    try {
      const newData = await fetchHomeSummary({ range: display.range })
      if (newData) {
        data = newData
        tTokens.set(newData.totalTokens,       { duration: d })
        tCost.set(newData.totalCost,           { duration: Math.round(d * 0.85) })
        tSessions.set(newData.totalSessions || 0, { duration: Math.round(d * 0.72) })
        tDays.set(newData.activeDays,          { duration: Math.round(d * 0.62) })
        barsReady = false
        setTimeout(() => { barsReady = true }, fast ? 60 : 250)
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load'
      data = null
    }
  }

  async function loadData() {
    loading = true
    tTokens.set(0, { duration: 0 })
    tCost.set(0,   { duration: 0 })
    tSessions.set(0, { duration: 0 })
    tDays.set(0,   { duration: 0 })
    barsReady = false
    await fetchAndApply(false)
    loading = false
  }

  async function silentRefresh() {
    refreshing = true
    await fetchAndApply(true)
    refreshing = false
  }

  let countdown      = 0
  let countdownTimer = null
  let refreshTimeout = null
  // Set by onDestroy. A request that was pending when the page went away must
  // not start timers that nothing will clear (issue #109).
  let destroyed      = false

  function startRefreshCycle() {
    if (destroyed) return
    clearInterval(countdownTimer)
    clearTimeout(refreshTimeout)
    const secs = Math.round(globalRefreshMs / 1000)
    if (!secs) { countdown = 0; return }
    countdown = secs
    countdownTimer = setInterval(() => { countdown = Math.max(0, countdown - 1) }, 1000)
    refreshTimeout = setTimeout(() => {
      silentRefresh().then(startRefreshCycle)
    }, globalRefreshMs)
  }

  function manualRefresh() {
    clearInterval(countdownTimer)
    clearTimeout(refreshTimeout)
    silentRefresh().then(() => startRefreshCycle())
  }

  function handleSettingsUpdated(event) {
    globalRefreshMs = event?.detail?.refreshInterval ?? 30000
    startRefreshCycle()
  }

  let now         = new Date()
  let clockTimer  = null

  onMount(async () => {
    display = loadDisplay()
    clockTimer = setInterval(() => { now = new Date() }, 1000)
    // Added before the first await, so the listener onDestroy removes is
    // always one that was already added.
    window.addEventListener(SETTINGS_UPDATED_EVENT, handleSettingsUpdated)

    try {
      const cfg = await fetchConfig()
      if (cfg?.refreshInterval) globalRefreshMs = cfg.refreshInterval
    } catch {}
    if (destroyed) return

    // Render whatever is already in the database first so the landing page is
    // never blocked on log parsing. Trae/large log sources can make /api/refresh
    // take tens of seconds; awaiting it here left the page stuck loading (issue #40).
    await Promise.all([loadData(), loadQuotaWarnings()])
    if (destroyed) return
    startRefreshCycle()

    // Kick off a fresh parse in the background, then quietly update once it lands.
    triggerRefresh()
      .then(() => destroyed ? undefined : Promise.all([silentRefresh(), loadQuotaWarnings()]))
      .catch(() => {})
  })

  onDestroy(() => {
    destroyed = true
    clearInterval(clockTimer)
    clearInterval(countdownTimer)
    clearTimeout(refreshTimeout)
    if (typeof window !== 'undefined') {
      window.removeEventListener(SETTINGS_UPDATED_EVENT, handleSettingsUpdated)
    }
  })

  $: timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  $: dateStr  = now.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })

  // Thinking tokens are stored apart from output tokens; the bar counts them as output.
  $: ({ inputPct, outputPct, cacheReadPct, cacheWritePct } = tokenComposition(data))

  $: refreshSecs  = Math.round(globalRefreshMs / 1000)
  $: refreshPct   = refreshSecs > 0 ? (1 - countdown / refreshSecs) * 100 : 0
  $: rangeKey     = RANGE_OPTIONS.find(r => r.value === display.range)?.tKey ?? 'range.allTime'

  // Reactive cost formatting — depends on $displayCurrency and $exchangeRate so it re-evaluates on currency change
  $: formattedCost = (() => { void $displayCurrency; void $exchangeRate; return formatCost($tCost) })()

  // Quota warning: load once on mount, show banner when any tier >= 80%
  let quotaWarnings = []

  async function loadQuotaWarnings() {
    try {
      const result = await fetchQuotas()
      const warnings = []
      for (const quota of result?.quotas ?? []) {
        if (!quota.success) continue
        for (const tier of quota.tiers ?? []) {
          if (tier.utilization >= 80) {
            warnings.push({ tool: quota.tool, tier: tier.name, utilization: Math.round(tier.utilization) })
          }
        }
      }
      quotaWarnings = warnings
    } catch {
      // Quota warnings are non-critical — silently ignore errors
    }
  }

  const TOOL_SHORT = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
  }
  const TIER_SHORT = {
    five_hour: '5h',
    seven_day: '7d',
    seven_day_opus: '7d Opus',
    seven_day_sonnet: '7d Sonnet',
    seven_day_omelette: '7d Design',
    weekly_limit: 'weekly',
  }

  function warningColor(pct) {
    return pct >= 90 ? 'red' : 'orange'
  }

  function fmtShort(n) {
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B'
    if (n >= 1_000_000)     return (n / 1_000_000).toFixed(1) + 'M'
    if (n >= 1_000)         return (n / 1_000).toFixed(1) + 'K'
    return (n || 0).toLocaleString()
  }

  function setRange(v) {
    display = { ...display, range: v }
    saveDisplay(display)
    loadData().then(() => startRefreshCycle())
  }

  function setPrecision(v) {
    display = { ...display, precision: v }
    saveDisplay(display)
  }
</script>

<svelte:head>
  <title>AIUsage</title>
</svelte:head>

{#if showConfig}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="overlay-backdrop" on:click={() => showConfig = false}></div>
  <div class="config-panel" role="dialog" aria-modal="true" aria-labelledby="cfg-title-id">
    <div class="cfg-header">
      <span class="cfg-title" id="cfg-title-id">{$t('home.cfgTitle')}</span>
      <button type="button" class="cfg-close" on:click={() => showConfig = false} aria-label="Close">
        <X size={14} strokeWidth={2} />
      </button>
    </div>

    <div class="cfg-section">
      <div class="cfg-label">{$t('home.timeRange')}</div>
      <div class="cfg-pills">
        {#each RANGE_OPTIONS as opt}
          <button type="button" class="pill" class:active={display.range === opt.value} on:click={() => setRange(opt.value)}>
            {$t(opt.tKey)}
          </button>
        {/each}
      </div>
    </div>

    <div class="cfg-section">
      <div class="cfg-label">{$t('home.numFormat')}</div>
      <div class="cfg-pills">
        <button type="button" class="pill" class:active={display.precision === 'exact'} on:click={() => setPrecision('exact')}>
          {$t('home.numExact')} <span class="pill-eg numeric">{$t('home.numExactEx')}</span>
        </button>
        <button type="button" class="pill" class:active={display.precision === 'abbr'} on:click={() => setPrecision('abbr')}>
          {$t('home.numShort')} <span class="pill-eg numeric">{$t('home.numShortEx')}</span>
        </button>
      </div>
    </div>

    <div class="cfg-refresh-info">
      <span class="refresh-info-text">
        {$t('home.refreshInfo')}
        <a href="/settings" class="settings-link" on:click={() => showConfig = false}>{$t('nav.settings')}</a>
        · <span class="numeric">{refreshSecs}{$t('home.seconds')}</span>
      </span>
    </div>
  </div>
{/if}

<div class="top-bar">
  <div class="top-bar-left">
    <div class="live-indicator">
      <span class="live-dot"></span>
      <span class="live-label">LIVE</span>
    </div>

    <div class="segmented range-segmented" role="group" aria-label={$t('home.timeRange')}>
      {#each RANGE_OPTIONS as opt}
        <button
          type="button"
          class="segmented-btn"
          class:active={display.range === opt.value}
          on:click={() => setRange(opt.value)}
        >
          {$t(opt.tKey)}
        </button>
      {/each}
    </div>
  </div>

  <div class="top-bar-right">
    <div class="clock-block">
      <span class="clock-time numeric">{timeStr}</span>
      <span class="clock-date">{dateStr}</span>
    </div>

    <button
      type="button"
      class="eng-btn icon-only-btn"
      on:click={() => showConfig = !showConfig}
      title={$t('home.cfgTitle')}
      aria-label={$t('home.cfgTitle')}
    >
      <SlidersHorizontal size={14} strokeWidth={1.85} />
    </button>
  </div>
</div>

{#if quotaWarnings.length > 0}
  <div class="quota-warning-list">
    {#each quotaWarnings as w (w.tool + w.tier)}
      {@const color = warningColor(w.utilization)}
      <div class="quota-warning" class:quota-red={color === 'red'} class:quota-orange={color === 'orange'}>
        <span class="warn-icon" aria-hidden="true"><AlertTriangle size={14} strokeWidth={2} /></span>
        <span class="warn-text">
          <strong>{TOOL_SHORT[w.tool] ?? w.tool}</strong>
          {TIER_SHORT[w.tier] ?? w.tier}
          {$t('home.quotaWarningDesc')}: <strong class="numeric">{w.utilization}%</strong>
        </span>
        <a href="/quotas" class="warn-link">
          <span>{$t('home.quotaWarningLink')}</span>
          <ArrowRight size={13} strokeWidth={2} />
        </a>
      </div>
    {/each}
  </div>
{/if}

{#if loading}
  <div class="bento-skeleton">
    <div class="card hero-skeleton">
      <div class="skeleton skeleton-line" style="width: 140px;"></div>
      <div class="skeleton" style="height: 3.5rem; width: 280px; margin: 1.25rem 0;"></div>
      <div class="skeleton skeleton-line" style="width: 240px;"></div>
    </div>
    <div class="kpi-grid kpi-grid-3">
      {#each [1, 2, 3] as _}
        <div class="kpi-card">
          <div class="skeleton skeleton-line" style="width: 45%;"></div>
          <div class="skeleton skeleton-value"></div>
        </div>
      {/each}
    </div>
  </div>
{:else if error}
  <div class="state-msg error">
    <span>{error}</span>
    <button type="button" class="eng-btn" on:click={manualRefresh}>
      <RefreshCw size={13} strokeWidth={1.85} />
      <span>{$t('home.refreshBtn')}</span>
    </button>
  </div>
{:else if !data || data.totalTokens === 0}
  <div class="state-msg">
    <h2>{$t('common.noData')}</h2>
    <p>{$t('common.noDataHint')}</p>
  </div>
{:else}

  <section class="card hero-panel">
    <div class="hero-top">
      <div class="hero-title-group">
        <span class="hero-kicker">{$t('home.counterLabel')}</span>
        <span class="range-tag">{$t(rangeKey)}</span>
      </div>

      <div class="refresh-controls">
        <span class="refresh-status">
          {#if refreshSecs > 0}
            {#if countdown > 0}
              <span class="refresh-clock-dot"></span>
              <span class="numeric">{$t('home.nextRefresh')} {countdown}{$t('home.seconds')}</span>
            {:else}
              <span class="refresh-clock-dot active"></span>
              <span class="refreshing-label">{$t('home.refreshing')}</span>
            {/if}
          {:else}
            <span>{$t('home.manualMode')}</span>
          {/if}
        </span>
        <button type="button" class="eng-btn now-btn" on:click={manualRefresh} disabled={refreshing}>
          <span class="refresh-spin-wrap" class:spinning={refreshing}>
            <RefreshCw size={12} strokeWidth={2} />
          </span>
          <span>{refreshSecs > 0 ? $t('home.refreshNow') : $t('home.refreshBtn')}</span>
        </button>
      </div>
    </div>

    <div class="hero-main">
      <div class="counter-number numeric" class:refreshing>
        {fmtMain($tTokens)}
      </div>

      <div class="counter-sub">
        <div class="sub-item">
          <span class="sub-indicator sub-input"></span>
          <span class="sub-label">{$t('home.input')}</span>
          <span class="sub-value numeric">{fmtShort(data.inputTokens)}</span>
        </div>
        <span class="sub-sep" aria-hidden="true">/</span>
        <div class="sub-item">
          <span class="sub-indicator sub-output"></span>
          <span class="sub-label">{$t('home.output')}</span>
          <span class="sub-value numeric">{fmtShort(data.outputTokens)}</span>
        </div>
        <span class="sub-sep" aria-hidden="true">/</span>
        <div class="sub-item">
          <span class="sub-indicator sub-cache"></span>
          <span class="sub-label">{$t('home.cache')}</span>
          <span class="sub-value numeric">{fmtShort((data.cacheReadTokens || 0) + (data.cacheWriteTokens || 0))}</span>
        </div>
      </div>
    </div>

    <div class="refresh-bar-track" aria-hidden="true">
      {#if refreshSecs > 0}
        <div class="refresh-bar-fill" style="width: {refreshPct}%"></div>
      {/if}
    </div>
  </section>

  <div class="kpi-grid kpi-grid-3">
    <div class="kpi-card">
      <span class="kpi-label">{$t('overview.totalCost')}</span>
      <span class="kpi-value accent numeric">{formattedCost}</span>
    </div>
    <div class="kpi-card">
      <span class="kpi-label">{$t('overview.totalSessions')}</span>
      <span class="kpi-value numeric">{Math.round($tSessions).toLocaleString()}</span>
    </div>
    <div class="kpi-card">
      <span class="kpi-label">{$t('overview.activeDays')}</span>
      <span class="kpi-value numeric">{Math.round($tDays).toLocaleString()}</span>
    </div>
  </div>

  <div class="card comp-card">
    <div class="comp-header">
      <span class="section-title">{$t('home.composition')}</span>
      <span class="comp-total numeric">{fmtShort(data.totalTokens)}</span>
    </div>

    <div class="comp-bar" aria-label={$t('home.composition')}>
      {#if inputPct > 0}
        <div class="seg seg-input" style="width:{barsReady ? inputPct : 0}%" title="{$t('home.input')} {inputPct.toFixed(1)}%"></div>
      {/if}
      {#if outputPct > 0}
        <div class="seg seg-output" style="width:{barsReady ? outputPct : 0}%" title="{$t('home.output')} {outputPct.toFixed(1)}%"></div>
      {/if}
      {#if cacheReadPct > 0}
        <div class="seg seg-cr" style="width:{barsReady ? cacheReadPct : 0}%" title="{$t('overview.cacheRead')} {cacheReadPct.toFixed(1)}%"></div>
      {/if}
      {#if cacheWritePct > 0}
        <div class="seg seg-cw" style="width:{barsReady ? cacheWritePct : 0}%" title="{$t('overview.cacheWrite')} {cacheWritePct.toFixed(1)}%"></div>
      {/if}
    </div>

    <div class="comp-grid">
      <div class="comp-cell">
        <div class="comp-cell-head">
          <span class="leg-swatch seg-input"></span>
          <span class="comp-cell-label">{$t('home.input')}</span>
          <span class="comp-cell-pct numeric">{inputPct.toFixed(1)}%</span>
        </div>
        <span class="comp-cell-val numeric">{fmtShort(data.inputTokens)}</span>
      </div>
      <div class="comp-cell">
        <div class="comp-cell-head">
          <span class="leg-swatch seg-output"></span>
          <span class="comp-cell-label">{$t('home.output')}</span>
          <span class="comp-cell-pct numeric">{outputPct.toFixed(1)}%</span>
        </div>
        <span class="comp-cell-val numeric">{fmtShort(data.outputTokens)}</span>
      </div>
      <div class="comp-cell">
        <div class="comp-cell-head">
          <span class="leg-swatch seg-cr"></span>
          <span class="comp-cell-label">{$t('overview.cacheRead')}</span>
          <span class="comp-cell-pct numeric">{cacheReadPct.toFixed(1)}%</span>
        </div>
        <span class="comp-cell-val numeric">{fmtShort(data.cacheReadTokens || 0)}</span>
      </div>
      <div class="comp-cell">
        <div class="comp-cell-head">
          <span class="leg-swatch seg-cw"></span>
          <span class="comp-cell-label">{$t('overview.cacheWrite')}</span>
          <span class="comp-cell-pct numeric">{cacheWritePct.toFixed(1)}%</span>
        </div>
        <span class="comp-cell-val numeric">{fmtShort(data.cacheWriteTokens || 0)}</span>
      </div>
    </div>
  </div>

{/if}

<style>
  /* ── Top Status Bar ─────────────────────────────────────────────────────── */
  .top-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
    padding: 0.45rem 0.625rem;
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
  }

  .top-bar-left {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.625rem;
  }

  .top-bar-right {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin-left: auto;
  }

  .live-indicator {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0 0.55rem;
    height: var(--control-height);
    border-radius: var(--radius-sm);
    background: var(--green-dim);
    border: 1px solid color-mix(in oklch, var(--green) 25%, transparent);
    flex-shrink: 0;
  }

  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
    animation: liveBlink 2.2s ease-in-out infinite;
  }

  @keyframes liveBlink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  .live-label {
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--green);
  }

  .clock-block {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
  }

  .clock-time {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text);
  }

  .clock-date {
    font-size: var(--text-2xs);
    color: var(--text-muted);
  }

  .icon-only-btn {
    width: var(--control-height);
    padding: 0;
  }

  /* ── Hero Token Panel ───────────────────────────────────────────────────── */
  .hero-panel {
    padding: 1.35rem 1.5rem 0;
    margin-bottom: 1rem;
    overflow: hidden;
  }

  .hero-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .hero-title-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .hero-kicker {
    font-size: var(--text-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .range-tag {
    font-size: var(--text-2xs);
    font-weight: 600;
    padding: 0.1rem 0.45rem;
    border-radius: var(--radius-xs);
    background: var(--raised);
    border: 1px solid var(--border-subtle);
    color: var(--text-secondary);
  }

  .refresh-controls {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }

  .refresh-status {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .refresh-clock-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--border-medium);
  }

  .refresh-clock-dot.active {
    background: var(--accent);
  }

  .refreshing-label {
    color: var(--accent);
    font-weight: 600;
  }

  .now-btn {
    height: 1.75rem;
    padding: 0 0.55rem;
    font-size: var(--text-2xs);
  }

  .refresh-spin-wrap {
    display: inline-flex;
    align-items: center;
  }

  .refresh-spin-wrap.spinning {
    animation: spin 0.9s linear infinite;
  }

  .hero-main {
    padding: 1.5rem 0 1.625rem;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .counter-number {
    font-size: clamp(2.125rem, 5.2vw, 3.875rem);
    font-weight: 700;
    max-width: 100%;
    overflow-wrap: anywhere;
    letter-spacing: -0.04em;
    line-height: 1.08;
    color: var(--text);
    transition: opacity 0.2s ease;
  }

  .counter-number.refreshing {
    opacity: 0.55;
  }

  .counter-sub {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem 0.875rem;
  }

  .sub-item {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }

  .sub-indicator {
    width: 6px;
    height: 6px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .sub-input { background: var(--chart-input); }
  .sub-output { background: var(--chart-output); }
  .sub-cache { background: var(--chart-cache-read); }

  .sub-label {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .sub-value {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text);
  }

  .sub-sep {
    color: var(--border-medium);
    font-size: var(--text-xs);
  }

  .refresh-bar-track {
    margin-inline: -1.5rem;
    height: 2px;
    background: var(--border-subtle);
    overflow: hidden;
  }

  .refresh-bar-fill {
    height: 100%;
    background: var(--accent);
    transition: width 1s linear;
  }

  /* ── Composition Card ───────────────────────────────────────────────────── */
  .comp-card {
    padding: 1.125rem 1.25rem;
  }

  .comp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.875rem;
  }

  .comp-header .section-title {
    margin-bottom: 0;
  }

  .comp-total {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-muted);
  }

  .comp-bar {
    display: flex;
    height: 10px;
    border-radius: 5px;
    overflow: hidden;
    background: var(--raised);
    gap: 2px;
  }

  .seg {
    height: 100%;
    min-width: 2px;
    transition: width 0.8s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .seg-input  { background: var(--chart-input); }
  .seg-output { background: var(--chart-output); }
  .seg-cr     { background: var(--chart-cache-read); }
  .seg-cw     { background: var(--chart-cache-write); }

  .comp-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.75rem;
    margin-top: 1rem;
    padding-top: 0.875rem;
    border-top: 1px solid var(--border-subtle);
  }

  .comp-cell {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .comp-cell-head {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .leg-swatch {
    width: 7px;
    height: 7px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .comp-cell-label {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .comp-cell-pct {
    margin-left: auto;
    font-size: var(--text-2xs);
    color: var(--text-muted);
  }

  .comp-cell-val {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text);
  }

  /* ── Quota Warning Banner ───────────────────────────────────────────────── */
  .quota-warning-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .quota-warning {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.55rem 0.875rem;
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    border: 1px solid transparent;
  }

  .quota-orange {
    background: var(--amber-dim);
    border-color: color-mix(in oklch, var(--amber) 35%, transparent);
    color: var(--amber);
  }

  .quota-red {
    background: var(--rose-dim);
    border-color: color-mix(in oklch, var(--rose) 35%, transparent);
    color: var(--rose);
  }

  .warn-icon {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .warn-text {
    flex: 1;
    min-width: 0;
  }

  .warn-link {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: var(--text-xs);
    font-weight: 600;
    text-decoration: none;
    color: inherit;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .warn-link:hover {
    text-decoration: underline;
  }

  /* ── Config Modal ───────────────────────────────────────────────────────── */
  .overlay-backdrop {
    position: fixed;
    inset: 0;
    z-index: 400;
    background: var(--overlay);
    backdrop-filter: blur(4px);
    animation: fadeIn 0.12s ease;
  }

  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .config-panel {
    position: fixed;
    z-index: 410;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(420px, 92vw);
    background: var(--surface-elevated);
    border: 1px solid var(--border-medium);
    border-radius: var(--radius-lg);
    padding: 1.25rem;
    box-shadow: var(--shadow-lg);
  }

  .cfg-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }

  .cfg-title {
    font-size: var(--text-base);
    font-weight: 650;
    color: var(--text);
  }

  .cfg-close {
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-xs);
    background: var(--raised);
    color: var(--text-muted);
    cursor: pointer;
    transition: color 0.12s ease, border-color 0.12s ease;
  }

  .cfg-close:hover {
    color: var(--text);
    border-color: var(--border-medium);
  }

  .cfg-section { margin-bottom: 1rem; }

  .cfg-label {
    font-size: var(--text-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 0.45rem;
  }

  .cfg-pills {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
  }

  .pill {
    height: var(--control-height);
    padding: 0 0.7rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--raised);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-secondary);
    cursor: pointer;
    transition: border-color 0.12s ease, color 0.12s ease, background-color 0.12s ease;
    white-space: nowrap;
  }

  .pill:hover {
    border-color: var(--border-medium);
    color: var(--text);
  }

  .pill.active {
    border-color: var(--accent);
    color: var(--accent-strong);
    background: var(--accent-dim);
    font-weight: 600;
  }

  .pill-eg {
    opacity: 0.6;
    font-size: var(--text-2xs);
    margin-left: 0.25rem;
  }

  .cfg-refresh-info {
    padding: 0.55rem 0.75rem;
    border-radius: var(--radius-sm);
    background: var(--raised);
    border: 1px solid var(--border-subtle);
  }

  .refresh-info-text {
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.45;
  }

  .settings-link {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }

  .settings-link:hover { text-decoration: underline; }

  /* ── Skeleton ───────────────────────────────────────────────────────────── */
  .bento-skeleton {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .hero-skeleton {
    padding: 1.5rem;
  }

  /* ── Responsive ─────────────────────────────────────────────────────────── */
  @media (max-width: 800px) {
    .hero-panel { padding: 1.125rem 1.125rem 0; }
    .refresh-bar-track { margin-inline: -1.125rem; }
    .comp-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .clock-date { display: none; }
    .range-segmented { order: 3; width: 100%; overflow-x: auto; }
  }

  @media (max-width: 480px) {
    .comp-grid { grid-template-columns: 1fr; }
  }
</style>
