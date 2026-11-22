<script>
  import '$lib/styles/tokens.css'
  import '$lib/styles/primitives.css'
  import { page } from '$app/stores'
  import { onDestroy, onMount } from 'svelte'
  import { lang, toggleLang, t } from '$lib/i18n.js'
  import { userPref, cycleTheme, initTheme } from '$lib/theme.js'
  import { fetchConfig, fetchAuthStatus, login } from '$lib/api.js'
  import { displayCurrency, exchangeRate } from '$lib/stores.js'
  import { getAuthShellState } from '$lib/auth-shell.js'
  import CommandPalette from '$lib/components/ui/CommandPalette.svelte'
  import {
    House, LayoutDashboard, Coins, DollarSign, Box,
    MessageSquare, FolderKanban, Wrench,
    Gauge, Tag, Settings,
    Sun, Moon, MonitorCog,
    Search, PanelLeftClose, PanelLeftOpen, ExternalLink, X
  } from 'lucide-svelte'

  const NAV_GROUPS = [
    {
      key: 'nav.group.overview',
      items: [
        { path: '/',           key: 'nav.home',      icon: House },
        { path: '/overview',   key: 'nav.overview',  icon: LayoutDashboard },
      ]
    },
    {
      key: 'nav.group.analytics',
      items: [
        { path: '/tokens',     key: 'nav.tokens',    icon: Coins },
        { path: '/cost',       key: 'nav.cost',      icon: DollarSign },
        { path: '/models',     key: 'nav.models',    icon: Box },
      ]
    },
    {
      key: 'nav.group.activity',
      items: [
        { path: '/sessions',   key: 'nav.sessions',  icon: MessageSquare },
        { path: '/projects',   key: 'nav.projects',  icon: FolderKanban },
        { path: '/tool-calls', key: 'nav.toolCalls', icon: Wrench },
      ]
    },
    {
      key: 'nav.group.system',
      items: [
        { path: '/quotas',     key: 'nav.quotas',    icon: Gauge },
        { path: '/pricing',    key: 'nav.pricing',   icon: Tag },
        { path: '/settings',   key: 'nav.settings',  icon: Settings },
      ]
    }
  ]

  const SIDEBAR_KEY = 'aiusage-sidebar-collapsed'

  let collapsed = false
  let mobileOpen = false
  let cmdPalette = null

  const themeIcons = { system: MonitorCog, dark: Moon, light: Sun }

  let authLoading = true
  let authEnabled = false
  let authenticated = false
  let password = ''
  let authError = ''
  let authSubmitting = false
  let unlockOpen = false
  // Bumped by a successful unlock, which mounts the page again: the public
  // home was refused its protected requests (settings, quotas, refresh) while
  // locked. The initial auth check never changes it.
  let unlockCount = 0

  $: isHomeRoute = $page.url.pathname === '/'
  $: shellState = getAuthShellState({
    pathname: $page.url.pathname,
    authEnabled,
    authenticated,
    authLoading,
  })
  $: shouldShowLogin = shellState === 'login-page'
  $: shouldShowPublicHome = shellState === 'public-home'

  async function loadAuthStatus() {
    try {
      const status = await fetchAuthStatus()
      authEnabled = Boolean(status.enabled)
      authenticated = Boolean(status.authenticated)
    } catch {
      authEnabled = false
      authenticated = false
    } finally {
      authLoading = false
    }
  }

  async function handleLogin() {
    authError = ''
    authSubmitting = true
    try {
      await login(password)
      authenticated = true
      unlockCount += 1
      password = ''
      unlockOpen = false
      fetchConfig().then(applyConfig).catch(() => {})
    } catch (err) {
      authError = err instanceof Error ? err.message : $t('auth.loginFailed')
    } finally {
      authSubmitting = false
    }
  }

  function toggleSidebar() {
    collapsed = !collapsed
    if (typeof window !== 'undefined') {
      localStorage.setItem(SIDEBAR_KEY, String(collapsed))
    }
  }

  function toggleMobile() {
    mobileOpen = !mobileOpen
  }

  function openUnlock() {
    if (authLoading) return
    unlockOpen = true
    authError = ''
  }

  function closeUnlock() {
    unlockOpen = false
    authError = ''
    password = ''
  }

  function applyConfig(cfg) {
    if (cfg.displayCurrency) displayCurrency.set(cfg.displayCurrency)
    if (cfg.exchangeRateCache?.CNY_USD) exchangeRate.set(cfg.exchangeRateCache.CNY_USD)
    if (cfg.exchangeRate) exchangeRate.set(cfg.exchangeRate)
  }

  onMount(() => {
    initTheme()
    loadAuthStatus()
    fetchConfig().then(applyConfig).catch(() => {})
    if (typeof window !== 'undefined') {
      collapsed = localStorage.getItem(SIDEBAR_KEY) === 'true'
    }
  })

  onDestroy(() => {})

  $: $page, mobileOpen = false
  $: if (typeof document !== 'undefined') {
    document.documentElement.lang = $lang === 'zh' ? 'zh-CN' : 'en'
  }
