<script>
  import { onMount } from 'svelte'
  import { t } from '$lib/i18n.js'
  import { fetchQuotas } from '$lib/api.js'
  import { RefreshCw, AlertTriangle, XCircle, CircleDashed } from 'lucide-svelte'

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
  function formatUnknownTier(name) {
    return name
      .split('_')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
      .replace(/^Five Hour/i, '5h')
      .replace(/^Seven Day/i, '7d')
      .replace(/^Weekly Limit/i, 'Weekly')
  }

  function tierLabel(name, translate) {
    const key = TIER_LABEL_KEYS[name]
    return key ? translate(key) : formatUnknownTier(name)
  }

  function toolLabel(tool, translate) {
    const key = TOOL_LABEL_KEYS[tool]
    return key ? translate(key) : tool
  }

  function utilizationBarColor(pct) {
    if (pct >= 90) return 'var(--rose)'
    if (pct >= 70) return 'var(--amber)'
    return 'var(--green)'
  }

  function countdownStr(resetsAt) {
    if (!resetsAt) return null
    const diffMs = new Date(resetsAt).getTime() - Date.now()
    if (!Number.isFinite(diffMs) || diffMs <= 0) return null
    const hours = Math.floor(diffMs / (1000 * 60 * 60))
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))
    if (hours > 24) {
      const days = Math.floor(hours / 24)
      return `${days}d ${hours % 24}h`
    }
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
  }

  function formatQueryTime(ms, translate) {
    if (!ms) return translate('quotas.never')
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

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
    <button type="button" class="eng-btn" on:click={load} disabled={loading}>
      <span class="refresh-icon" class:spinning={loading}>
        <RefreshCw size={13} strokeWidth={1.9} />
      </span>
      <span>{loading ? $t('quotas.refreshing') : $t('quotas.refresh')}</span>
    </button>
  </div>
</div>

{#if loading && !data}
  <div class="quota-grid">
    {#each [1, 2] as _}
      <div class="card quota-card">
        <div class="skeleton skeleton-line" style="width: 40%;"></div>
        <div class="skeleton" style="height: 10px; margin-top: 0.75rem;"></div>
        <div class="skeleton" style="height: 10px;"></div>
      </div>
    {/each}
  </div>
{:else if error}
  <div class="card state-msg error"><p>{error}</p></div>
{:else if visibleQuotas.length === 0}
  <div class="card state-msg"><p>{$t('common.noData')}</p></div>
{:else}
  <div class:is-stale={loading}>
    {#if activeQuotas.length > 0}
      <div class="quota-grid">
        {#each activeQuotas as quota (quota.tool)}
          <div class="quota-card card">
            <div class="card-header">
              <span class="tool-name">{toolLabel(quota.tool, $t)}</span>
              <span class="query-time mono">{$t('quotas.lastUpdated')}: {formatQueryTime(quota.queriedAt, $t)}</span>
            </div>

            {#if quota.credentialStatus === 'expired' && !quota.success}
              <div class="status-msg status-warn">
                <span class="status-icon"><AlertTriangle size={15} strokeWidth={1.9} /></span>
                <div>
                  <div class="status-title">{$t('quotas.expired')}</div>
                  <div class="status-hint">{$t('quotas.expiredHint')}</div>
                </div>
              </div>
            {:else if quota.credentialStatus === 'parse_error'}
              <div class="status-msg status-error">
                <span class="status-icon"><XCircle size={15} strokeWidth={1.9} /></span>
                <div>
                  <div class="status-title">{$t('quotas.queryFailed')}</div>
                  {#if quota.credentialMessage}
                    <div class="status-hint">{quota.credentialMessage}</div>
                  {/if}
                </div>
              </div>
            {:else if !quota.success}
              <div class="status-msg status-error">
                <span class="status-icon"><XCircle size={15} strokeWidth={1.9} /></span>
                <div>
                  <div class="status-title">{$t('quotas.queryFailed')}</div>
                  {#if quota.error}
                    <div class="status-hint">{quota.error}</div>
                  {/if}
                </div>
              </div>
            {:else if quota.tiers.length === 0}
              <div class="status-msg status-neutral">
                <span class="status-icon"><CircleDashed size={15} strokeWidth={1.9} /></span>
                <div class="status-title">{$t('quotas.noTiers')}</div>
              </div>
            {:else}
              <div class="tiers">
                {#each quota.tiers as tier (tier.name)}
                  {@const pct = Math.min(Math.round(tier.utilization), 100)}
                  {@const countdown = countdownStr(tier.resetsAt)}
                  <div class="tier-row">
                    <div class="tier-label">
                      <span class="tier-name">{tierLabel(tier.name, $t)}</span>
                      {#if countdown}
                        <span class="tier-reset mono">
                          <RefreshCw size={10} strokeWidth={2} />
                          <span>{countdown}</span>
                        </span>
                      {/if}
                    </div>
                    <div class="tier-bar-wrap">
                      <div class="tier-bar">
                        <span class="tier-tick" style="left: 70%" aria-hidden="true"></span>
                        <span class="tier-tick" style="left: 90%" aria-hidden="true"></span>
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

    {#if inactiveQuotas.length > 0}
      <div class="section-title" style="margin-top: {activeQuotas.length > 0 ? '1.75rem' : '0'}">
        {$t('common.noData')}
      </div>
      <div class="inactive-list">
        {#each inactiveQuotas as quota (quota.tool)}
          <div class="inactive-card card">
            <span class="tool-name">{toolLabel(quota.tool, $t)}</span>
            <div class="inactive-hint">
              <span class="hint-icon"><CircleDashed size={13} strokeWidth={1.85} /></span>
              <span>{$t('quotas.noCredentials')} — {$t('quotas.noCredentialsHint')}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .refresh-icon {
    display: inline-flex;
    align-items: center;
  }

  .refresh-icon.spinning {
    animation: spin 0.9s linear infinite;
  }

  .quota-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 1rem;
  }

  .quota-card {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .tool-name {
    font-size: var(--text-base);
    font-weight: 650;
    letter-spacing: -0.015em;
    color: var(--text);
  }

  .query-time {
    font-size: var(--text-2xs);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .tiers {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .tier-row {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .tier-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .tier-name {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-secondary);
  }

  .tier-reset {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: var(--text-2xs);
    font-weight: 500;
    color: var(--text-muted);
    padding: 0.1rem 0.45rem;
    background: var(--raised);
    border-radius: var(--radius-xs);
    border: 1px solid var(--border-subtle);
  }

  .tier-bar-wrap {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .tier-bar {
    position: relative;
    flex: 1;
    height: 6px;
    background: var(--raised);
    border-radius: 3px;
    overflow: hidden;
  }

  .tier-tick {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--border-medium);
    z-index: 2;
    opacity: 0.7;
  }

  .tier-fill {
    position: relative;
    z-index: 1;
    height: 100%;
    border-radius: inherit;
    transition: width 0.35s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .tier-pct {
    font-size: var(--text-xs);
    font-weight: 650;
    width: 3rem;
    text-align: right;
    flex-shrink: 0;
  }

  .status-msg {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    padding: 0.75rem 0.875rem;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
  }

  .status-warn {
    background: var(--amber-dim);
    color: var(--amber);
    border: 1px solid color-mix(in oklch, var(--amber) 30%, transparent);
  }

  .status-error {
    background: var(--rose-dim);
    color: var(--rose);
    border: 1px solid color-mix(in oklch, var(--rose) 30%, transparent);
  }

  .status-neutral {
    background: var(--raised);
    color: var(--text-muted);
    border: 1px solid var(--border-subtle);
  }

  .status-icon {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    margin-top: 0.1rem;
  }

  .status-title {
    font-weight: 600;
    margin-bottom: 0.125rem;
  }

  .status-hint {
    font-size: var(--text-2xs);
    opacity: 0.85;
    line-height: 1.45;
  }

  .inactive-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .inactive-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem;
    padding: 0.875rem 1.125rem;
    opacity: 0.68;
  }

  .inactive-hint {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .hint-icon {
    display: inline-flex;
    align-items: center;
  }

  @media (max-width: 800px) {
    .quota-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
