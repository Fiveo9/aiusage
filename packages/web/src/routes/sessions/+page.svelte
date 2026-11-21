<script>
  import '$lib/activity.css'
  import { dateRange, selectedDevice, selectedTool, formatTokens, formatCost, formatDateTime, formatNumber } from '$lib/stores.js'
  import { fetchSessions, sessionDetailUrl } from '$lib/api.js'
  import { createRequestTracker, resolvePage } from '$lib/sessions-paging.js'
  import { t } from '$lib/i18n.js'
  import DateRangeSelector from '$lib/components/DateRangeSelector.svelte'
  import DeviceSelector from '$lib/components/DeviceSelector.svelte'
  import ToolSelector from '$lib/components/ToolSelector.svelte'

  let data = null
  let error = null
  let loading = true
  let page = 1
  const pageSize = 50
  const beginRequest = createRequestTracker()

  function formatDuration(ms) {
    if (!ms || ms < 1000) return '< 1s'
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    if (m === 0) return `${s}s`
    return `${m}m ${s % 60}s`
  }

  async function loadData() {
    // A response only counts while its request is the latest one: a slow answer for
    // an earlier filter or page must not replace the list or move the page.
    const isLatest = beginRequest()
    const requestedPage = page
    loading = true
    error = null
    try {
      const response = await fetchSessions({
        ...$dateRange,
        device: $selectedDevice,
        tool: $selectedTool,
        page: requestedPage,
        pageSize,
      })
      if (!isLatest()) return
      data = response
      page = resolvePage(response, requestedPage, pageSize)
    } catch (e) {
      if (!isLatest()) return
      error = e instanceof Error ? e.message : 'Failed to load data'
      data = null
    } finally {
      if (isLatest()) loading = false
    }
  }

  $: $dateRange, $selectedDevice, $selectedTool, (page = 1)
  $: $dateRange, $selectedDevice, $selectedTool, page, loadData()

  function nextPage() {
    if (data && page * pageSize < data.total) page++
  }

  function prevPage() {
    if (page > 1) page--
  }

  function goToDetail(session) {
    window.location.href = sessionDetailUrl(session.sessionId, session.deviceInstanceId, $selectedTool)
  }
</script>

<svelte:head>
  <title>{$t('sessions.title')} — AIUsage</title>
</svelte:head>

<div class="page-header">
  <h1>{$t('sessions.title')}</h1>
  <p>{$t('sessions.desc')}</p>
</div>

<div class="filter-bar">
  <DateRangeSelector />
  <DeviceSelector />
  <ToolSelector />
</div>

{#if loading}
  <div class="card state-msg" role="status">{$t('common.loading')}</div>
{:else if error}
  <div class="card state-msg error" role="alert">{error}</div>
{:else if !data?.sessions.length}
  <div class="card state-msg">
    <h2>{$t('sessions.noData')}</h2>
    <p>{$t('sessions.noDataHint')}</p>
  </div>
{:else}
  <div class="card activity-card">
    <div class="activity-card-header">
      <div class="activity-heading">
        <h2 class="section-title" id="sessions-list-title">{$t('activity.sessionList')}</h2>
        <span class="activity-count mono">{formatNumber(data.total)}</span>
      </div>
      <span class="activity-hint">{$t('activity.openSession')}</span>
    </div>
    <!-- This named scroll region is focusable so keyboard users can scroll the table. -->
    <!-- svelte-ignore a11y-no-noninteractive-tabindex -->
    <div class="activity-table-scroll" role="region" aria-labelledby="sessions-list-title" tabindex="0">
    <table class="activity-table">
      <thead>
        <tr>
          <th>{$t('sessions.time')}</th>
          <th>{$t('sessions.tool')}</th>
          <th>{$t('sessions.model')}</th>
          <th class="activity-number">{$t('sessions.duration')}</th>
          <th class="activity-number">{$t('sessions.toolCalls')}</th>
          <th class="activity-number">{$t('sessions.input')}</th>
          <th class="activity-number">{$t('sessions.output')}</th>
          <th class="activity-number">{$t('sessions.cost')}</th>
        </tr>
      </thead>
      <tbody>
        {#each data.sessions as session}
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-interactive-element-to-noninteractive-role -->
          <tr class="activity-clickable" on:click={() => goToDetail(session)}>
            <td class="mono activity-time"><a class="activity-link" href={sessionDetailUrl(session.sessionId, session.deviceInstanceId, $selectedTool)} on:click|stopPropagation>{formatDateTime(session.ts)}</a></td>
            <td><span class="activity-badge">{session.tool}</span></td>
            <td class="mono activity-model">{session.model}</td>
            <td class="mono activity-number">{formatDuration(session.duration)}</td>
            <td class="mono activity-number">{formatNumber(session.toolCallCount ?? 0)}</td>
            <td class="mono green activity-number">{formatTokens(session.inputTokens)}</td>
            <td class="mono blue activity-number">{formatTokens(session.outputTokens)}</td>
            <td class="mono accent activity-number">{formatCost(session.cost)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    </div>

    <nav class="activity-pagination" aria-label={$t('activity.pagination')}>
      <span class="activity-page-info mono">{$t('common.page')} {page} / {Math.ceil(data.total / pageSize)}</span>
      <div class="activity-page-actions">
        <button class="activity-page-button" on:click={prevPage} disabled={page <= 1}>← {$t('common.previous')}</button>
        <button class="activity-page-button" on:click={nextPage} disabled={page * pageSize >= data.total}>{$t('common.next')} →</button>
      </div>
    </nav>
  </div>
{/if}
