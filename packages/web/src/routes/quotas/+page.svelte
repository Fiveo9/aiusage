<script>
  import { onMount } from 'svelte'
  import { t } from '$lib/i18n.js'
  import { fetchQuotas } from '$lib/api.js'

  let data = null
  let error = null
  let loading = true

  const TIER_LABEL_KEYS = {
    five_hour: 'quotas.fiveHour',
    seven_day: 'quotas.sevenDay',
    seven_day_opus: 'quotas.sevenDayOpus',
    seven_day_sonnet: 'quotas.sevenDaySonnet',
    seven_day_omelette: 'quotas.sevenDayOmelette',
    weekly_limit: 'quotas.weeklyLimit',
  }

  const TOOL_LABEL_KEYS = {
    'claude-code': 'quotas.toolLabels.claude-code',
    codex: 'quotas.toolLabels.codex',
  }

  async function load() {
    loading = true
    error = null
    try {
      data = await fetchQuotas()
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load quota data'
      data = null
    } finally {
      loading = false
    }
  }

  onMount(load)

  // Fallback: convert snake_case tier names to readable labels
  // e.g. "seven_day_omelette" → "7d Omelette", "five_hour" → "5h"
  function formatUnknownTier(name) {
    return name
      .split('_')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
      .replace(/^Five Hour/i, '5h')
      .replace(/^Seven Day/i, '7d')
      .replace(/^Weekly Limit/i, 'Weekly')
  }

  function tierLabel(name) {
    const key = TIER_LABEL_KEYS[name]
    return key ? $t(key) : formatUnknownTier(name)
  }

  function toolLabel(tool) {
    const key = TOOL_LABEL_KEYS[tool]
    return key ? $t(key) : tool
  }

  function utilizationColor(pct) {
    if (pct >= 90) return 'red'
    if (pct >= 70) return 'orange'
    return 'green'
  }

  function utilizationBarColor(pct) {
    if (pct >= 90) return 'var(--rose)'
    if (pct >= 70) return 'var(--amber)'
    return 'var(--green)'
  }

  function countdownStr(resetsAt) {
    if (!resetsAt) return null
    const diffMs = new Date(resetsAt).getTime() - Date.now()
    if (diffMs <= 0) return null
    const hours = Math.floor(diffMs / (1000 * 60 * 60))
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))
    if (hours > 24) {
      const days = Math.floor(hours / 24)
      return `${days}d ${hours % 24}h`
    }
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
  }

  function formatQueryTime(ms) {
    if (!ms) return $t('quotas.never')
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  /** True if this quota card has any interesting data to show */
  function hasContent(quota) {
    return quota.credentialStatus !== 'not_found'
  }

  /** Quotas with credentials (to show), plus not_found ones for context */
  $: visibleQuotas = data?.quotas ?? []
  $: activeQuotas = visibleQuotas.filter(q => q.credentialStatus !== 'not_found')
  $: inactiveQuotas = visibleQuotas.filter(q => q.credentialStatus === 'not_found')
</script>

<svelte:head>
  <title>{$t('quotas.title')} — AIUsage</title>
</svelte:head>

<div class="page-header">
  <div class="page-header-row">
    <div>
      <h1>{$t('quotas.title')}</h1>
      <p>{$t('quotas.desc')}</p>
    </div>
    <button class="refresh-btn" on:click={load} disabled={loading}>
      <span class="refresh-icon" class:spinning={loading}>↻</span>
      {loading ? $t('quotas.refreshing') : $t('quotas.refresh')}
    </button>
  </div>
</div>

{#if loading && !data}
  <div class="card state-msg">
    <span class="loading-spin"></span>
    <span>{$t('common.loading')}</span>
  </div>
{:else if error}
  <div class="card state-msg error"><p>{error}</p></div>
{:else if visibleQuotas.length === 0}
  <div class="card state-msg"><p>{$t('common.noData')}</p></div>
{:else}
  <!-- Active tools with credentials -->
  {#if activeQuotas.length > 0}
    <div class="quota-grid">
      {#each activeQuotas as quota (quota.tool)}
        <div class="quota-card card">
          <div class="card-header">
            <span class="tool-name">{toolLabel(quota.tool)}</span>
            <span class="query-time mono">{$t('quotas.lastUpdated')}: {formatQueryTime(quota.queriedAt)}</span>
          </div>

          {#if quota.credentialStatus === 'expired' && !quota.success}
            <div class="status-msg status-warn">
              <span class="status-icon">⚠</span>
              <div>
                <div class="status-title">{$t('quotas.expired')}</div>
                <div class="status-hint">{$t('quotas.expiredHint')}</div>
              </div>
            </div>
          {:else if quota.credentialStatus === 'parse_error'}
            <div class="status-msg status-error">
              <span class="status-icon">✕</span>
              <div>
                <div class="status-title">{$t('quotas.queryFailed')}</div>
                {#if quota.credentialMessage}
                  <div class="status-hint">{quota.credentialMessage}</div>
                {/if}
              </div>
            </div>
          {:else if !quota.success}
            <div class="status-msg status-error">
              <span class="status-icon">✕</span>
              <div>
                <div class="status-title">{$t('quotas.queryFailed')}</div>
                {#if quota.error}
                  <div class="status-hint">{quota.error}</div>
                {/if}
              </div>
            </div>
          {:else if quota.tiers.length === 0}
            <div class="status-msg status-neutral">
              <span class="status-icon">○</span>
              <div class="status-title">{$t('quotas.noTiers')}</div>
            </div>
          {:else}
            <div class="tiers">
              {#each quota.tiers as tier (tier.name)}
                {@const pct = Math.min(Math.round(tier.utilization), 100)}
                {@const countdown = countdownStr(tier.resetsAt)}
                <div class="tier-row">
                  <div class="tier-label">
                    <span class="tier-name">{tierLabel(tier.name)}</span>
                    {#if countdown}
                      <span class="tier-reset mono">↻ {countdown}</span>
                    {/if}
                  </div>
                  <div class="tier-bar-wrap">
                    <div class="tier-bar">
                      <div
                        class="tier-fill"
                        style="width: {pct}%; background: {utilizationBarColor(tier.utilization)}"
                      ></div>
                    </div>
                    <span class="tier-pct mono" style="color: {utilizationBarColor(tier.utilization)}">{pct}%</span>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Inactive tools (no credentials) -->
  {#if inactiveQuotas.length > 0}
    <div class="section-title" style="margin-top: {activeQuotas.length > 0 ? '2rem' : '0'}">
      {$t('common.noData')}
    </div>
    <div class="inactive-list">
      {#each inactiveQuotas as quota (quota.tool)}
        <div class="inactive-card card">
          <span class="tool-name">{toolLabel(quota.tool)}</span>
          <div class="inactive-hint">
            <span class="hint-icon">○</span>
            <span>{$t('quotas.noCredentials')} — {$t('quotas.noCredentialsHint')}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .page-header-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .refresh-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 1.1rem;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
    box-shadow: var(--shadow-sm);
    transition: all 0.16s ease;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .refresh-btn:hover:not(:disabled) {
    background: var(--hover);
    border-color: var(--border-medium);
    color: var(--accent);
    transform: translateY(-1px);
    box-shadow: var(--shadow-md);
  }
  .refresh-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .refresh-icon {
    font-size: 0.875rem;
    display: inline-block;
  }
  .refresh-icon.spinning {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }

  .quota-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 1.25rem;
  }

  .quota-card {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 1.5rem;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .tool-name {
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: -0.015em;
    color: var(--text);
  }

  .query-time {
    font-size: 0.75rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  /* Tiers */
  .tiers {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .tier-row {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .tier-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .tier-name {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .tier-reset {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
    padding: 0.1rem 0.45rem;
    background: var(--raised);
    border-radius: 999px;
    border: 1px solid var(--border-subtle);
  }

  .tier-bar-wrap {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .tier-bar {
    flex: 1;
    height: 7px;
    background: var(--raised);
    border-radius: 999px;
    border: 1px solid var(--border-subtle);
    overflow: hidden;
  }

  .tier-fill {
    height: 100%;
    border-radius: inherit;
    box-shadow: 0 0 6px currentColor;
    transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .tier-pct {
    font-family: var(--font-numeric);
    font-variant-numeric: tabular-nums;
    font-size: 0.8125rem;
    font-weight: 700;
    width: 3.25rem;
    text-align: right;
    flex-shrink: 0;
  }

  /* Status messages */
  .status-msg {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
  }

  .status-warn {
    background: var(--amber-dim);
    color: var(--amber);
    border: 1px solid var(--amber);
  }

  .status-error {
    background: var(--rose-dim);
    color: var(--rose);
    border: 1px solid var(--rose);
  }

  .status-neutral {
    background: var(--raised);
    color: var(--text-muted);
    border: 1px solid var(--border-subtle);
  }

  .status-icon {
    font-size: 0.875rem;
    flex-shrink: 0;
    margin-top: 0.05rem;
  }

  .status-title {
    font-weight: 600;
    margin-bottom: 0.15rem;
  }

  .status-hint {
    font-size: 0.75rem;
    opacity: 0.85;
    line-height: 1.4;
  }

  /* Inactive list */
  .inactive-list {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .inactive-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 1.35rem;
    opacity: 0.65;
  }

  .inactive-hint {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .hint-icon {
    font-size: 0.75rem;
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

  @media (max-width: 800px) {
    .quota-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
