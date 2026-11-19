<script>
  import '$lib/activity.css'
  import { dateRange, selectedDevice, selectedTool, formatNumber } from '$lib/stores.js'
  import { fetchToolCalls, activityDetailUrl } from '$lib/api.js'
  import { t } from '$lib/i18n.js'
  import DateRangeSelector from '$lib/components/DateRangeSelector.svelte'
  import DeviceSelector from '$lib/components/DeviceSelector.svelte'
  import ToolSelector from '$lib/components/ToolSelector.svelte'

  let data = null
  let error = null
  let loading = true
  let selectedType = null // null = all

  const TYPES = [
    { key: null,       label: () => $t('toolCalls.typeAll') },
    { key: 'builtin',  label: () => $t('toolCalls.typeBuiltin') },
    { key: 'mcp',      label: () => $t('toolCalls.typeMcp') },
    { key: 'skill',    label: () => $t('toolCalls.typeSkill') },
  ]

  const NO_TOOL_CALL_TOOLS = new Set([
    'qoder',
    'cursor',
    'kilocode',
    'kelivo',
    'copilot',
    'gemini',
    'kimi',
    'codebuddy',
    'kiro',
    'grok',
    'antigravity',
    'roocode',
    'zed',
    'goose',
    'omp',
    'pi',
    'craft',
    'droid',
  ])
  $: showNoToolCallNotice = NO_TOOL_CALL_TOOLS.has($selectedTool)

  async function loadData() {
    loading = true
    error = null
    try {
      data = await fetchToolCalls({
        ...$dateRange,
        device: $selectedDevice,
        tool: $selectedTool,
        toolType: selectedType,
      })
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load data'
      data = null
    } finally {
      loading = false
    }
  }

  $: $dateRange, $selectedDevice, $selectedTool, selectedType, loadData()
</script>

<svelte:head>
  <title>{$t('toolCalls.title')} — AIUsage</title>
</svelte:head>

<div class="page-header">
  <h1>{$t('toolCalls.title')}</h1>
  <p>{$t('toolCalls.desc')}</p>
</div>

<div class="filter-bar">
  <DateRangeSelector />
  <DeviceSelector />
  <ToolSelector />
</div>

{#if showNoToolCallNotice}
  <div class="activity-notice" role="note">
    {$t('toolCalls.noToolCallData')}
  </div>
{/if}

<div class="card activity-card">
  <div class="activity-card-header">
    <div class="activity-heading">
      <h2 class="section-title">{$t('activity.toolRanking')}</h2>
      {#if !loading && !error && data?.toolCalls.length}
        <span class="activity-count mono">{formatNumber(data.toolCalls.length)}</span>
      {/if}
    </div>
<div class="type-tabs activity-type-tabs" role="group" aria-label={$t('activity.toolType')}>
  {#each TYPES as type}
    <button
      class="activity-type-tab"
      class:active={selectedType === type.key}
      aria-pressed={selectedType === type.key}
      on:click={() => { selectedType = type.key }}
    >
      {type.label()}
    </button>
  {/each}
</div>
  </div>

{#if loading}
  <div class="state-msg" role="status">{$t('common.loading')}</div>
{:else if error}
  <div class="state-msg error" role="alert">{error}</div>
{:else if !data?.toolCalls.length}
  <div class="state-msg">
    <h2>{$t('toolCalls.noData')}</h2>
    <p>{$t('toolCalls.noDataHint')}</p>
  </div>
{:else}
  <div class="activity-ranking">
    {#each data.toolCalls as tc, i}
      <a class="activity-rank-row" href={activityDetailUrl('/tool-calls/events', { ...$dateRange, device: $selectedDevice, tool: $selectedTool, toolType: selectedType, name: tc.name })}>
        <span class="activity-rank mono">{String(i + 1).padStart(2, '0')}</span>
        <div class="activity-rank-body">
        <div class="activity-name-line">
          <span class="activity-name mono" title={tc.name}>{tc.displayName}</span>
          {#if tc.type === 'mcp'}
            <span class="activity-badge activity-badge-mcp">{$t('toolCalls.badgeMcp')}</span>
          {:else if tc.type === 'skill'}
            <span class="activity-badge activity-badge-skill">{$t('toolCalls.badgeSkill')}</span>
          {/if}
        </div>
        <div class="activity-bar-track" aria-hidden="true">
          <div class="activity-bar-fill" style="width: {tc.percentage}%"></div>
        </div>
        </div>
        <div class="activity-stats">
          <span class="activity-stat"><span class="activity-stat-label">{$t('activity.calls')}</span><span class="activity-stat-value mono">{formatNumber(tc.count)}</span></span>
          <span class="activity-stat"><span class="activity-stat-label">{$t('projects.share')}</span><span class="activity-stat-value mono">{tc.percentage.toFixed(1)}%</span></span>
        </div>
        <span class="activity-chevron" aria-hidden="true">→</span>
      </a>
    {/each}
  </div>
{/if}
</div>
