<script>
  import '$lib/activity.css'
  import { page } from '$app/stores'
  import { onMount } from 'svelte'
  import { formatCost, formatTokens } from '$lib/stores.js'
  import { fetchSessionDetail } from '$lib/api.js'
  import { sessionLabel } from '$lib/session-title.js'
  import { t } from '$lib/i18n.js'

  let data = null
  let error = null
  let loading = true

  function formatDateTime(ts) {
    return new Date(ts).toLocaleString()
  }

  function formatDuration(ms) {
    if (!ms || ms < 1000) return '< 1s'
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    const h = Math.floor(m / 60)
    if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`
    if (m === 0) return `${s}s`
    return `${m}m ${s % 60}s`
  }

  function formatRelativeTs(ms) {
    if (ms <= 0) return '+0ms'
    if (ms < 1000) return `+${ms}ms`
    const s = ms / 1000
    return `+${s % 1 === 0 ? s.toFixed(0) : s.toFixed(1)}s`
  }

  function formatGap(ms) {
    const s = Math.round(ms / 1000)
    return `— ${s}s ${$t('sessions.detail.gap')} —`
  }

  function tokenPercent(part, total) {
    if (!total || !part) return 0
    return Math.round((part / total) * 1000) / 10
  }

  onMount(async () => {
    const sessionId = $page.params.sessionId
    const tool = $page.url.searchParams.get('tool') || ''
    const device = $page.url.searchParams.get('device') || ''

    try {
      data = await fetchSessionDetail(sessionId, { tool, device })
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load session'
    } finally {
      loading = false
    }
  })
</script>

<svelte:head>
  <title>{data?.session ? sessionLabel(data.session, $t('sessions.unnamed')) : $t('sessions.detail.title')} — AIUsage</title>
</svelte:head>

<div class="page-header activity-detail-header">
  <a class="activity-back-link" href={$page.url.searchParams.get('back')?.startsWith('/sessions?') ? $page.url.searchParams.get('back') : '/sessions'}>
    ← {$t('sessions.detail.back')}
  </a>
  <h1>{data?.session ? sessionLabel(data.session, $t('sessions.unnamed')) : $t('sessions.detail.title')}</h1>
  {#if data?.session}<p class="numeric">{formatDateTime(data.session.firstTs)}</p>{/if}
</div>

{#if loading}
  <div class="detail-header">
    <div class="identity card">
      <div class="ph-line ph-w40"></div>
      <div class="ph-line ph-w60"></div>
      <div class="ph-line ph-w80"></div>
      <div class="id-footer" style="margin-top:auto; padding-top:0.75rem; border-top:1px solid var(--border-subtle);">
        <div class="ph-line ph-w50"></div>
        <div class="ph-line ph-w20"></div>
      </div>
    </div>
    <div class="metrics card">
      <div class="metrics-grid">
        {#each [1,2,3,4] as _}
          <div class="metric-cell">
            <div class="ph-line ph-w60" style="height:0.5rem;margin-bottom:0.35rem"></div>
            <div class="ph-line ph-w40" style="height:1rem"></div>
          </div>
        {/each}
      </div>
      <div style="padding-top:0.75rem;border-top:1px solid var(--border-subtle);display:flex;flex-direction:column;gap:0.4rem">
        {#each [1,2] as _}
          <div style="display:grid;grid-template-columns:5.5rem 1fr 4.5rem;gap:0.5rem;align-items:center">
            <div class="ph-line ph-w60" style="height:0.5rem"></div>
            <div class="ph-line" style="height:6px;border-radius:3px"></div>
            <div class="ph-line ph-w50" style="height:0.5rem"></div>
          </div>
        {/each}
      </div>
    </div>
  </div>
  <div class="timeline">
    {#each [1,2,3] as _}
      <div class="record-card card">
        <div style="display:flex;justify-content:space-between;margin-bottom:0.5rem">
          <div class="ph-line ph-w40"></div>
          <div class="ph-line ph-w20"></div>
        </div>
        <div style="display:flex;gap:0.75rem">
          <div class="ph-line ph-w20"></div>
          <div class="ph-line ph-w20"></div>
        </div>
      </div>
    {/each}
  </div>
{:else if error}
  <div class="card state-msg error" role="alert">{error}</div>
{:else if data}
  {@const session = data.session}
  {@const records = data.records}
  {@const totalTokens = session.inputTokens + session.outputTokens + (session.cacheReadTokens || 0) + (session.cacheWriteTokens || 0) + (session.thinkingTokens || 0)}

  <!-- ── Header: identity + metrics ────────────────────────────── -->
  <div class="detail-header">
    <div class="identity card">
      <div class="id-row">
        <span class="activity-badge">{session.tool}</span>
        <span class="id-model mono">{(session.models ?? [session.model]).join(', ')}</span>
      </div>
      <div class="id-time mono">{formatDateTime(session.firstTs)}</div>
      {#if session.cwd}
        <div class="id-path mono" title={session.cwd}>{session.cwd}</div>
      {/if}
      <div class="id-footer">
        <span class="id-session mono">{$t('sessions.detail.meta.sessionId')}: {session.sessionId}</span>
        <span class="id-duration mono">{formatDuration(session.duration)}</span>
      </div>
    </div>

    <div class="metrics card">
      <div class="metrics-grid">
        <div class="metric-cell">
          <span class="metric-label">{$t('sessions.detail.meta.cost')}</span>
          <span class="metric-value mono accent">{formatCost(session.cost)}</span>
        </div>
        <div class="metric-cell">
          <span class="metric-label">{$t('sessions.detail.meta.totalTokens')}</span>
          <span class="metric-value mono">{formatTokens(totalTokens)}</span>
        </div>
        <div class="metric-cell">
          <span class="metric-label">{$t('sessions.detail.meta.apiCalls')}</span>
          <span class="metric-value mono">{session.recordCount}</span>
        </div>
        <div class="metric-cell">
          <span class="metric-label">{$t('sessions.detail.meta.toolCalls')}</span>
          <span class="metric-value mono">{session.toolCallCount}</span>
        </div>
      </div>

      <div class="token-breakdown">
        <div class="tb-row">
          <span class="tb-label">{$t('sessions.detail.meta.input')}</span>
          <span class="tb-bar"><span class="tb-fill tb-input" style="width:{tokenPercent(session.inputTokens, totalTokens)}%"></span></span>
          <span class="tb-value mono">{formatTokens(session.inputTokens)}</span>
        </div>
        <div class="tb-row">
          <span class="tb-label">{$t('sessions.detail.meta.output')}</span>
          <span class="tb-bar"><span class="tb-fill tb-output" style="width:{tokenPercent(session.outputTokens, totalTokens)}%"></span></span>
          <span class="tb-value mono">{formatTokens(session.outputTokens)}</span>
        </div>
        {#if session.cacheReadTokens}
          <div class="tb-row">
            <span class="tb-label">{$t('sessions.detail.meta.cacheRead')}</span>
            <span class="tb-bar"><span class="tb-fill tb-cache-read" style="width:{tokenPercent(session.cacheReadTokens, totalTokens)}%"></span></span>
            <span class="tb-value mono">{formatTokens(session.cacheReadTokens)}</span>
          </div>
        {/if}
        {#if session.cacheWriteTokens}
          <div class="tb-row">
            <span class="tb-label">{$t('sessions.detail.meta.cacheWrite')}</span>
            <span class="tb-bar"><span class="tb-fill tb-cache-write" style="width:{tokenPercent(session.cacheWriteTokens, totalTokens)}%"></span></span>
            <span class="tb-value mono">{formatTokens(session.cacheWriteTokens)}</span>
          </div>
        {/if}
        {#if session.thinkingTokens}
          <div class="tb-row">
            <span class="tb-label">{$t('sessions.detail.meta.thinking')}</span>
            <span class="tb-bar"><span class="tb-fill tb-thinking" style="width:{tokenPercent(session.thinkingTokens, totalTokens)}%"></span></span>
            <span class="tb-value mono">{formatTokens(session.thinkingTokens)}</span>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- ── Timeline ──────────────────────────────────────────────── -->
  <h2 class="section-title">{$t('activity.timeline')}</h2>
  <div class="timeline">
    {#each records as record, i}
      {@const recordTotal = record.inputTokens + record.outputTokens + (record.cacheReadTokens || 0) + (record.cacheWriteTokens || 0) + (record.thinkingTokens || 0)}
      {#if i > 0 && record.ts - records[i - 1].ts > 1000}
        <div class="gap-divider">
          <span class="gap-text">{formatGap(record.ts - records[i - 1].ts)}</span>
        </div>
      {/if}

      <div class="record-card card">
        <div class="record-header">
          <div class="record-meta-left">
            <span class="record-index mono">#{i + 1}</span>
            <span class="record-relts mono muted">{formatRelativeTs(record.ts - session.firstTs)}</span>
            <span class="record-model mono">{record.model}</span>
          </div>
          <span class="record-cost mono accent">{formatCost(record.cost)}</span>
        </div>

        <div class="record-tokens">
          <span class="rt-item" title={$t('sessions.detail.meta.input')}>
            <span class="rt-dot rt-input"></span>
            <span class="rt-val mono">{formatTokens(record.inputTokens)}</span>
          </span>
          <span class="rt-item" title={$t('sessions.detail.meta.output')}>
            <span class="rt-dot rt-output"></span>
            <span class="rt-val mono">{formatTokens(record.outputTokens)}</span>
          </span>
          {#if record.cacheReadTokens}
            <span class="rt-item" title={$t('sessions.detail.meta.cacheRead')}>
              <span class="rt-dot rt-cache-read"></span>
              <span class="rt-val mono">{formatTokens(record.cacheReadTokens)}</span>
            </span>
          {/if}
          {#if record.cacheWriteTokens}
            <span class="rt-item" title={$t('sessions.detail.meta.cacheWrite')}>
              <span class="rt-dot rt-cache-write"></span>
              <span class="rt-val mono">{formatTokens(record.cacheWriteTokens)}</span>
            </span>
          {/if}
          {#if record.thinkingTokens}
            <span class="rt-item" title={$t('sessions.detail.meta.thinking')}>
              <span class="rt-dot rt-thinking"></span>
              <span class="rt-val mono">{formatTokens(record.thinkingTokens)}</span>
            </span>
          {/if}
          <span class="rt-total mono muted" title={$t('sessions.detail.meta.totalTokens')}>{formatTokens(recordTotal)}</span>
        </div>

        {#if record.toolCalls && record.toolCalls.length > 0}
          <div class="tool-calls">
            {#each record.toolCalls as tc}
              <div class="tool-call">
                <span class="tc-index mono muted">#{tc.callIndex + 1}</span>
                <span class="tc-name mono">{tc.displayName}</span>
                {#if tc.ts != null}
                  <span class="tc-offset mono muted">{formatRelativeTs(tc.ts - record.ts)}</span>
                {/if}
                {#if tc.type === 'mcp'}
                  <span class="activity-badge activity-badge-mcp">mcp</span>
                {:else if tc.type === 'skill'}
                  <span class="activity-badge activity-badge-skill">skill</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {:else}
      <div class="card state-msg">
        <h2>{$t('sessions.noData')}</h2>
        <p>{$t('sessions.noDataHint')}</p>
      </div>
    {/each}
  </div>
{/if}

<style>
  /* ── Header: two-column grid ──────────────────────────────── */
  .detail-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
    gap: 1.25rem;
    margin-bottom: 1.75rem;
  }

  /* Identity card */
  .identity {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1.35rem 1.5rem;
  }
  .id-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    flex-wrap: wrap;
  }
  .id-model {
    overflow-wrap: anywhere;
    min-width: 0;
    font-size: 0.875rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--text);
  }
  .id-time {
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }
  .id-path {
    font-size: 0.75rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: var(--raised);
    padding: 0.35rem 0.6rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
  }
  .id-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-top: auto;
    padding-top: 0.875rem;
    border-top: 1px solid var(--border-subtle);
  }
  .id-session {
    font-size: 0.75rem;
    overflow-wrap: anywhere;
    min-width: 0;
    color: var(--text-muted);
  }
  .id-duration {
    font-size: 0.8125rem;
    font-weight: 700;
    color: var(--text);
  }

  /* Metrics card */
  .metrics {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.35rem 1.5rem;
  }
  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.75rem;
  }
  .metric-cell {
    min-width: 0;
    overflow-wrap: anywhere;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .metric-label {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    font-family: var(--font-sans);
  }
  .metric-value {
    font-size: 1.125rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  /* Token breakdown bars */
  .token-breakdown {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding-top: 0.875rem;
    border-top: 1px solid var(--border-subtle);
  }
  .tb-row {
    display: grid;
    grid-template-columns: 5.5rem minmax(0, 1fr) 4.5rem;
    align-items: center;
    gap: 0.625rem;
  }
  .tb-label {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    text-align: right;
  }
  .tb-bar {
    height: 6px;
    background: var(--raised);
    border-radius: 999px;
    overflow: hidden;
  }
  .tb-fill {
    display: block;
    height: 100%;
    border-radius: inherit;
    min-width: 2px;
  }
  .tb-input { background: var(--chart-input); }
  .tb-output { background: var(--chart-output); }
  .tb-cache-read { background: var(--chart-cache-read); }
  .tb-cache-write { background: var(--chart-cache-write); }
  .tb-thinking { background: var(--chart-thinking); }
  .tb-value {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text);
    text-align: right;
  }

  /* ── Timeline ─────────────────────────────────────────────── */
  .timeline {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .gap-divider {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem 0;
  }
  .gap-text {
    font-family: var(--mono);
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-muted);
    background: var(--raised);
    border: 1px solid var(--border-subtle);
    padding: 0.2rem 0.75rem;
    border-radius: 999px;
  }

  /* Record card */
  .record-card {
    padding: 1.125rem 1.35rem;
    transition: all 0.16s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .record-card:hover {
    border-color: var(--border-medium);
  }

  .record-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .record-meta-left {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    flex-wrap: wrap;
    min-width: 0;
  }
  .record-index {
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--accent);
    min-width: 1.5rem;
  }
  .record-relts {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .record-model {
    font-size: 0.75rem;
    font-weight: 600;
    overflow-wrap: anywhere;
    color: var(--text);
  }
  .record-cost {
    font-size: 0.8125rem;
    font-weight: 700;
  }

  /* Record token dots */
  .record-tokens {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    flex-wrap: wrap;
    margin-bottom: 0.5rem;
    padding: 0.35rem 0.6rem;
    background: var(--raised);
    border-radius: var(--radius-sm);
  }
  .rt-item {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .rt-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .rt-input { background: var(--chart-input); }
  .rt-output { background: var(--chart-output); }
  .rt-cache-read { background: var(--chart-cache-read); }
  .rt-cache-write { background: var(--chart-cache-write); }
  .rt-thinking { background: var(--chart-thinking); }
  .rt-val {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text);
  }
  .rt-total {
    font-size: 0.75rem;
    margin-left: auto;
    font-weight: 600;
  }

  /* Tool calls */
  .tool-calls {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    border-top: 1px solid var(--border-subtle);
    padding-top: 0.625rem;
    margin-top: 0.375rem;
  }
  .tool-call {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.625rem;
    border-radius: var(--radius-sm);
    background: var(--raised);
    border: 1px solid transparent;
  }
  .tool-call:hover {
    border-color: var(--border-subtle);
    background: var(--hover);
  }
  .tc-index {
    font-size: 0.6875rem;
    min-width: 1.5rem;
    color: var(--text-muted);
  }
  .tc-name {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text);
  }
  .tc-offset {
    font-size: 0.6875rem;
    flex-shrink: 0;
  }

  .muted { color: var(--text-muted); }
  .accent { color: var(--accent); }

  /* ── Loading placeholders ──────────────────────────────────── */
  .ph-line {
    height: 0.75rem;
    background: var(--raised);
    border-radius: 4px;
  }
  .ph-w20 { width: 20%; }
  .ph-w40 { width: 40%; }
  .ph-w50 { width: 50%; }
  .ph-w60 { width: 60%; }
  .ph-w80 { width: 80%; }

  /* ── Responsive ───────────────────────────────────────────── */
  @media (max-width: 800px) {
    .detail-header {
      grid-template-columns: 1fr;
    }
    .metrics-grid {
      grid-template-columns: repeat(2, 1fr);
    }
    .tb-row {
      grid-template-columns: 4.5rem minmax(0, 1fr) 3.5rem;
    }
    .record-header {
      flex-direction: column;
      align-items: flex-start;
    }
    .record-tokens {
      gap: 0.5rem;
    }
    .tool-call {
      flex-wrap: wrap;
    }
  }
</style>
