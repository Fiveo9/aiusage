<script>
  import { onDestroy } from 'svelte'
  import '$lib/activity.css'
  import { dateRange, selectedDevice, selectedTool, formatTokens, formatCost, formatNumber } from '$lib/stores.js'
  import { fetchProjects, activityDetailUrl } from '$lib/api.js'
  import { t } from '$lib/i18n.js'
  import DateRangeSelector from '$lib/components/DateRangeSelector.svelte'
  import DeviceSelector from '$lib/components/DeviceSelector.svelte'
  import ToolSelector from '$lib/components/ToolSelector.svelte'
  import { ChevronRight } from 'lucide-svelte'
  import { createRequestTracker } from '$lib/sessions-paging.js'

  let data = null
  let error = null
  let loading = true
  const beginRequest = createRequestTracker()
  onDestroy(() => { beginRequest() })

  async function loadData() {
    const isLatest = beginRequest()
    loading = true
    error = null
    try {
      const response = await fetchProjects({ ...$dateRange, device: $selectedDevice, tool: $selectedTool })
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

{#if loading && !data}
  <div class="card">
    <div class="skeleton skeleton-line" style="width: 140px; margin-bottom: 1rem;"></div>
    {#each [1, 2, 3, 4] as _}
      <div class="skeleton" style="height: 52px; margin-bottom: 0.5rem;"></div>
    {/each}
  </div>
{:else if error}
  <div class="card state-msg error" role="alert">{error}</div>
{:else if !data?.projects.length}
  <div class="card state-msg">
    <h2>{$t('projects.noData')}</h2>
    <p>{$t('projects.noDataHint')}</p>
  </div>
{:else}
  <div class="card activity-card" class:is-stale={loading}>
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
            <span class="activity-stat"><span class="activity-stat-label">{$t('projects.cost')}</span><span class="activity-stat-value mono accent">{$formatCost(proj.cost)}</span></span>
            <span class="activity-stat"><span class="activity-stat-label">{$t('projects.share')}</span><span class="activity-stat-value mono">{proj.percentage.toFixed(1)}%</span></span>
          </div>
          <span class="activity-chevron" aria-hidden="true"><ChevronRight size={15} strokeWidth={1.85} /></span>
        </a>
      {/each}
    </div>
  </div>
{/if}
