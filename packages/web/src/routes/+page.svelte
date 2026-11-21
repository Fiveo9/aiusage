<script>
  import { onMount, onDestroy } from 'svelte'
  import { tweened } from 'svelte/motion'
  import { cubicOut } from 'svelte/easing'
  import { fetchHomeSummary, refreshData as triggerRefresh, fetchConfig, fetchQuotas, SETTINGS_UPDATED_EVENT } from '$lib/api.js'
  import { t } from '$lib/i18n.js'
  import { formatCost, displayCurrency, exchangeRate } from '$lib/stores.js'
  import { tokenComposition } from '$lib/token-composition.js'
  import { Settings } from 'lucide-svelte'

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

  const tTokens   = tweened(0, { duration: 2600, easing: cubicOut })
  const tCost     = tweened(0, { duration: 2300, easing: cubicOut })
  const tSessions = tweened(0, { duration: 1900, easing: cubicOut })
  const tDays     = tweened(0, { duration: 1600, easing: cubicOut })

  async function fetchAndApply(fast = false) {
    const d = fast ? 500 : 2600
    error = null
    try {
      const newData = await fetchHomeSummary({ range: display.range })
      if (newData) {
        data = newData
        tTokens.set(newData.totalTokens,       { duration: d })
        tCost.set(newData.totalCost,           { duration: Math.round(d * 0.88) })
        tSessions.set(newData.totalSessions || 0, { duration: Math.round(d * 0.73) })
        tDays.set(newData.activeDays,          { duration: Math.round(d * 0.62) })
        barsReady = false
        setTimeout(() => { barsReady = true }, fast ? 80 : 400)
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
    return n.toLocaleString()
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
      <button class="cfg-close" on:click={() => showConfig = false} aria-label="Close">✕</button>
    </div>

    <div class="cfg-section">
      <div class="cfg-label">{$t('home.timeRange')}</div>
      <div class="cfg-pills">
        {#each RANGE_OPTIONS as opt}
          <button class="pill" class:active={display.range === opt.value} on:click={() => setRange(opt.value)}>
            {$t(opt.tKey)}
          </button>
        {/each}
      </div>
    </div>

    <div class="cfg-section">
      <div class="cfg-label">{$t('home.numFormat')}</div>
      <div class="cfg-pills">
        <button class="pill" class:active={display.precision === 'exact'} on:click={() => setPrecision('exact')}>
          {$t('home.numExact')} <span class="pill-eg">{$t('home.numExactEx')}</span>
        </button>
        <button class="pill" class:active={display.precision === 'abbr'} on:click={() => setPrecision('abbr')}>
          {$t('home.numShort')} <span class="pill-eg">{$t('home.numShortEx')}</span>
        </button>
      </div>
    </div>

    <div class="cfg-refresh-info">
      <span class="refresh-info-text">
        {$t('home.refreshInfo')}
        <a href="/settings" class="settings-link" on:click={() => showConfig = false}>{$t('nav.settings')}</a>
        · {refreshSecs}{$t('home.seconds')}
      </span>
    </div>
  </div>
{/if}

<div class="top-bar">
  <div class="live-indicator">
    <span class="live-dot-glow"></span>
    <span class="live-dot"></span>
    <span class="live-label">LIVE</span>
  </div>

  <span class="range-badge">{$t(rangeKey)}</span>

  <div class="clock-block">
    <span class="clock-time">{timeStr}</span>
    <span class="clock-date">{dateStr}</span>
  </div>

  <button class="cfg-btn" on:click={() => showConfig = !showConfig} title={$t('home.cfgTitle')} aria-label={$t('home.cfgTitle')}>
    <Settings size={16} strokeWidth={1.8} />
  </button>
</div>

{#if quotaWarnings.length > 0}
  <div class="quota-warning-list">
    {#each quotaWarnings as w (w.tool + w.tier)}
      {@const color = warningColor(w.utilization)}
      <div class="quota-warning" class:quota-red={color === 'red'} class:quota-orange={color === 'orange'}>
        <span class="warn-icon">{color === 'red' ? '▲' : '△'}</span>
        <span class="warn-text">
          <strong>{TOOL_SHORT[w.tool] ?? w.tool}</strong>
          {TIER_SHORT[w.tier] ?? w.tier}
          {$t('home.quotaWarningDesc')}: <strong>{w.utilization}%</strong>
        </span>
        <a href="/quotas" class="warn-link">{$t('home.quotaWarningLink')} →</a>
      </div>
    {/each}
  </div>
{/if}

{#if loading}
  <div class="splash-loading">
    <span class="splash-spinner"></span>
    <span class="splash-text">{$t('common.loading')}</span>
  </div>
{:else if error}
  <div class="splash-error">
    <span class="err-msg">{error}</span>
    <button class="retry-btn" on:click={manualRefresh}>{$t('home.refreshBtn')}</button>
  </div>
{:else if !data || data.totalTokens === 0}
  <div class="splash-empty">
    <span class="empty-title">{$t('common.noData')}</span>
    <span class="empty-hint">{$t('common.noDataHint')}</span>
  </div>
{:else}

  <section class="counter-section">
    <div class="counter-header">
      <span class="counter-label">{$t('home.counterLabel')}</span>
    </div>

    <div class="counter-number" class:refreshing>
      {fmtMain($tTokens)}
    </div>

    <div class="counter-sub">
      <div class="sub-item sub-input">
        <span class="sub-indicator"></span>
        <div class="sub-content">
          <span class="sub-label">{$t('home.input')}</span>
          <span class="sub-value">{fmtShort(data.inputTokens)}</span>
        </div>
      </div>
      <div class="sub-divider"></div>
      <div class="sub-item sub-output">
        <span class="sub-indicator"></span>
        <div class="sub-content">
          <span class="sub-label">{$t('home.output')}</span>
          <span class="sub-value">{fmtShort(data.outputTokens)}</span>
        </div>
      </div>
      <div class="sub-divider"></div>
      <div class="sub-item sub-cache">
        <span class="sub-indicator"></span>
        <div class="sub-content">
          <span class="sub-label">{$t('home.cache')}</span>
          <span class="sub-value">{fmtShort((data.cacheReadTokens||0)+(data.cacheWriteTokens||0))}</span>
        </div>
      </div>
    </div>

    <div class="refresh-bar-track">
      {#if refreshSecs > 0}
        <div class="refresh-bar-fill" style="width: {refreshPct}%"></div>
      {/if}
    </div>
    <div class="refresh-meta">
      <div class="refresh-status">
        {#if refreshSecs > 0}
          {#if countdown > 0}
            <span class="refresh-clock-dot"></span>
            <span>{$t('home.nextRefresh')} {countdown}{$t('home.seconds')}</span>
          {:else}
            <span class="refresh-clock-dot active"></span>
            <span class="refreshing-label">{$t('home.refreshing')}</span>
          {/if}
        {:else}
          <span>{$t('home.manualMode')}</span>
        {/if}
      </div>
      <button class="now-btn" on:click={manualRefresh}>
        {refreshSecs > 0 ? $t('home.refreshNow') : $t('home.refreshBtn')}
      </button>
    </div>
  </section>

  <div class="stats-strip">
    <div class="stat-block stat-block-cost">
      <div class="stat-header">
        <span class="stat-dot"></span>
        <span class="stat-label">{$t('overview.totalCost')}</span>
      </div>
      <span class="stat-value stat-cost">{formattedCost}</span>
    </div>
    <div class="stat-block">
      <div class="stat-header">
        <span class="stat-label">{$t('overview.totalSessions')}</span>
      </div>
      <span class="stat-value">{Math.round($tSessions).toLocaleString()}</span>
    </div>
    <div class="stat-block">
      <div class="stat-header">
        <span class="stat-label">{$t('overview.activeDays')}</span>
      </div>
      <span class="stat-value">{Math.round($tDays).toLocaleString()}</span>
    </div>
  </div>

  <div class="comp-wrap card">
    <div class="comp-header">
      <span class="section-title">Token Composition</span>
    </div>
    <div class="comp-bar">
      <div class="seg seg-input"  style="width:{barsReady ? inputPct     : 0}%" title="{$t('home.input')} {inputPct.toFixed(1)}%">
        {#if inputPct > 9}<span class="seg-lbl">{$t('home.input')} {inputPct.toFixed(0)}%</span>{/if}
      </div>
      <div class="seg seg-output" style="width:{barsReady ? outputPct    : 0}%" title="{$t('home.output')} {outputPct.toFixed(1)}%">
        {#if outputPct > 9}<span class="seg-lbl">{$t('home.output')} {outputPct.toFixed(0)}%</span>{/if}
      </div>
      <div class="seg seg-cr"     style="width:{barsReady ? cacheReadPct : 0}%" title="Cache R {cacheReadPct.toFixed(1)}%">
        {#if cacheReadPct > 9}<span class="seg-lbl">Cache R {cacheReadPct.toFixed(0)}%</span>{/if}
      </div>
      <div class="seg seg-cw"     style="width:{barsReady ? cacheWritePct: 0}%" title="Cache W {cacheWritePct.toFixed(1)}%">
        {#if cacheWritePct > 9}<span class="seg-lbl">Cache W {cacheWritePct.toFixed(0)}%</span>{/if}
      </div>
    </div>
    <div class="comp-legend">
      <span class="leg leg-i"><span class="leg-pill"></span>{$t('home.input')}</span>
      <span class="leg leg-o"><span class="leg-pill"></span>{$t('home.output')}</span>
      <span class="leg leg-cr"><span class="leg-pill"></span>Cache Read</span>
      <span class="leg leg-cw"><span class="leg-pill"></span>Cache Write</span>
    </div>
  </div>

{/if}

<style>
  /* ── Modern Top Bar ─────────────────────────────────────────────────────── */
  .top-bar {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    margin-bottom: 1.5rem;
    padding: 0.75rem 1.125rem;
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    backdrop-filter: blur(12px);
  }

  .live-indicator {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.2rem 0.625rem;
    border-radius: 999px;
    background: var(--green-dim);
    flex-shrink: 0;
  }
  .live-dot {
    position: relative;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
  }
  .live-dot-glow {
    position: absolute;
    left: 0.625rem;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
    animation: livePulse 2s cubic-bezier(0.16, 1, 0.3, 1) infinite;
  }
  @keyframes livePulse {
    0%   { transform: scale(1); opacity: 0.8; }
    50%  { transform: scale(2.6); opacity: 0; }
    100% { transform: scale(1); opacity: 0; }
  }
  .live-label {
    font-family: var(--font-sans);
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--green);
  }

  .range-badge {
    font-family: var(--font-sans);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-dim);
    border: 1px solid var(--accent-dim);
    border-radius: 999px;
    padding: 0.175rem 0.625rem;
  }

  .clock-block {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    margin-left: auto;
    gap: 0;
  }
  .clock-time {
    font-family: var(--font-numeric);
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.01em;
  }
  .clock-date {
    font-family: var(--font-sans);
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
  }

  .cfg-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--control-height);
    height: var(--control-height);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--raised);
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.16s ease;
    flex-shrink: 0;
  }
  .cfg-btn:hover {
    color: var(--text);
    border-color: var(--border-medium);
    transform: translateY(-1px);
  }

  /* ── Linear Hero Counter ────────────────────────────────────────────────── */
  .counter-section {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 3.5rem 2rem 2rem;
    margin-bottom: 1.5rem;
    background: radial-gradient(circle at 50% -20%, var(--accent-dim) 0%, transparent 65%), var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
    overflow: hidden;
  }

  .counter-header {
    margin-bottom: 0.875rem;
  }

  .counter-label {
    font-family: var(--font-sans);
    font-size: 0.8125rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .counter-number {
    font-family: var(--font-numeric);
    font-size: clamp(2.25rem, 6.5vw, 5.25rem);
    font-weight: 700;
    max-width: 100%;
    overflow-wrap: anywhere;
    letter-spacing: -0.04em;
    line-height: 1.1;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    transition: opacity 0.2s;
  }
  .counter-number.refreshing { opacity: 0.55; }

  /* Sub Breakdown Pills */
  .counter-sub {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    margin-top: 1.75rem;
    padding: 0.625rem 1.25rem;
    background: var(--raised);
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
  }
  .sub-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .sub-indicator {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .sub-input .sub-indicator { background: var(--chart-input); }
  .sub-output .sub-indicator { background: var(--chart-output); }
  .sub-cache .sub-indicator { background: var(--chart-cache-read); }

  .sub-content {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .sub-label {
    font-family: var(--font-sans);
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
  }
  .sub-value {
    font-family: var(--font-numeric);
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .sub-divider {
    width: 1px;
    height: 20px;
    background: var(--border-subtle);
  }

  /* Refresh Glow Progress Bar */
  .refresh-bar-track {
    width: 100%;
    height: 3px;
    background: var(--border-subtle);
    border-radius: 999px;
    margin-top: 2rem;
    overflow: hidden;
  }
  .refresh-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent) 0%, var(--accent-hover) 100%);
    box-shadow: 0 0 8px var(--accent-dim);
    border-radius: 999px;
    transition: width 1s linear;
  }

  .refresh-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.625rem;
    font-family: var(--font-sans);
    font-size: 0.75rem;
    color: var(--text-muted);
    width: 100%;
  }
  .refresh-status {
    display: flex;
    align-items: center;
    gap: 0.375rem;
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
    padding: 0.25rem 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--raised);
    font-family: var(--font-sans);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.16s ease;
  }
  .now-btn:hover {
    color: var(--text);
    border-color: var(--border-medium);
    background: var(--hover);
  }

  /* ── Stats Metric Cards (Grid 3) ─────────────────────────────────────────── */
  .stats-strip {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  .stat-block {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 1.35rem 1.5rem;
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .stat-block:hover {
    border-color: var(--border-medium);
    transform: translateY(-2px);
    box-shadow: var(--shadow-md);
  }
  .stat-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .stat-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
  .stat-label {
    font-family: var(--font-sans);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--text-muted);
    text-transform: uppercase;
  }
  .stat-value {
    font-family: var(--font-numeric);
    font-size: 1.875rem;
    font-weight: 700;
    overflow-wrap: anywhere;
    letter-spacing: -0.03em;
    line-height: 1.2;
    color: var(--text);
  }
  .stat-cost {
    color: var(--accent);
  }

  /* ── Composition Bar Card ───────────────────────────────────────────────── */
  .comp-wrap {
    margin-bottom: 1.5rem;
  }
  .comp-header {
    margin-bottom: 0.875rem;
  }
  .comp-header .section-title {
    margin-bottom: 0;
  }

  .comp-bar {
    display: flex;
    height: 28px;
    border-radius: 8px;
    overflow: hidden;
    background: var(--raised);
    padding: 2px;
    gap: 2px;
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.1);
  }
  .seg {
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    min-width: 0;
    border-radius: 6px;
    transition: width 1.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .seg-lbl {
    font-family: var(--font-sans);
    font-size: 0.6875rem;
    font-weight: 700;
    white-space: nowrap;
    padding: 0 4px;
    color: #ffffff;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  }
  .seg-input  { background: var(--chart-input); }
  .seg-output { background: var(--chart-output); }
  .seg-cr     { background: var(--chart-cache-read); }
  .seg-cw     { background: var(--chart-cache-write); }

  .comp-legend {
    display: flex;
    gap: 1.25rem;
    margin-top: 1rem;
    flex-wrap: wrap;
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
  .leg-pill {
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
  .leg-i .leg-pill  { background: var(--chart-input); }
  .leg-o .leg-pill  { background: var(--chart-output); }
  .leg-cr .leg-pill { background: var(--chart-cache-read); }
  .leg-cw .leg-pill { background: var(--chart-cache-write); }

  /* ── Config Panel ───────────────────────────────────────────────────────── */
  .overlay-backdrop {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: var(--overlay);
    backdrop-filter: blur(12px);
    animation: fadeIn 0.15s ease;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .config-panel {
    position: fixed;
    z-index: 201;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(420px, 92vw);
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    padding: 1.5rem;
    box-shadow: var(--shadow-lg);
    backdrop-filter: blur(16px);
  }

  .cfg-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.25rem;
  }
  .cfg-title {
    font-family: var(--font-sans);
    font-size: 1.0625rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
  }
  .cfg-close {
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    background: var(--raised);
    color: var(--text-muted);
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .cfg-close:hover {
    color: var(--rose);
    border-color: var(--rose);
  }

  .cfg-section { margin-bottom: 1.25rem; }
  .cfg-label {
    font-family: var(--font-sans);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 0.5rem;
  }
  .cfg-pills { display: flex; gap: 0.375rem; flex-wrap: wrap; }
  .pill {
    min-height: var(--control-height);
    padding: 0.375rem 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--raised);
    font-family: var(--font-sans);
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.16s ease;
    white-space: nowrap;
  }
  .pill:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .pill.active {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-dim);
    font-weight: 600;
  }
  .pill-eg { opacity: 0.55; font-size: 0.75rem; margin-left: 0.25rem; }

  .cfg-refresh-info {
    margin-top: 0.75rem;
    padding: 0.625rem 0.875rem;
    border-radius: var(--radius-sm);
    background: var(--raised);
    border: 1px solid var(--border-subtle);
  }
  .refresh-info-text {
    font-family: var(--font-sans);
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .settings-link {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }
  .settings-link:hover { text-decoration: underline; }

  /* ── Quota Warning Banner ───────────────────────────────────────────────── */
  .quota-warning-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
  }

  .quota-warning {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 1rem;
    border-radius: var(--radius-md);
    font-size: 0.8125rem;
    border: 1px solid transparent;
    box-shadow: var(--shadow-sm);
  }

  .quota-orange {
    background: var(--amber-dim);
    border-color: var(--amber);
    color: var(--amber);
  }

  .quota-red {
    background: var(--rose-dim);
    border-color: var(--rose);
    color: var(--rose);
  }

  .warn-icon {
    font-size: 0.75rem;
    flex-shrink: 0;
  }

  .warn-text {
    flex: 1;
    min-width: 0;
  }

  .warn-link {
    font-size: 0.75rem;
    font-weight: 600;
    text-decoration: none;
    color: inherit;
    opacity: 0.85;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .warn-link:hover { opacity: 1; text-decoration: underline; }

  /* ── Splash States ──────────────────────────────────────────────────────── */
  .splash-loading, .splash-error, .splash-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.875rem;
    min-height: 360px;
    text-align: center;
    background: var(--surface);
    border: 1px dashed var(--border-subtle);
    border-radius: var(--radius-lg);
  }
  .splash-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--border-medium);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .splash-text {
    font-family: var(--font-sans);
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-muted);
  }

  .err-msg { font-size: 0.875rem; color: var(--rose); }
  .retry-btn {
    margin-top: 0.5rem;
    padding: 0.4rem 1.125rem;
    border: 1px solid var(--rose);
    border-radius: var(--radius-sm);
    background: transparent;
    font-family: var(--font-sans);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--rose);
    cursor: pointer;
    transition: background 0.15s;
  }
  .retry-btn:hover { background: var(--rose-dim); }

  .empty-title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
  }
  .empty-hint { font-size: 0.8125rem; color: var(--text-muted); }

  /* ── Responsive ─────────────────────────────────────────────────────────── */
  @media (max-width: 800px) {
    .counter-section { padding: 2.25rem 1.25rem 1.5rem; }
    .counter-sub {
      flex-direction: column;
      border-radius: var(--radius-md);
      gap: 0.75rem;
      width: 100%;
    }
    .sub-divider { display: none; }
    .stats-strip { grid-template-columns: 1fr; gap: 0.75rem; }
    .top-bar {
      display: grid;
      grid-template-columns: auto auto 1fr auto;
      gap: 0.5rem;
    }
    .clock-block {
      margin-left: 0;
      align-items: flex-end;
      justify-self: end;
    }
    .cfg-btn { justify-self: end; }
  }
</style>
