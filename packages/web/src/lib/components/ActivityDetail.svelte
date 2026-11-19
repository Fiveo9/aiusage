<script>
  import { browser } from '$app/environment'
  import { page } from '$app/stores'
  import { t } from '$lib/i18n.js'
  import { formatCost, formatDateTime, formatTokens } from '$lib/stores.js'
  import { activityDetailUrl, fetchActivityDetail, sessionDetailUrl } from '$lib/api.js'
  import { createRequestTracker } from '$lib/sessions-paging.js'

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
<a href={project ? '/projects' : '/tool-calls'}>← {$t(project ? 'projects.title' : 'toolCalls.title')}</a>
<h1>{params.name}</h1>
{#if error}
  <p class="state-msg error">{error}</p>
{:else if !data}
  <p class="state-msg">{$t('common.loading')}</p>
{:else}
  <div class="card">
    <table>
      <thead><tr>
        <th>{$t('sessions.time')}</th><th>{$t('activity.device')}</th><th>{$t('sessions.detail.meta.sessionId')}</th>
        {#if project}<th>{$t('projects.tokens')}</th><th>{$t('projects.cost')}</th>
        {:else}<th>{$t('sessions.assistant')}</th><th>{$t('activity.callIndex')}</th>{/if}
      </tr></thead>
      <tbody>
        {#each (project ? data.sessions : data.events) as row}
          <tr>
            <td>{formatDateTime(row.ts)}</td><td>{row.deviceInstanceId || '—'}</td>
            <td>{#if row.sessionId}<a href={sessionDetailUrl(row.sessionId, row.deviceInstanceId, params.tool)}>{row.sessionId}</a>{:else}—{/if}</td>
            {#if project}<td>{formatTokens(row.tokens)}</td><td>{formatCost(row.cost)}</td>
            {:else}<td>{row.tool}</td><td>{row.callIndex}</td>{/if}
          </tr>
        {:else}<tr><td colspan="5">{$t('common.noData')}</td></tr>{/each}
      </tbody>
    </table>
  </div>
  <nav>
    {#if data.page > 1}<a href={activityDetailUrl($page.url.pathname, { ...params, page: data.page - 1 })}>← {$t('common.previous')}</a>{/if}
    {data.page} / {Math.max(1, Math.ceil(data.total / data.pageSize))}
    {#if data.page * data.pageSize < data.total}<a href={activityDetailUrl($page.url.pathname, { ...params, page: data.page + 1 })}>{$t('common.next')} →</a>{/if}
  </nav>
{/if}
