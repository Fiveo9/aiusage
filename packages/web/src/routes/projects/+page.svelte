<script>
  import '$lib/activity.css'
  import { dateRange, selectedDevice, selectedTool, formatTokens, formatCost, formatNumber } from '$lib/stores.js'
  import { fetchProjects, activityDetailUrl } from '$lib/api.js'
  import { t } from '$lib/i18n.js'
  import DateRangeSelector from '$lib/components/DateRangeSelector.svelte'
  import DeviceSelector from '$lib/components/DeviceSelector.svelte'
  import ToolSelector from '$lib/components/ToolSelector.svelte'

  let data = null
  let error = null
  let loading = true

  async function loadData() {
    loading = true
    error = null
    try {
      data = await fetchProjects({ ...$dateRange, device: $selectedDevice, tool: $selectedTool })
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load data'
      data = null
    } finally {
      loading = false
    }
  }

  $: $dateRange, $selectedDevice, $selectedTool, loadData()
</script>

<svelte:head>
  <title>{$t('projects.title')} — AIUsage</title>
</svelte:head>

<div class="page-header">
  <h1>{$t('projects.title')}</h1>
  <p>{$t('projects.desc')}</p>
</div>

<div class="filter-bar">
  <DateRangeSelector />
  <DeviceSelector />
  <ToolSelector />
</div>

{#if loading}
  <div class="card state-msg" role="status">
    <span class="loading-spin"></span>
    <span class="loading-text">{$t('common.loading')}</span>
  </div>
{:else if error}
  <div class="card state-msg error" role="alert">{error}</div>
{:else if !data?.projects.length}
  <div class="card state-msg">
    <h2>{$t('projects.noData')}</h2>
    <p>{$t('projects.noDataHint')}</p>
  </div>
{:else}
  <div class="card activity-card">
    <div class="activity-card-header">
      <div class="activity-heading">
        <h2 class="section-title">{$t('activity.projectRanking')}</h2>
        <span class="activity-count mono">{formatNumber(data.projects.length)}</span>
      </div>
      <span class="activity-hint">{$t('activity.openProject')}</span>
    </div>
    <div class="activity-ranking">
    {#each data.projects as proj, i}
      <a class="activity-rank-row" href={activityDetailUrl('/projects/sessions', { ...$dateRange, device: $selectedDevice, tool: $selectedTool, name: proj.name })}>
        <span class="activity-rank mono">{String(i + 1).padStart(2, '0')}</span>
        <div class="activity-rank-body">
          <span class="activity-name mono" title={proj.fullPath || proj.name}>{proj.name}</span>
          {#if proj.fullPath && proj.fullPath !== proj.name}
            <span class="activity-path mono" title={proj.fullPath}>{proj.fullPath}</span>
          {/if}
          <div class="activity-bar-track" aria-hidden="true">
            <div class="activity-bar-fill" style="width: {proj.percentage}%"></div>
          </div>
        </div>
        <div class="activity-stats">
          <span class="activity-stat"><span class="activity-stat-label">{$t('projects.sessions')}</span><span class="activity-stat-value mono">{formatNumber(proj.sessions)}</span></span>
          <span class="activity-stat"><span class="activity-stat-label">{$t('projects.tokens')}</span><span class="activity-stat-value mono">{formatTokens(proj.tokens)}</span></span>
          <span class="activity-stat"><span class="activity-stat-label">{$t('projects.cost')}</span><span class="activity-stat-value mono accent">{formatCost(proj.cost)}</span></span>
          <span class="activity-stat"><span class="activity-stat-label">{$t('projects.share')}</span><span class="activity-stat-value mono">{proj.percentage.toFixed(1)}%</span></span>
        </div>
        <span class="activity-chevron" aria-hidden="true">→</span>
      </a>
    {/each}
    </div>
  </div>
{/if}

<style>
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
</style>
