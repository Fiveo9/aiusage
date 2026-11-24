<script>
  import { goto } from '$app/navigation'
  import { page } from '$app/stores'
  import { tick } from 'svelte'
  import { t, lang, toggleLang } from '$lib/i18n.js'
  import { cycleTheme } from '$lib/theme.js'
  import { setRange } from '$lib/stores.js'
  import {
    House, LayoutDashboard, Coins, DollarSign, Box,
    MessageSquare, FolderKanban, Wrench,
    Gauge, Tag, Settings, LifeBuoy,
    Search, SunMoon, Languages, Calendar, CornerDownLeft
  } from 'lucide-svelte'

  export let open = false

  let query = ''
  let selectedIndex = 0
  let inputEl = null

  $: navItems = [
    { id: 'nav-home',      group: $t('cmd.navGroup'), label: $t('nav.home'),      path: '/',           icon: House,           keywords: 'home live index 首页' },
    { id: 'nav-overview',  group: $t('cmd.navGroup'), label: $t('nav.overview'),  path: '/overview',   icon: LayoutDashboard, keywords: 'overview summary 概览' },
    { id: 'nav-tokens',    group: $t('cmd.navGroup'), label: $t('nav.tokens'),    path: '/tokens',     icon: Coins,           keywords: 'tokens usage 消耗' },
    { id: 'nav-cost',      group: $t('cmd.navGroup'), label: $t('nav.cost'),      path: '/cost',       icon: DollarSign,      keywords: 'cost spend billing 费用' },
    { id: 'nav-models',    group: $t('cmd.navGroup'), label: $t('nav.models'),    path: '/models',     icon: Box,             keywords: 'models claude gpt 模型' },
    { id: 'nav-sessions',  group: $t('cmd.navGroup'), label: $t('nav.sessions'),  path: '/sessions',   icon: MessageSquare,   keywords: 'sessions chat history 会话' },
    { id: 'nav-projects',  group: $t('cmd.navGroup'), label: $t('nav.projects'),  path: '/projects',   icon: FolderKanban,    keywords: 'projects repo workspace 项目' },
    { id: 'nav-tools',     group: $t('cmd.navGroup'), label: $t('nav.toolCalls'), path: '/tool-calls', icon: Wrench,          keywords: 'tools mcp skill calls 工具调用' },
    { id: 'nav-quotas',    group: $t('cmd.navGroup'), label: $t('nav.quotas'),    path: '/quotas',     icon: Gauge,           keywords: 'quotas limits windows 配额' },
    { id: 'nav-pricing',   group: $t('cmd.navGroup'), label: $t('nav.pricing'),   path: '/pricing',    icon: Tag,             keywords: 'pricing rates alias 定价' },
    { id: 'nav-settings',  group: $t('cmd.navGroup'), label: $t('nav.settings'),  path: '/settings',   icon: Settings,        keywords: 'settings sync sources config 设置' },
    { id: 'nav-support',   group: $t('cmd.navGroup'), label: $t('nav.support'),   path: '/support',    icon: LifeBuoy,        keywords: 'support help contact 支持' },
  ]

  $: actionItems = [
    { id: 'act-theme', group: $t('cmd.actionGroup'), label: $t('cmd.toggleTheme'), icon: SunMoon,   keywords: 'theme dark light system 主题 深色 浅色', run: () => cycleTheme() },
    { id: 'act-lang',  group: $t('cmd.actionGroup'), label: $t('cmd.toggleLang'),  icon: Languages, keywords: 'language chinese english 语言 中文',      run: () => toggleLang() },
    { id: 'rng-day',   group: $t('cmd.rangeGroup'),  label: $t('range.today'),     icon: Calendar,  keywords: 'range today day 今天',                    run: () => setRange('day') },
    { id: 'rng-week',  group: $t('cmd.rangeGroup'),  label: $t('range.week'),      icon: Calendar,  keywords: 'range week 本周',                         run: () => setRange('week') },
    { id: 'rng-month', group: $t('cmd.rangeGroup'),  label: $t('range.month'),     icon: Calendar,  keywords: 'range month 本月',                        run: () => setRange('month') },
    { id: 'rng-30',    group: $t('cmd.rangeGroup'),  label: $t('range.last30'),    icon: Calendar,  keywords: 'range 30 days 近30天',                    run: () => setRange('last30') },
    { id: 'rng-all',   group: $t('cmd.rangeGroup'),  label: $t('range.allTime'),   icon: Calendar,  keywords: 'range all time 全部',                     run: () => setRange('all') },
  ]

  $: allItems = [
    ...navItems.map((item) => ({
      ...item,
      meta: item.path,
      run: () => goto(item.path),
    })),
    ...actionItems,
  ]

  $: q = query.trim().toLowerCase()
  $: filtered = q
    ? allItems.filter((item) =>
        [item.label, item.path || '', item.keywords || '', item.group].some((f) =>
          f.toLowerCase().includes(q)
        )
      )
    : allItems

  $: if (selectedIndex >= filtered.length) {
    selectedIndex = Math.max(0, filtered.length - 1)
  }

  $: grouped = (() => {
    const map = new Map()
    filtered.forEach((item, flatIdx) => {
      if (!map.has(item.group)) map.set(item.group, [])
      map.get(item.group).push({ ...item, flatIdx })
    })
    return Array.from(map.entries())
  })()

  export async function openPalette() {
    open = true
    query = ''
    selectedIndex = 0
    await tick()
    inputEl?.focus()
  }

  function closePalette() {
    open = false
    query = ''
  }

  function execute(item) {
    if (!item) return
    closePalette()
    item.run()
  }

  async function handleWindowKeydown(e) {
    if (e.isComposing || e.keyCode === 229) return
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      if (open) closePalette()
      else await openPalette()
      return
    }
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      closePalette()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (filtered.length > 0) selectedIndex = (selectedIndex + 1) % filtered.length
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (filtered.length > 0) selectedIndex = (selectedIndex - 1 + filtered.length) % filtered.length
    } else if (e.key === 'Enter') {
      e.preventDefault()
      execute(filtered[selectedIndex])
    }
  }
