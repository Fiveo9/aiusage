<script>
  import '$lib/activity.css'
  import { afterNavigate, goto } from '$app/navigation'
  import { page as currentPage } from '$app/stores'
  import { onDestroy, onMount } from 'svelte'
  import { dateRange, selectedDevice, selectedTool, formatTokens, formatCost, formatDateTime, formatNumber } from '$lib/stores.js'
  import { fetchSessions, sessionDetailUrl } from '$lib/api.js'
  import { createRequestTracker, resolvePage } from '$lib/sessions-paging.js'
  import { sessionLabel } from '$lib/session-title.js'
  import { readSessionQuery, sessionListUrl, sessionFilterKey } from '$lib/session-query.js'
  import { t } from '$lib/i18n.js'
  import DateRangeSelector from '$lib/components/DateRangeSelector.svelte'
  import DeviceSelector from '$lib/components/DeviceSelector.svelte'
  import ToolSelector from '$lib/components/ToolSelector.svelte'
  import DropdownSelect from '$lib/components/ui/DropdownSelect.svelte'
  import { Search, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-svelte'

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
  let lastUrl = ''

  function initializeFromUrl(url) {
    if (url.pathname !== '/sessions') return
    const key = url.pathname + url.search
    if (ready && key === lastUrl) return
    lastUrl = key
    state = readSessionQuery(url.searchParams, { ...$dateRange, device: $selectedDevice, tool: $selectedTool })
    const range = state.from && state.to ? { from: state.from, to: state.to, month: state.month } : { range: state.range }
    filterKey = sessionFilterKey(range, state.device, state.tool)
    dateRange.set(range)
    selectedDevice.set(state.device)
    selectedTool.set(state.tool)
    query = state.q
    sort = state.sort
    page = state.page
    ready = true
    if (key !== sessionListUrl(state)) {
      navigate(state, true)
      return
    }
    loadData(state)
  }

  // Auth can mount this page after the router's initial navigation notification.
  // Always initialize on mount; deduplicate the subsequent navigation callback.
  onMount(() => initializeFromUrl($currentPage.url))
  afterNavigate(({ to }) => { if (to) initializeFromUrl(to.url) })
  onDestroy(() => { ready = false; beginRequest() })

  function navigate(next, replaceState = false) {
    if (sessionListUrl(next) === lastUrl) return loadData(next)
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

  function handleSortChange(e) {
    sort = e.detail
    applySearch()
  }

  function formatDuration(ms) {
    if (!ms || ms < 1000) return '< 1s'
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    if (m === 0) return `${s}s`
    return `${m}m ${s % 60}s`
  }

  async function loadData(snapshot) {
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

<div class="filter-bar">
  <DateRangeSelector />
  <DeviceSelector />
  <ToolSelector />
</div>

<div class="card activity-card">
  <div class="sessions-toolbar">
    <div class="activity-heading">
      <h2 class="section-title" id="sessions-list-title">{$t('activity.sessionList')}</h2>
      {#if data}
        <span class="activity-count mono">{formatNumber(data.total)}</span>
      {/if}
    </div>

    <form class="session-search" on:submit|preventDefault={applySearch}>
      <div class="search-field">
        <span class="search-icon" aria-hidden="true"><Search size={13} strokeWidth={1.9} /></span>
        <input
          id="session-search"
          type="search"
          maxlength="200"
          bind:value={query}
          placeholder={$t('sessions.searchHint')}
          aria-label={$t('sessions.search')}
        />
      </div>
      <button type="submit" class="eng-btn" disabled={!ready}>{$t('sessions.search')}</button>
      <DropdownSelect
        options={[
          { value: 'newest', label: $t('sessions.sortNewest') },
          { value: 'cost',   label: $t('sessions.sortCost') },
          { value: 'tokens', label: $t('sessions.sortTokens') },
        ]}
        value={sort}
        disabled={!ready}
        icon={ArrowUpDown}
        align="right"
        minWidth="10rem"
        ariaLabel={$t('sessions.sort')}
        on:change={handleSortChange}
      />
    </form>
  </div>

  {#if loading && !data}
    <div class="skeleton-rows">
      {#each [1, 2, 3, 4, 5] as _}
        <div class="skeleton" style="height: 44px;"></div>
      {/each}
    </div>
  {:else if error}
    <div class="state-msg error" role="alert">{error}</div>
  {:else if !data?.sessions.length}
    <div class="state-msg">
      <h2>{$t('sessions.noData')}</h2>
      <p>{$t('sessions.noDataHint')}</p>
    </div>
  {:else}
    <div class:is-stale={loading}>
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
        <span class="activity-page-info mono">{$t('common.page')} {page} / {Math.max(1, Math.ceil(data.total / pageSize))}</span>
        <div class="activity-page-actions">
          <button class="activity-page-button" on:click={prevPage} disabled={page <= 1}>
            <ChevronLeft size={14} strokeWidth={1.9} />
            <span>{$t('common.previous')}</span>
          </button>
          <button class="activity-page-button" on:click={nextPage} disabled={page * pageSize >= data.total}>
            <span>{$t('common.next')}</span>
            <ChevronRight size={14} strokeWidth={1.9} />
          </button>
        </div>
      </nav>
    </div>
  {/if}
</div>

<style>
  .sessions-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 0.875rem;
  }

  .session-search {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-wrap: wrap;
  }

  .search-field {
    position: relative;
    display: flex;
    align-items: center;
    min-width: 14rem;
  }

  .search-icon {
    position: absolute;
    left: 0.6rem;
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
    pointer-events: none;
  }

  .search-field input {
    width: 100%;
    height: var(--control-height);
    padding: 0 0.65rem 0 1.85rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--raised);
    color: var(--text);
    font-size: var(--text-xs);
    outline: none;
    transition: border-color 0.14s ease, background-color 0.14s ease;
  }

  .search-field input:focus {
    border-color: var(--accent);
    background: var(--surface);
  }

  .skeleton-rows {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem 0;
  }

  @media (max-width: 640px) {
    .session-search {
      width: 100%;
    }
    .search-field {
      flex: 1;
      min-width: 0;
    }
  }
</style>