</script>

{#if mobileOpen && shellState === 'shell'}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="mobile-backdrop" on:click={toggleMobile}></div>
{/if}

{#if shouldShowLogin}
  <main class="auth-page">
    <section class="auth-card">
      <a href="/" class="brand auth-brand">
        <div class="brand-logo-wrap">
          <svg class="brand-logo" width="18" height="18" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect width="64" height="64" rx="16" fill="currentColor"/>
            <rect x="12" y="38" width="10" height="16" rx="3" fill="white"/>
            <rect x="27" y="26" width="10" height="28" rx="3" fill="white"/>
            <rect x="42" y="14" width="10" height="40" rx="3" fill="white"/>
          </svg>
        </div>
        <span class="brand-name">AIUsage</span>
      </a>
      <h1>{$t('auth.locked')}</h1>
      <p>{$t('auth.lockedHint')}</p>
      <form on:submit|preventDefault={handleLogin}>
        <!-- svelte-ignore a11y-autofocus -->
        <input
          type="password"
          bind:value={password}
          placeholder={$t('auth.password')}
          autocomplete="current-password"
          autofocus
        />
        <button type="submit" disabled={authSubmitting || !password}>
          {authSubmitting ? $t('auth.unlocking') : $t('auth.unlock')}
        </button>
      </form>
      {#if authError}
        <div class="auth-error">{authError}</div>
      {/if}
      <a class="auth-home" href="/">{$t('auth.backHome')}</a>
    </section>
  </main>
{:else if shellState === 'loading'}
  <main class="auth-page">
    <section class="auth-card">
      <div class="auth-loading">
        <span class="loading-spin"></span>
        <span>{$t('auth.checking')}</span>
      </div>
    </section>
  </main>
{:else}
<!-- The public home and the full shell share one <slot />, so the page is not
     mounted a second time when the auth check settles on `/` (issue #109). -->
<div class:app={!shouldShowPublicHome} class:public-shell={shouldShowPublicHome} class:collapsed>

  {#if !shouldShowPublicHome}
    <CommandPalette bind:this={cmdPalette} />
  {/if}

  {#if shouldShowPublicHome}
    <header class="public-header">
      <button class="public-unlock" type="button" on:click={openUnlock} aria-label={$t('auth.unlockDashboard')}>
        <div class="brand-logo-wrap">
          <svg class="brand-logo" width="16" height="16" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect width="64" height="64" rx="16" fill="currentColor"/>
            <rect x="12" y="38" width="10" height="16" rx="3" fill="white"/>
            <rect x="27" y="26" width="10" height="28" rx="3" fill="white"/>
            <rect x="42" y="14" width="10" height="40" rx="3" fill="white"/>
          </svg>
        </div>
        <span>AIUsage</span>
      </button>
      <button class="public-lang" type="button" on:click={toggleLang} title={$lang === 'en' ? '中文' : 'EN'}>
        {$lang === 'en' ? '中' : 'EN'}
      </button>
    </header>

  {#if unlockOpen}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="auth-modal-backdrop" on:click={closeUnlock}></div>
    <section class="auth-card auth-modal" role="dialog" aria-modal="true" aria-labelledby="unlock-title">
      <button class="auth-close" type="button" on:click={closeUnlock} aria-label="Close">
        <X size={14} strokeWidth={2} />
      </button>
      <div class="brand auth-brand">
        <div class="brand-logo-wrap">
          <svg class="brand-logo" width="18" height="18" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect width="64" height="64" rx="16" fill="currentColor"/>
            <rect x="12" y="38" width="10" height="16" rx="3" fill="white"/>
            <rect x="27" y="26" width="10" height="28" rx="3" fill="white"/>
            <rect x="42" y="14" width="10" height="40" rx="3" fill="white"/>
          </svg>
        </div>
        <span class="brand-name">AIUsage</span>
      </div>
      <h1 id="unlock-title">{$t('auth.unlockDashboard')}</h1>
      <p>{$t('auth.unlockHint')}</p>
      <form on:submit|preventDefault={handleLogin}>
        <!-- svelte-ignore a11y-autofocus -->
        <input
          type="password"
          bind:value={password}
          placeholder={$t('auth.password')}
          autocomplete="current-password"
          autofocus
        />
        <button type="submit" disabled={authSubmitting || !password}>
          {authSubmitting ? $t('auth.unlocking') : $t('auth.unlock')}
        </button>
      </form>
      {#if authError}
        <div class="auth-error">{authError}</div>
      {/if}
    </section>
  {/if}
  {:else}
  <aside class="sidebar" class:open={mobileOpen}>
    <div class="sidebar-inner">

      <a href="/" class="brand">
        <div class="brand-logo-wrap">
          <svg class="brand-logo" width="16" height="16" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect width="64" height="64" rx="16" fill="currentColor"/>
            <rect x="12" y="38" width="10" height="16" rx="3" fill="white"/>
            <rect x="27" y="26" width="10" height="28" rx="3" fill="white"/>
            <rect x="42" y="14" width="10" height="40" rx="3" fill="white"/>
          </svg>
        </div>
        {#if !collapsed}
          <span class="brand-name">AIUsage</span>
        {/if}
      </a>

      <div class="sidebar-search-wrap">
        <button
          type="button"
          class="cmd-trigger"
          on:click={() => cmdPalette?.openPalette()}
          title={$t('cmd.search') + ' (⌘K)'}
          aria-label={$t('cmd.search')}
        >
          <Search size={13} strokeWidth={1.9} />
          {#if !collapsed}
            <span class="cmd-trigger-text">{$t('cmd.search')}</span>
            <kbd class="cmd-kbd">⌘K</kbd>
          {/if}
        </button>
      </div>

      <nav class="sidebar-nav">
        {#each NAV_GROUPS as group}
          <div class="nav-group">
            {#if !collapsed}
              <div class="group-label">{$t(group.key)}</div>
            {/if}
            {#each group.items as item}
              <a
                href={item.path}
                class="nav-item"
                class:active={$page.url.pathname === item.path}
                title={collapsed ? $t(item.key) : undefined}
              >
                <span class="nav-icon"><svelte:component this={item.icon} size={15} strokeWidth={1.85} /></span>
                {#if !collapsed}
                  <span class="nav-label">{$t(item.key)}</span>
                {/if}
              </a>
            {/each}
          </div>
        {/each}
      </nav>

      <div class="sidebar-footer">
        <button class="ctrl-btn" on:click={cycleTheme} title={$t(`theme.${$userPref}`)} aria-label={$t(`theme.${$userPref}`)}>
          <svelte:component this={themeIcons[$userPref]} size={14} strokeWidth={1.8} />
        </button>

        <button class="ctrl-btn" on:click={toggleLang} title={$lang === 'en' ? '中文' : 'English'} aria-label="Toggle language">
          <span class="lang-icon">{$lang === 'en' ? '中' : 'EN'}</span>
        </button>

        <a class="ctrl-btn" href="https://aiusage.jtanx.com" target="_blank" rel="noopener" title="aiusage.jtanx.com" aria-label="Website">
          <ExternalLink size={14} strokeWidth={1.8} />
        </a>

        <button class="ctrl-btn" on:click={toggleSidebar} title={$t(collapsed ? 'nav.expand' : 'nav.collapse')} aria-label={$t(collapsed ? 'nav.expand' : 'nav.collapse')}>
          {#if collapsed}<PanelLeftOpen size={14} strokeWidth={1.8} />{:else}<PanelLeftClose size={14} strokeWidth={1.8} />{/if}
        </button>
      </div>

    </div>
  </aside>
  {/if}

  <div class:main-area={!shouldShowPublicHome}>

    {#if !shouldShowPublicHome}
    <header class="mobile-header">
      <button class="hamburger" on:click={toggleMobile} aria-label="Toggle menu">
        <span></span><span></span><span></span>
      </button>
      <a href="/" class="brand brand-mobile">
        <div class="brand-logo-wrap">
          <svg class="brand-logo" width="15" height="15" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect width="64" height="64" rx="16" fill="currentColor"/>
            <rect x="12" y="38" width="10" height="16" rx="3" fill="white"/>
            <rect x="27" y="26" width="10" height="28" rx="3" fill="white"/>
            <rect x="42" y="14" width="10" height="40" rx="3" fill="white"/>
          </svg>
        </div>
        <span class="brand-name">AIUsage</span>
      </a>
      <div class="mobile-controls">
        <button class="ctrl-btn" on:click={() => cmdPalette?.openPalette()} aria-label={$t('cmd.search')}>
          <Search size={14} strokeWidth={1.8} />
        </button>
        <button class="ctrl-btn" on:click={cycleTheme} aria-label="Toggle theme">
          <svelte:component this={themeIcons[$userPref]} size={14} strokeWidth={1.8} />
        </button>
        <button class="ctrl-btn" on:click={toggleLang} aria-label="Toggle language">
          <span class="lang-icon">{$lang === 'en' ? '中' : 'EN'}</span>
        </button>
      </div>
    </header>
    {/if}

    <main class:page-content={!shouldShowPublicHome} class:public-page-content={shouldShowPublicHome}>
      {#key unlockCount}
        <slot />
      {/key}
    </main>

  </div>

</div>
{/if}

<style>
  /* ── App Shell Layout ─────────────────────────────────────────────────── */
  .app {
    display: flex;
    min-height: 100vh;
    background: var(--bg);
  }

  .public-shell {
    min-height: 100vh;
    padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 2.5rem;
    background: var(--bg);
  }

  .public-header {
    max-width: 1180px;
    margin: 0 auto 1.25rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .public-page-content {
    min-height: calc(100vh - 5.5rem);
    max-width: 1180px;
    margin: 0 auto;
  }

  .public-unlock {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: 2.25rem;
    padding: 0 0.875rem 0 0.5rem;
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-sm);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease;
  }

  .public-unlock:hover {
    border-color: var(--border-medium);
    color: var(--accent);
  }

  /* Note: layout-style.test.ts strictly checks width, min-width, and padding */
  .public-lang {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    min-width: 2.5rem;
    height: 2.5rem;
    padding: 0;
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-secondary);
    box-shadow: var(--shadow-sm);
    font: inherit;
    font-size: 0.8125rem;
    font-weight: 650;
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease;
  }

  .public-lang:hover {
    border-color: var(--border-medium);
    color: var(--text);
  }

  /* ── Auth Modal / Page ─────────────────────────────────────────────────── */
  .auth-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 500;
    background: var(--overlay);
    backdrop-filter: blur(6px);
    animation: fadeIn 0.12s ease-out;
  }

  .auth-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 510;
    transform: translate(-50%, -50%);
    animation: modalPop 0.16s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes modalPop {
    from { opacity: 0; transform: translate(-50%, -48%) scale(0.98); }
    to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  }

  .auth-close {
    position: absolute;
    top: 1rem;
    right: 1rem;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    background: var(--raised);
    color: var(--text-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;
  }

  .auth-close:hover {
    color: var(--text);
    border-color: var(--border-medium);
    background: var(--hover);
  }

  .auth-page {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 1.5rem;
    background: var(--bg);
  }

  .auth-card {
    width: min(100%, 380px);
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    padding: 1.75rem;
  }

  .auth-brand {
    width: fit-content;
    padding: 0;
    margin-bottom: 1.25rem;
    border-bottom: none;
  }

  .auth-card h1 {
    font-size: 1.25rem;
    font-weight: 650;
    letter-spacing: -0.02em;
    line-height: 1.3;
    margin-bottom: 0.375rem;
    color: var(--text);
  }

  .auth-card p {
    color: var(--text-secondary);
    margin-bottom: 1.25rem;
    line-height: 1.5;
    font-size: var(--text-sm);
  }

  .auth-card form {
    display: grid;
    gap: 0.75rem;
  }

  .auth-card input {
    width: 100%;
    height: 2.375rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-medium);
    background: var(--raised);
    color: var(--text);
    padding: 0 0.75rem;
    font: inherit;
    font-size: var(--text-base);
    outline: none;
    transition: border-color 0.14s ease, background-color 0.14s ease;
  }

  .auth-card input:focus {
    border-color: var(--accent);
    background: var(--surface);
  }

  .auth-card form button {
    height: 2.375rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #ffffff;
    font: inherit;
    font-weight: 600;
    font-size: var(--text-sm);
    cursor: pointer;
    transition: background-color 0.14s ease;
  }

  .auth-card form button:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .auth-card form button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .auth-error {
    margin-top: 0.875rem;
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-sm);
    background: var(--rose-dim);
    color: var(--rose);
    font-size: var(--text-xs);
    border: 1px solid color-mix(in oklch, var(--rose) 30%, transparent);
  }

  .auth-home {
    display: inline-flex;
    align-items: center;
    margin-top: 1rem;
    color: var(--text-secondary);
    text-decoration: none;
    font-size: var(--text-xs);
    transition: color 0.14s;
  }

  .auth-home:hover {
    color: var(--accent);
  }

  .auth-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.625rem;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    padding: 1.25rem 0;
  }

  /* ── Minimalist Linear Sidebar ─────────────────────────────────────────── */
  .sidebar {
    width: var(--sidebar-width);
    height: 100vh;
    height: 100dvh;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--border-subtle);
    position: fixed;
    top: 0;
    left: 0;
    z-index: 200;
    transition: width 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .app.collapsed .sidebar {
    width: var(--sidebar-collapsed);
  }

  .sidebar-inner {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.95rem 0.875rem 0.75rem;
    text-decoration: none;
    flex-shrink: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .app.collapsed .brand {
    justify-content: center;
    padding-inline: 0.5rem;
  }

  .brand-logo-wrap {
    width: 26px;
    height: 26px;
    border-radius: 6px;
    background: var(--accent);
    color: #ffffff;
    display: grid;
    place-items: center;
    flex-shrink: 0;
  }

  .brand-logo {
    display: block;
    color: currentColor;
  }

  .brand-name {
    font-family: var(--font-sans);
    font-weight: 650;
    font-size: 0.9375rem;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .brand-mobile {
    padding: 0;
  }

  /* Command Palette Trigger */
  .sidebar-search-wrap {
    padding: 0 0.625rem 0.5rem;
    flex-shrink: 0;
  }

  .cmd-trigger {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    height: 1.875rem;
    padding: 0 0.55rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text-muted);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: border-color 0.14s ease, color 0.14s ease, background-color 0.14s ease;
  }

  .app.collapsed .cmd-trigger {
    justify-content: center;
    padding: 0;
  }

  .cmd-trigger:hover {
    border-color: var(--border-medium);
    color: var(--text);
    background: var(--raised);
  }

  .cmd-trigger-text {
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cmd-kbd {
    font-size: 0.625rem;
    font-weight: 600;
    color: var(--text-muted);
    background: var(--raised);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 0.05rem 0.3rem;
    line-height: 1.3;
  }

  /* Navigation */
  .sidebar-nav {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0.25rem 0 0.75rem;
    scrollbar-width: thin;
    scrollbar-color: var(--border-subtle) transparent;
  }

  .nav-group {
    margin-bottom: 0.75rem;
  }

  .group-label {
    font-family: var(--font-sans);
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-muted);
    padding: 0.375rem 0.875rem 0.2rem;
    white-space: nowrap;
    overflow: hidden;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.38rem 0.625rem;
    margin: 1px 0.5rem;
    text-decoration: none;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
    border-radius: var(--radius-xs);
    transition: background-color 0.12s ease, color 0.12s ease;
    position: relative;
    white-space: nowrap;
    overflow: hidden;
  }

  .app.collapsed .nav-item {
    justify-content: center;
    padding: 0.42rem 0;
    margin: 2px 0.5rem;
  }

  .nav-item:hover {
    color: var(--text);
    background: var(--hover);
  }

  .nav-item.active {
    color: var(--text);
    background: var(--raised);
    font-weight: 600;
  }

  .nav-item.active::before {
    content: '';
    position: absolute;
    left: 0;
    top: 5px;
    bottom: 5px;
    width: 2.5px;
    border-radius: 2px;
    background: var(--accent);
  }

  .app.collapsed .nav-item.active::before {
    display: none;
  }

  .nav-item.active .nav-icon {
    color: var(--accent);
  }

  .nav-icon {
    width: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--text-muted);
    transition: color 0.12s ease;
  }

  .nav-item:hover .nav-icon {
    color: var(--text-secondary);
  }

  .nav-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Compact Single-Row Footer */
  .sidebar-footer {
    padding: 0.5rem;
    border-top: 1px solid var(--border-subtle);
    flex-shrink: 0;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.25rem;
    background: var(--sidebar-bg);
  }

  .app.collapsed .sidebar-footer {
    grid-template-columns: 1fr;
  }

  .ctrl-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 1.875rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-xs);
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;
  }

  .ctrl-btn:hover {
    color: var(--text);
    background: var(--hover);
  }

  .lang-icon {
    font-size: 0.6875rem;
    font-weight: 700;
    line-height: 1;
  }

  /* ── Main Area ────────────────────────────────────────────────────────── */
  .main-area {
    flex: 1;
    min-width: 0;
    margin-left: var(--sidebar-width);
    transition: margin-left 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .app.collapsed .main-area {
    margin-left: var(--sidebar-collapsed);
  }

  /* Mobile Top Bar */
  .mobile-header {
    display: none;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 1rem;
    background: var(--sidebar-bg);
    border-bottom: 1px solid var(--border-subtle);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .hamburger {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    background: transparent;
    border: none;
    cursor: pointer;
    border-radius: 6px;
  }

  .hamburger span {
    display: block;
    width: 17px;
    height: 1.5px;
    background: var(--text-secondary);
    border-radius: 1px;
  }

  .hamburger:hover span {
    background: var(--text);
  }

  .mobile-controls {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .mobile-controls .ctrl-btn {
    width: 1.875rem;
  }

  /* Page Content Container */
  .page-content {
    flex: 1;
    min-width: 0;
    padding: 1.75rem clamp(1rem, 3vw, 2.5rem) 2.5rem;
    width: 100%;
    max-width: 1520px;
    margin-inline: auto;
    animation: fadeIn 0.16s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(3px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .mobile-backdrop {
    display: none;
    position: fixed;
    inset: 0;
    background: var(--overlay);
    backdrop-filter: blur(4px);
    z-index: 190;
  }

  /* ── Mobile Overrides ─────────────────────────────────────────────────── */
  @media (max-width: 800px) {
    .sidebar {
      transform: translateX(-100%);
      width: var(--sidebar-width) !important;
      box-shadow: var(--shadow-lg);
    }
    .sidebar.open {
      transform: translateX(0);
    }
    .main-area {
      margin-left: 0 !important;
    }
    .mobile-header {
      display: flex;
    }
    .mobile-backdrop {
      display: block;
    }
    .page-content {
      padding: 1.125rem 0.875rem 2rem;
    }
    .public-shell {
      padding: 1rem 0.875rem 1.5rem;
    }
    .public-header {
      margin-bottom: 1rem;
    }
    .public-unlock {
      height: 2.25rem;
      padding: 0 0.875rem 0 0.45rem;
      font-size: 0.8125rem;
    }
    .public-lang {
      min-width: 2.25rem;
      height: 2.25rem;
      padding: 0;
    }
  }

  @media (min-width: 801px) {
    .mobile-backdrop { display: none !important; }
  }
</style>
