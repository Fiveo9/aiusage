<script>
  import { dateRange, setRange, setCustomRange } from '../stores.js'
  import { t, lang } from '../i18n.js'
  import DropdownSelect from './ui/DropdownSelect.svelte'
  import { CalendarDays, CalendarRange, ArrowRight } from 'lucide-svelte'

  let showCustom = false
  let customFrom = ''
  let customTo = ''
  let customWrapEl = null

  // Generate last 12 months, always include persisted month if missing
  function getMonths() {
    const months = []
    const now = new Date()
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      months.push(value)
    }
    return months
  }

  const baseMonths = getMonths()
  $: selectedMonth = $dateRange.month || ''
  $: months = selectedMonth && !baseMonths.includes(selectedMonth)
    ? [selectedMonth, ...baseMonths]
    : baseMonths

  $: monthOptions = (() => {
    void $lang
    return [
      { value: '', label: $t('range.pickMonth') },
      ...months.map((m) => ({ value: m, label: formatMonthLabel(m) })),
    ]
  })()

  function handleRangeChange(range) {
    setRange(range)
    showCustom = false
  }

  function handleMonthSelect(e) {
    const val = e.detail
    if (!val) {
      setRange($dateRange.range || 'day')
      return
    }
    const [y, m] = val.split('-').map(Number)
    const from = `${val}-01`
    const lastDay = new Date(y, m, 0).getDate()
    const to = `${val}-${String(lastDay).padStart(2, '0')}`
    setCustomRange(from, to, val)
    showCustom = false
  }

  function handleCustomRange() {
    if (customFrom && customTo && customFrom <= customTo) {
      setCustomRange(customFrom, customTo)
      showCustom = false
    }
  }

  function toggleCustom() {
    if (!showCustom && $dateRange.from && $dateRange.to && !$dateRange.month) {
      customFrom = $dateRange.from
      customTo = $dateRange.to
    }
    showCustom = !showCustom
  }

  function handleWindowClick(e) {
    if (showCustom && customWrapEl && !customWrapEl.contains(e.target)) {
      showCustom = false
    }
  }

  function handleWindowKeydown(e) {
    if (showCustom && e.key === 'Escape') {
      showCustom = false
    }
  }

  $: activeDay = !selectedMonth && $dateRange.range === 'day' && !$dateRange.from
  $: activeWeek = !selectedMonth && $dateRange.range === 'week' && !$dateRange.from
  $: activeMonth = !selectedMonth && $dateRange.range === 'month' && !$dateRange.from
  $: activeLast30 = !selectedMonth && $dateRange.range === 'last30' && !$dateRange.from
  $: activeAll = !selectedMonth && $dateRange.range === 'all' && !$dateRange.from
  $: activeCustom = showCustom || Boolean($dateRange.from && !selectedMonth)

  function formatMonthLabel(val) {
    const [y, m] = val.split('-')
    const monthNames = {
      en: ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      zh: ['', '1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
    }
    const names = monthNames[$lang] || monthNames.en
    return `${y} ${names[parseInt(m, 10)]}`
  }
</script>

<svelte:window on:mousedown={handleWindowClick} on:keydown={handleWindowKeydown} />

<div class="date-range">
  <div class="segmented" role="group" aria-label={$t('home.timeRange')}>
    <button type="button" class="segmented-btn" class:active={activeDay} on:click={() => handleRangeChange('day')}>
      {$t('range.today')}
    </button>
    <button type="button" class="segmented-btn" class:active={activeWeek} on:click={() => handleRangeChange('week')}>
      {$t('range.week')}
    </button>
    <button type="button" class="segmented-btn" class:active={activeMonth} on:click={() => handleRangeChange('month')}>
      {$t('range.month')}
    </button>
    <button type="button" class="segmented-btn" class:active={activeLast30} on:click={() => handleRangeChange('last30')}>
      {$t('range.last30')}
    </button>
    <button type="button" class="segmented-btn" class:active={activeAll} on:click={() => handleRangeChange('all')}>
      {$t('range.allTime')}
    </button>
  </div>

  <DropdownSelect
    options={monthOptions}
    value={selectedMonth}
    placeholder={$t('range.pickMonth')}
    active={Boolean(selectedMonth)}
    icon={CalendarDays}
    minWidth="9.5rem"
    ariaLabel={$t('range.pickMonth')}
    on:change={handleMonthSelect}
  />

  <div class="custom-wrap" bind:this={customWrapEl}>
    <button
      type="button"
      class="custom-toggle"
      class:active={activeCustom}
      on:click={toggleCustom}
      title={$t('common.customRange')}
      aria-label={$t('common.customRange')}
      aria-expanded={showCustom}
    >
      <CalendarRange size={14} strokeWidth={1.85} />
    </button>

    {#if showCustom}
      <div class="custom-popover" role="dialog" aria-label={$t('common.customRange')}>
        <div class="custom-inputs">
          <input type="date" bind:value={customFrom} aria-label={$t('range.from')} />
          <span class="arrow" aria-hidden="true"><ArrowRight size={13} strokeWidth={1.8} /></span>
          <input type="date" bind:value={customTo} aria-label={$t('range.to')} />
        </div>
        <button
          type="button"
          class="eng-btn eng-btn-primary apply-btn"
          on:click={handleCustomRange}
          disabled={!customFrom || !customTo || customFrom > customTo}
        >
          {$t('common.apply')}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .date-range {
    display: flex;
    max-width: 100%;
    min-width: 0;
    align-items: center;
    gap: 0.375rem;
    flex-wrap: wrap;
  }

  .custom-wrap {
    position: relative;
    display: inline-flex;
  }

  .custom-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--control-height);
    height: var(--control-height);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text-secondary);
    cursor: pointer;
    transition: border-color 0.14s ease, color 0.14s ease, background-color 0.14s ease;
  }

  .custom-toggle:hover {
    border-color: var(--border-medium);
    color: var(--text);
    background: var(--raised);
  }

  .custom-toggle.active {
    background: var(--accent-dim);
    border-color: color-mix(in oklch, var(--accent) 45%, transparent);
    color: var(--accent-strong);
  }

  .custom-popover {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 260;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    background: var(--surface-elevated);
    border: 1px solid var(--border-medium);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    animation: popFade 0.12s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes popFade {
    from { opacity: 0; transform: translateY(-3px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .custom-inputs {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .arrow {
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
  }

  input[type='date'] {
    height: var(--control-height);
    padding: 0 0.5rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-family: var(--mono);
    background: var(--raised);
    color: var(--text);
    outline: none;
    transition: border-color 0.14s ease;
  }

  input[type='date']:focus {
    border-color: var(--accent);
    background: var(--surface);
  }

  @media (max-width: 640px) {
    .segmented {
      max-width: 100%;
      overflow-x: auto;
    }
    .custom-popover {
      left: auto;
      right: 0;
      flex-direction: column;
      align-items: stretch;
    }
    .custom-inputs {
      flex-wrap: wrap;
    }
  }
</style>
