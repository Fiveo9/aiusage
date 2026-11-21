<script>
  import '$lib/activity.css'
  import { afterNavigate, goto } from '$app/navigation'
  import { onDestroy } from 'svelte'
  import { dateRange, selectedDevice, selectedTool, formatTokens, formatCost, formatDateTime, formatNumber } from '$lib/stores.js'
  import { fetchSessions, sessionDetailUrl } from '$lib/api.js'
  import { createRequestTracker, resolvePage } from '$lib/sessions-paging.js'
  import { sessionLabel } from '$lib/session-title.js'
  import { readSessionQuery, sessionListUrl, sessionFilterKey } from '$lib/session-query.js'
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
  let query = ''
  let sort = 'newest'
  let state = null
  let filterKey = ''
  let ready = false

  afterNavigate(({ to }) => {
    if (!to || to.url.pathname !== '/sessions') return
    state = readSessionQuery(to.url.searchParams, { ...$dateRange, device: $selectedDevice, tool: $selectedTool })
    const range = state.from && state.to ? { from: state.from, to: state.to, month: state.month } : { range: state.range }
    filterKey = sessionFilterKey(range, state.device, state.tool)
    dateRange.set(range)
    selectedDevice.set(state.device)
    selectedTool.set(state.tool)
    query = state.q
    sort = state.sort
    page = state.page
    ready = true
    if (to.url.pathname + to.url.search !== sessionListUrl(state)) {
      navigate(state, true)
      return
    }
    loadData(state)
  })
  onDestroy(() => { ready = false; beginRequest() })

  function navigate(next, replaceState = false) {
    beginRequest()
    return goto(sessionListUrl(next), { keepFocus: true, noScroll: true, replaceState })
  }

  function syncFilters(range, device, tool) {
    const key = sessionFilterKey(range, device, tool)
    if (!ready || key === filterKey) return
    filterKey = key
    navigate({ ...state, range: '', from: '', to: '', month: '', ...range, device, tool, page: 1 })
  }

  function applySearch() {
    navigate({ ...state, q: query.trim(), sort, page: 1 })
  }

  function formatDuration(ms) {
    if (!ms || ms < 1000) return '< 1s'
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    if (m === 0) return `${s}s`
    return `${m}m ${s % 60}s`
  }

  async function loadData(snapshot) {
    // A response only counts while its request is the latest one: a slow answer for
    // an earlier filter or page must not replace the list or move the page.
    const isLatest = beginRequest()
    const requestedPage = snapshot.page
    loading = true
    error = null
    try {
      const response = await fetchSessions({
        ...snapshot,
        page: requestedPage,
        pageSize,
      })
      if (!isLatest()) return
      data = response
      const resolvedPage = resolvePage(response, requestedPage, pageSize)
      if (resolvedPage !== requestedPage) navigate({ ...snapshot, page: resolvedPage }, true)
    } catch (e) {
      if (!isLatest()) return
      error = e instanceof Error ? e.message : 'Failed to load data'
      data = null
    } finally {
      if (isLatest()) loading = false
    }
  }

  $: syncFilters($dateRange, $selectedDevice, $selectedTool)

  function nextPage() {
    if (data && page * pageSize < data.total) navigate({ ...state, page: page + 1 })
  }

  function prevPage() {
    if (page > 1) navigate({ ...state, page: page - 1 })
  }

  function goToDetail(session) {
    goto(detailUrl(session))
  }

  function detailUrl(session) {
    return sessionDetailUrl(session.sessionId, session.deviceInstanceId, $selectedTool, sessionListUrl(state))
  }
</script>

<svelte:head>
  <title>{$t('sessions.title')} — AIUsage</title>
</svelte:head>

<div class="page-header">
  <h1>{$t('sessions.title')}</h1>
  <p>{$t('sessions.desc')}</p>
</div>

<form class="session-search filter-bar" on:submit|preventDefault={applySearch}>
  <label for="session-search">{$t('sessions.search')}</label>
  <input id="session-search" type="search" maxlength="200" bind:value={query} placeholder={$t('sessions.searchHint')} />
  <button type="submit" class="activity-page-button" disabled={!ready}>{$t('sessions.search')}</button>
  <label for="session-sort">{$t('sessions.sort')}</label>
  <select id="session-sort" bind:value={sort} on:change={applySearch} disabled={!ready}>
    <option value="newest">{$t('sessions.sortNewest')}</option>
    <option value="cost">{$t('sessions.sortCost')}</option>
    <option value="tokens">{$t('sessions.sortTokens')}</option>
  </select>
</form>

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
          <th>{$t('sessions.session')}</th>
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
            <td class="activity-session-cell">
              <a class="activity-link activity-session-title" title={sessionLabel(session, $t('sessions.unnamed'))} href={detailUrl(session)} on:click|stopPropagation>{sessionLabel(session, $t('sessions.unnamed'))}</a>
              <span class="activity-session-time mono">{formatDateTime(session.ts)}</span>
            </td>
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

<style>
  .session-search { flex-wrap: wrap; }
  .session-search input, .session-search select {
    background: var(--surface); color: var(--text); border: 1px solid var(--border-subtle);
    border-radius: 6px; padding: 0.5rem; font: inherit; max-width: 100%;
  }
  .session-search input { flex: 1; min-width: 12rem; }
</style>