</script>

<svelte:window on:keydown={handleWindowKeydown} />

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="cmd-backdrop" on:click={closePalette}></div>
  <div class="cmd-dialog" role="dialog" aria-modal="true" aria-label={$t('cmd.placeholder')}>
    <div class="cmd-input-row">
      <Search size={15} strokeWidth={1.9} class="cmd-search-icon" />
      <input
        bind:this={inputEl}
        type="text"
        class="cmd-input"
        bind:value={query}
        placeholder={$t('cmd.placeholder')}
        on:input={() => { selectedIndex = 0 }}
      />
      <kbd class="cmd-esc">ESC</kbd>
    </div>

    <div class="cmd-list" role="listbox">
      {#if filtered.length === 0}
        <div class="cmd-empty">{$t('cmd.noResults')}</div>
      {:else}
        {#each grouped as [groupName, items]}
          <div class="cmd-group-label">{groupName}</div>
          {#each items as item (item.id)}
            {@const active = item.flatIdx === selectedIndex}
            {@const currentRoute = item.path && $page.url.pathname === item.path}
            <button
              type="button"
              role="option"
              aria-selected={active}
              class="cmd-item"
              class:active
              on:mouseenter={() => { selectedIndex = item.flatIdx }}
              on:click={() => execute(item)}
            >
              <span class="cmd-item-icon">
                <svelte:component this={item.icon} size={15} strokeWidth={1.8} />
              </span>
              <span class="cmd-item-label">{item.label}</span>
              {#if currentRoute}
                <span class="cmd-current">●</span>
              {/if}
              {#if item.meta}
                <span class="cmd-item-meta mono">{item.meta}</span>
              {/if}
              {#if active}
                <span class="cmd-enter-icon" aria-hidden="true">
                  <CornerDownLeft size={12} strokeWidth={1.8} />
                </span>
              {/if}
            </button>
          {/each}
        {/each}
      {/if}
    </div>

    <div class="cmd-footer">
      <span>{$t('cmd.hint')}</span>
      <span class="mono">{$lang === 'zh' ? '中文' : 'EN'}</span>
    </div>
  </div>
{/if}

<style>
  .cmd-backdrop {
    position: fixed;
    inset: 0;
    z-index: 600;
    background: var(--overlay);
    backdrop-filter: blur(4px);
    animation: cmdFade 0.12s ease-out;
  }

  .cmd-dialog {
    position: fixed;
    top: 16%;
    left: 50%;
    transform: translateX(-50%);
    width: min(540px, calc(100vw - 2rem));
    z-index: 610;
    background: var(--surface-elevated);
    border: 1px solid var(--border-medium);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    animation: cmdPop 0.14s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes cmdFade {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes cmdPop {
    from { opacity: 0; transform: translate(-50%, -6px) scale(0.985); }
    to { opacity: 1; transform: translate(-50%, 0) scale(1); }
  }

  .cmd-input-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-muted);
  }

  .cmd-input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: var(--text-base);
    outline: none;
  }

  .cmd-input::placeholder {
    color: var(--text-muted);
  }

  .cmd-esc {
    font-size: 0.625rem;
    font-weight: 600;
    color: var(--text-muted);
    background: var(--raised);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 0.125rem 0.375rem;
  }

  .cmd-list {
    max-height: 340px;
    overflow-y: auto;
    padding: 0.375rem;
  }

  .cmd-group-label {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    padding: 0.5rem 0.625rem 0.25rem;
  }

  .cmd-item {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.5rem 0.625rem;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.08s ease, color 0.08s ease;
  }

  .cmd-item.active {
    background: var(--hover);
    color: var(--text);
  }

  .cmd-item-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .cmd-item.active .cmd-item-icon {
    color: var(--accent);
  }

  .cmd-item-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cmd-current {
    font-size: 0.5rem;
    color: var(--accent);
  }

  .cmd-item-meta {
    font-size: var(--text-2xs);
    color: var(--text-muted);
  }

  .cmd-enter-icon {
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
  }

  .cmd-empty {
    padding: 2rem 1rem;
    text-align: center;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .cmd-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.875rem;
    border-top: 1px solid var(--border-subtle);
    background: var(--raised);
    font-size: 0.6875rem;
    color: var(--text-muted);
  }
</style>
