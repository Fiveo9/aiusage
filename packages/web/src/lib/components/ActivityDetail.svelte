<script>
  import '$lib/activity.css'
  import { browser } from '$app/environment'
  import { page } from '$app/stores'
  import { t } from '$lib/i18n.js'
  import { formatCost, formatDateTime, formatTokens, formatNumber } from '$lib/stores.js'
  import { activityDetailUrl, fetchActivityDetail, sessionDetailUrl } from '$lib/api.js'
  import { createRequestTracker } from '$lib/sessions-paging.js'
  import { sessionLabel } from '$lib/session-title.js'
  import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-svelte'

  export let kind
  const beginRequest = createRequestTracker()
  let data
  let error
  $: params = Object.fromEntries($page.url.searchParams)
  $: project = kind === 'project'
  $: if (browser) load(kind, params)

  async function load(kind, params) {
    const current = beginRequest()
    data = error = null
    try {
      const result = await fetchActivityDetail(kind, params)
      if (current()) data = result
    } catch (cause) {
      if (current()) error = cause.message
    }
  }
</script>

<svelte:head><title>{params.name || ''} — {$t(project ? 'projects.sessions' : 'toolCalls.title')}</title></svelte:head>
<div class="page-header activity-detail-header">
  <a class="activity-back-link" href={project ? '/projects' : '/tool-calls'}>
    <ArrowLeft size={14} strokeWidth={1.9} />
    <span>{$t(project ? 'projects.title' : 'toolCalls.title')}</span>
  </a>
  <h1>{params.name}</h1>
  <p>{$t(project ? 'activity.projectDetail' : 'activity.toolDetail')}</p>
</div>
{#if error}
  <p class="card state-msg error" role="alert">{error}</p>
{:else if !data}
  <div class="card state-msg" role="status">
    <span class="loading-spin"></span>
    <span>{$t('common.loading')}</span>
  </div>
{:else}
  <div class="card activity-card">
    <div class="activity-card-header">
      <div class="activity-heading">
        <h2 class="section-title" id="activity-detail-title">{$t(project ? 'activity.sessionList' : 'activity.events')}</h2>
        <span class="activity-count mono">{formatNumber(data.total)}</span>
      </div>
    </div>
    {#if (project ? data.sessions : data.events).length}
    <!-- This named scroll region is focusable so keyboard users can scroll the table. -->
    <!-- svelte-ignore a11y-no-noninteractive-tabindex -->
    <div class="activity-table-scroll" role="region" aria-labelledby="activity-detail-title" tabindex="0">
    <table class="activity-table">
      <thead><tr>
        <th>{$t(project ? 'sessions.session' : 'sessions.time')}</th><th>{$t('activity.device')}</th><th>{$t('sessions.detail.meta.sessionId')}</th>
        {#if project}<th class="activity-number">{$t('projects.tokens')}</th><th class="activity-number">{$t('projects.cost')}</th>
        {:else}<th>{$t('sessions.assistant')}</th><th class="activity-number">{$t('activity.callIndex')}</th>{/if}
      </tr></thead>
      <tbody>
        {#each (project ? data.sessions : data.events) as row}
          <tr>
            {#if project}
              <td class="activity-session-cell">
                <a class="activity-link activity-session-title" href={sessionDetailUrl(row.sessionId, row.deviceInstanceId, params.tool)}>{sessionLabel(row, $t('sessions.unnamed'))}</a>
                <span class="activity-session-time mono">{formatDateTime(row.ts)}</span>
              </td>
            {:else}<td class="mono activity-time">{formatDateTime(row.ts)}</td>{/if}
            <td class="mono activity-id">{row.deviceInstanceId || '—'}</td>
            <td class="mono activity-id">{#if row.sessionId}<a class="activity-link" href={sessionDetailUrl(row.sessionId, row.deviceInstanceId, params.tool)}>{row.sessionId}</a>{:else}—{/if}</td>
            {#if project}<td class="mono activity-number">{formatTokens(row.tokens)}</td><td class="mono accent activity-number">{formatCost(row.cost)}</td>
            {:else}<td><span class="activity-badge">{row.tool}</span></td><td class="mono activity-number">{row.callIndex}</td>{/if}
          </tr>
        {/each}
      </tbody>
    </table>
    </div>
    {:else}
      <div class="state-msg">
        <h2>{$t(project ? 'sessions.noData' : 'toolCalls.noData')}</h2>
        <p>{$t(project ? 'sessions.noDataHint' : 'toolCalls.noDataHint')}</p>
      </div>
    {/if}
    <nav class="activity-pagination" aria-label={$t('activity.pagination')}>
      <span class="activity-page-info mono">{$t('common.page')} {data.page} / {Math.max(1, Math.ceil(data.total / data.pageSize))}</span>
      <div class="activity-page-actions">
        {#if data.page > 1}
          <a class="activity-page-button" href={activityDetailUrl($page.url.pathname, { ...params, page: data.page - 1 })}>
            <ChevronLeft size={14} strokeWidth={1.9} />
            <span>{$t('common.previous')}</span>
          </a>
        {:else}
          <button class="activity-page-button" disabled>
            <ChevronLeft size={14} strokeWidth={1.9} />
            <span>{$t('common.previous')}</span>
          </button>
        {/if}
        {#if data.page * data.pageSize < data.total}
          <a class="activity-page-button" href={activityDetailUrl($page.url.pathname, { ...params, page: data.page + 1 })}>
            <span>{$t('common.next')}</span>
            <ChevronRight size={14} strokeWidth={1.9} />
          </a>
        {:else}
          <button class="activity-page-button" disabled>
            <span>{$t('common.next')}</span>
            <ChevronRight size={14} strokeWidth={1.9} />
          </button>
        {/if}
      </div>
    </nav>
  </div>
{/if}
