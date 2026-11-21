<script>
  import { page } from '$app/stores'
  import { onDestroy, onMount } from 'svelte'
  import { lang, toggleLang, t } from '$lib/i18n.js'
  import { userPref, cycleTheme, initTheme } from '$lib/theme.js'
  import { fetchConfig, fetchAuthStatus, login } from '$lib/api.js'
  import { displayCurrency, exchangeRate } from '$lib/stores.js'
  import { getAuthShellState } from '$lib/auth-shell.js'
  import {
    House, LayoutDashboard, Coins, DollarSign, Box,
    MessageSquare, FolderKanban, Wrench,
    Gauge, Tag, Settings,
    Sun, Moon, MonitorCog,
    Languages, PanelLeftClose, PanelLeftOpen, ExternalLink
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
    // Initialize currency stores from config
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
          <svg class="brand-logo" width="22" height="22" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
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
        <span class="auth-spin"></span>
        <span>{$t('auth.checking')}</span>
      </div>
    </section>
  </main>
{:else}
<!-- The public home and the full shell share one <slot />, so the page is not
     mounted a second time when the auth check settles on `/` (issue #109). -->
<div class:app={!shouldShowPublicHome} class:public-shell={shouldShowPublicHome} class:collapsed>

  {#if shouldShowPublicHome}
    <header class="public-header">
      <button class="public-unlock" type="button" on:click={openUnlock} aria-label={$t('auth.unlockDashboard')}>
        <div class="brand-logo-wrap">
          <svg class="brand-logo" width="18" height="18" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
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
      <button class="auth-close" type="button" on:click={closeUnlock} aria-label="Close">×</button>
      <div class="brand auth-brand">
        <div class="brand-logo-wrap">
          <svg class="brand-logo" width="22" height="22" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
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
          <svg class="brand-logo" width="20" height="20" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect width="64" height="64" rx="16" fill="currentColor"/>
            <rect x="12" y="38" width="10" height="16" rx="3" fill="white"/>
            <rect x="27" y="26" width="10" height="28" rx="3" fill="white"/>
            <rect x="42" y="14" width="10" height="40" rx="3" fill="white"/>
          </svg>
        </div>
        {#if !collapsed}
          <div class="brand-text-wrap">
            <span class="brand-name">AIUsage</span>
            <span class="brand-tag">PRO</span>
          </div>
        {/if}
      </a>

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
                <span class="nav-icon"><svelte:component this={item.icon} size={16} strokeWidth={1.8} /></span>
                {#if !collapsed}
                  <span class="nav-label">{$t(item.key)}</span>
                {/if}
                {#if $page.url.pathname === item.path}
                  <span class="nav-active-pill" aria-hidden="true"></span>
                {/if}
              </a>
            {/each}
          </div>
        {/each}
      </nav>

      <div class="sidebar-footer">
        <button class="ctrl-btn" on:click={cycleTheme} title={$t(`theme.${$userPref}`)}>
          <span class="ctrl-icon"><svelte:component this={themeIcons[$userPref]} size={14} strokeWidth={1.75} /></span>
          {#if !collapsed}
            <span class="ctrl-label">{$t(`theme.${$userPref}`)}</span>
          {/if}
        </button>

        <button class="ctrl-btn" on:click={toggleLang} title={$lang === 'en' ? '中文' : 'EN'}>
          <span class="ctrl-icon lang-icon">{$lang === 'en' ? '中' : 'EN'}</span>
          {#if !collapsed}
            <span class="ctrl-label">{$lang === 'en' ? '中文' : 'English'}</span>
          {/if}
        </button>

        <button class="ctrl-btn collapse-btn" on:click={toggleSidebar} title={$t(collapsed ? 'nav.expand' : 'nav.collapse')}>
          <span class="ctrl-icon">{#if collapsed}<PanelLeftOpen size={14} strokeWidth={1.75} />{:else}<PanelLeftClose size={14} strokeWidth={1.75} />{/if}</span>
          {#if !collapsed}
            <span class="ctrl-label">{$t('nav.collapse')}</span>
          {/if}
        </button>

        <a class="ctrl-btn" href="https://aiusage.jtanx.com" target="_blank" rel="noopener" title="aiusage.jtanx.com">
          <span class="ctrl-icon"><ExternalLink size={14} strokeWidth={1.75} /></span>
          {#if !collapsed}
            <span class="ctrl-label">{$lang === 'en' ? 'Website' : '官网'}</span>
          {/if}
        </a>
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
          <svg class="brand-logo" width="18" height="18" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect width="64" height="64" rx="16" fill="currentColor"/>
            <rect x="12" y="38" width="10" height="16" rx="3" fill="white"/>
            <rect x="27" y="26" width="10" height="28" rx="3" fill="white"/>
            <rect x="42" y="14" width="10" height="40" rx="3" fill="white"/>
          </svg>
        </div>
        <span class="brand-name">AIUsage</span>
      </a>
      <div class="mobile-controls">
        <button class="ctrl-btn" on:click={cycleTheme} aria-label="Toggle theme">
          <span class="ctrl-icon"><svelte:component this={themeIcons[$userPref]} size={14} strokeWidth={1.75} /></span>
        </button>
        <button class="ctrl-btn" on:click={toggleLang} aria-label="Toggle language">
          <span class="ctrl-icon lang-icon">{$lang === 'en' ? '中' : 'EN'}</span>
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
  /* ── Reset & Base ───────────────────────────────────────────────────────── */
  :global(*) {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }
  :global(html) {
    font-size: 112.5%;
    color-scheme: light;
  }
  :global(html[data-theme="dark"]) {
    color-scheme: dark;
  }
  :global(body) {
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: 1.6;
    font-variant-numeric: tabular-nums;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    transition: background-color 0.25s cubic-bezier(0.16, 1, 0.3, 1), color 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  }
  :global(button), :global(input), :global(select), :global(textarea) {
    font: inherit;
    letter-spacing: normal;
  }
  :global(:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  :global(::selection) {
    background: var(--accent-dim);
    color: var(--accent-strong);
  }

  /* ── Custom Modern Scrollbar ───────────────────────────────────────────── */
  :global(::-webkit-scrollbar) {
    width: 6px;
    height: 6px;
  }
  :global(::-webkit-scrollbar-track) {
    background: transparent;
  }
  :global(::-webkit-scrollbar-thumb) {
    background: var(--border-medium);
    border-radius: 999px;
  }
  :global(::-webkit-scrollbar-thumb:hover) {
    background: var(--text-muted);
  }

  /* ── Light Theme (Vercel/Linear Clean Crisp Style) ──────────────────────── */
  :global(:root) {
    --font-sans: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
    --font-numeric: var(--font-sans);
    --text-xs: 0.75rem;
    --text-sm: 0.8125rem;
    --text-base: 0.875rem;
    --text-title: 1.5rem;
    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 16px;
    --control-height: 2.125rem;

    --bg: oklch(0.985 0.003 240);
    --surface: oklch(1 0 0);
    --surface-elevated: oklch(1 0 0);
    --raised: oklch(0.968 0.004 240);
    --hover: oklch(0.948 0.006 240);
    --sidebar-bg: oklch(0.99 0.002 240 / 0.88);
    
    --border-subtle: oklch(0.915 0.006 240);
    --border-medium: oklch(0.84 0.01 240);
    --border-highlight: oklch(0 0 0 / 0.06);

    --text: oklch(0.18 0.015 250);
    --text-secondary: oklch(0.42 0.015 250);
    --text-muted: oklch(0.55 0.012 250);

    --accent: oklch(0.58 0.17 160);
    --accent-strong: oklch(0.50 0.18 160);
    --accent-dim: oklch(0.58 0.17 160 / 0.12);
    --accent-hover: oklch(0.53 0.18 160);

    --green: oklch(0.62 0.17 150);
    --green-dim: oklch(0.62 0.17 150 / 0.12);
    --blue: oklch(0.56 0.15 250);
    --blue-dim: oklch(0.56 0.15 250 / 0.12);
    --purple: oklch(0.58 0.16 300);
    --purple-dim: oklch(0.58 0.16 300 / 0.12);
    --rose: oklch(0.58 0.20 25);
    --rose-dim: oklch(0.58 0.20 25 / 0.12);
    --amber: oklch(0.70 0.17 75);
    --amber-dim: oklch(0.70 0.17 75 / 0.12);

    --badge-override-bg: oklch(0.58 0.17 160 / 0.12);
    --badge-override-fg: oklch(0.58 0.17 160);
    --badge-matched-bg: oklch(0.62 0.17 150 / 0.12);
    --badge-matched-fg: oklch(0.62 0.17 150);
    --badge-noprice-bg: oklch(0.58 0.20 25 / 0.10);
    --badge-noprice-fg: oklch(0.58 0.20 25);

    --shadow-sm: 0 1px 2px 0 oklch(0 0 0 / 0.04), 0 0 0 1px oklch(0 0 0 / 0.02);
    --shadow-md: 0 4px 12px -2px oklch(0 0 0 / 0.05), 0 2px 6px -1px oklch(0 0 0 / 0.03), 0 0 0 1px oklch(0 0 0 / 0.03);
    --shadow-lg: 0 12px 28px -4px oklch(0 0 0 / 0.08), 0 4px 12px -2px oklch(0 0 0 / 0.04), 0 0 0 1px oklch(0 0 0 / 0.04);
    --glow-card: 0 0 0 1px var(--border-subtle);

    --overlay: oklch(0 0 0 / 0.35);
    --mono: 'JetBrains Mono', 'SF Mono', Consolas, ui-monospace, monospace;
    --sidebar-width: 224px;
    --sidebar-collapsed: 68px;

    --chart-input: oklch(0.64 0.15 160);
    --chart-output: oklch(0.58 0.16 250);
    --chart-cache-read: oklch(0.70 0.12 70);
    --chart-cache-write: oklch(0.65 0.14 310);
    --chart-thinking: oklch(0.62 0.18 25);
    --chart-total: oklch(0.58 0.17 160);
  }

  /* ── Dark Theme (Linear / Vercel Deep Metallic Aesthetic) ───────────────── */
  :global(:root[data-theme="dark"]) {
    --bg: oklch(0.13 0.006 250);
    --surface: oklch(0.165 0.008 250);
    --surface-elevated: oklch(0.19 0.010 250);
    --raised: oklch(0.20 0.010 250);
    --hover: oklch(0.235 0.012 250);
    --sidebar-bg: oklch(0.145 0.007 250 / 0.85);

    --border-subtle: oklch(1 0 0 / 0.07);
    --border-medium: oklch(1 0 0 / 0.13);
    --border-highlight: oklch(1 0 0 / 0.12);

    --text: oklch(0.96 0.005 250);
    --text-secondary: oklch(0.76 0.01 250);
    --text-muted: oklch(0.56 0.01 250);

    --accent: oklch(0.74 0.18 160);
    --accent-strong: oklch(0.82 0.16 160);
    --accent-dim: oklch(0.74 0.18 160 / 0.15);
    --accent-hover: oklch(0.80 0.17 160);

    --green: oklch(0.75 0.16 150);
    --green-dim: oklch(0.75 0.16 150 / 0.16);
    --blue: oklch(0.74 0.15 250);
    --blue-dim: oklch(0.74 0.15 250 / 0.16);
    --purple: oklch(0.75 0.15 300);
    --purple-dim: oklch(0.75 0.15 300 / 0.16);
    --rose: oklch(0.73 0.19 25);
    --rose-dim: oklch(0.73 0.19 25 / 0.16);
    --amber: oklch(0.78 0.16 75);
    --amber-dim: oklch(0.78 0.16 75 / 0.16);

    --badge-override-bg: oklch(0.74 0.18 160 / 0.18);
    --badge-override-fg: oklch(0.74 0.18 160);
    --badge-matched-bg: oklch(0.75 0.16 150 / 0.18);
    --badge-matched-fg: oklch(0.75 0.16 150);
    --badge-noprice-bg: oklch(0.73 0.19 25 / 0.16);
    --badge-noprice-fg: oklch(0.73 0.19 25);

    --shadow-sm: 0 1px 3px 0 oklch(0 0 0 / 0.45), inset 0 1px 0 0 oklch(1 0 0 / 0.05);
    --shadow-md: 0 4px 16px 0 oklch(0 0 0 / 0.55), inset 0 1px 0 0 oklch(1 0 0 / 0.08);
    --shadow-lg: 0 16px 36px 0 oklch(0 0 0 / 0.70), inset 0 1px 0 0 oklch(1 0 0 / 0.10);
    --glow-card: 0 0 0 1px oklch(1 0 0 / 0.07);

    --overlay: oklch(0 0 0 / 0.65);

    --chart-input: oklch(0.75 0.15 160);
    --chart-output: oklch(0.73 0.15 250);
    --chart-cache-read: oklch(0.78 0.10 70);
    --chart-cache-write: oklch(0.75 0.12 310);
    --chart-thinking: oklch(0.74 0.18 25);
    --chart-total: oklch(0.74 0.18 160);
  }

  /* ── App Shell Layout ─────────────────────────────────────────────────── */
  .app {
    display: flex;
    min-height: 100vh;
    background: radial-gradient(circle at 18% 0%, var(--accent-dim) 0%, transparent 40%), var(--bg);
    background-attachment: fixed;
  }

  .public-shell {
    min-height: 100vh;
    padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 2.5rem;
    background: radial-gradient(circle at 50% 0%, var(--accent-dim) 0%, transparent 50%), var(--bg);
  }

  .public-header {
    max-width: 1200px;
    margin: 0 auto 1.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .public-page-content {
    min-height: calc(100vh - 5.5rem);
    max-width: 1200px;
    margin: 0 auto;
  }

  .public-unlock {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    height: 2.5rem;
    padding: 0 1.1rem;
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-sm);
    font: inherit;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    backdrop-filter: blur(12px);
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .public-unlock:hover {
    border-color: var(--accent);
    color: var(--accent);
    transform: translateY(-1px);
    box-shadow: var(--shadow-md);
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
    font-weight: 700;
    cursor: pointer;
    backdrop-filter: blur(12px);
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .public-lang:hover {
    border-color: var(--border-medium);
    color: var(--accent);
    transform: translateY(-1px);
  }

  /* ── Auth Modal / Page ─────────────────────────────────────────────────── */
  .auth-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 500;
    background: var(--overlay);
    backdrop-filter: blur(12px);
    animation: fadeIn 0.15s ease-out;
  }

  .auth-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 510;
    transform: translate(-50%, -50%);
    animation: modalPop 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes modalPop {
    from { opacity: 0; transform: translate(-50%, -46%) scale(0.96); }
    to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  }

  .auth-close {
    position: absolute;
    top: 1rem;
    right: 1rem;
    width: 2rem;
    height: 2rem;
    border-radius: 999px;
    border: 1px solid var(--border-subtle);
    background: var(--raised);
    color: var(--text-secondary);
    font-size: 1.25rem;
    line-height: 1;
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: all 0.15s ease;
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
    background:
      radial-gradient(circle at 50% 20%, var(--accent-dim) 0%, transparent 45%),
      var(--bg);
  }

  .auth-card {
    width: min(100%, 400px);
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    padding: 2rem 1.75rem;
    backdrop-filter: blur(16px);
  }

  .auth-brand {
    width: fit-content;
    padding: 0;
    margin-bottom: 1.5rem;
  }

  .auth-card h1 {
    font-size: 1.35rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.3;
    margin-bottom: 0.375rem;
    color: var(--text);
  }

  .auth-card p {
    color: var(--text-secondary);
    margin-bottom: 1.5rem;
    line-height: 1.5;
    font-size: 0.875rem;
  }

  .auth-card form {
    display: grid;
    gap: 0.875rem;
  }

  .auth-card input {
    width: 100%;
    height: 2.75rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-medium);
    background: var(--raised);
    color: var(--text);
    padding: 0 1rem;
    font: inherit;
    font-size: 0.9375rem;
    outline: none;
    transition: all 0.15s ease;
  }

  .auth-card input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-dim);
    background: var(--surface);
  }

  .auth-card button {
    height: 2.75rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #ffffff;
    font: inherit;
    font-weight: 600;
    font-size: 0.9375rem;
    cursor: pointer;
    box-shadow: 0 2px 8px -1px var(--accent-dim);
    transition: all 0.15s ease;
  }

  .auth-card button:hover:not(:disabled) {
    background: var(--accent-hover);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px 0 var(--accent-dim);
  }

  .auth-card button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .auth-error {
    margin-top: 1rem;
    padding: 0.625rem 0.875rem;
    border-radius: var(--radius-sm);
    background: var(--rose-dim);
    color: var(--rose);
    font-size: 0.875rem;
    border: 1px solid var(--rose-dim);
  }

  .auth-home {
    display: inline-flex;
    align-items: center;
    margin-top: 1.25rem;
    color: var(--text-secondary);
    text-decoration: none;
    font-size: 0.875rem;
    transition: color 0.15s;
  }

  .auth-home:hover {
    color: var(--accent);
  }

  .auth-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    color: var(--text-secondary);
    padding: 1.5rem 0;
  }

  .auth-spin {
    width: 18px;
    height: 18px;
    border: 2px solid var(--border-medium);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ── Modern Linear Sidebar ─────────────────────────────────────────────── */
  .sidebar {
    width: var(--sidebar-width);
    height: 100vh;
    height: 100dvh;
    background: var(--sidebar-bg);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-right: 1px solid var(--border-subtle);
    position: fixed;
    top: 0;
    left: 0;
    z-index: 200;
    transition: width 0.22s cubic-bezier(0.16, 1, 0.3, 1);
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

  /* Brand Logo & Name */
  .brand {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1.125rem 1rem;
    text-decoration: none;
    flex-shrink: 0;
    overflow: hidden;
    white-space: nowrap;
    border-bottom: 1px solid var(--border-subtle);
  }

  .brand-logo-wrap {
    width: 32px;
    height: 32px;
    border-radius: 9px;
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%);
    color: #ffffff;
    display: grid;
    place-items: center;
    box-shadow: 0 2px 8px -1px var(--accent-dim);
    flex-shrink: 0;
  }

  .brand-logo {
    display: block;
    color: currentColor;
    width: 20px;
    height: 20px;
  }

  .brand-text-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .brand-name {
    font-family: var(--font-sans);
    font-weight: 700;
    font-size: 1.0625rem;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .brand-tag {
    font-size: 0.625rem;
    font-weight: 700;
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
    background: var(--accent-dim);
    color: var(--accent-strong);
    letter-spacing: 0.04em;
  }

  .brand-mobile {
    padding: 0;
    border-bottom: none;
  }

  /* Navigation */
  .sidebar-nav {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0.75rem 0;
    scrollbar-width: thin;
    scrollbar-color: var(--border-subtle) transparent;
  }

  .nav-group {
    margin-bottom: 0.875rem;
  }

  .group-label {
    font-family: var(--font-sans);
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    padding: 0.375rem 1.125rem 0.25rem;
    white-space: nowrap;
    overflow: hidden;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    margin: 0.125rem 0.5rem;
    text-decoration: none;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
    border-radius: var(--radius-sm);
    transition: all 0.16s cubic-bezier(0.16, 1, 0.3, 1);
    position: relative;
    white-space: nowrap;
    overflow: hidden;
  }

  .nav-item:hover {
    color: var(--text);
    background: var(--hover);
  }

  .nav-item.active {
    color: var(--accent);
    background: var(--accent-dim);
    font-weight: 600;
  }

  .nav-active-pill {
    position: absolute;
    right: 0.5rem;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent);
  }

  .nav-icon {
    width: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .nav-label {
    flex: 1;
    min-width: 0;
  }

  /* Sidebar footer controls */
  .sidebar-footer {
    padding: 0.625rem 0.375rem;
    border-top: 1px solid var(--border-subtle);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    background: var(--surface);
  }

  .ctrl-btn {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.375rem 0.75rem;
    margin: 0 0.25rem;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.16s ease;
    white-space: nowrap;
    overflow: hidden;
    width: calc(100% - 0.5rem);
    text-align: left;
    text-decoration: none;
    min-height: var(--control-height);
  }

  .ctrl-btn:hover {
    color: var(--text);
    background: var(--hover);
  }

  .ctrl-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .ctrl-icon {
    width: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .lang-icon {
    font-size: 0.75rem;
    font-weight: 700;
  }

  .ctrl-label {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 500;
    flex: 1;
  }

  .collapse-btn { margin-top: 0.125rem; }

  /* ── Main Area ────────────────────────────────────────────────────────── */
  .main-area {
    flex: 1;
    min-width: 0;
    margin-left: var(--sidebar-width);
    transition: margin-left 0.22s cubic-bezier(0.16, 1, 0.3, 1);
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
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: var(--sidebar-bg);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
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
    width: 18px;
    height: 1.5px;
    background: var(--text-secondary);
    border-radius: 1px;
    transition: background 0.15s;
  }

  .hamburger:hover span {
    background: var(--text);
  }

  .mobile-controls {
    margin-left: auto;
    display: flex;
    gap: 0.25rem;
  }

  .mobile-controls .ctrl-btn {
    padding: 0.25rem 0.5rem;
    width: auto;
    margin: 0;
  }

  /* Page Content Container */
  .page-content {
    flex: 1;
    min-width: 0;
    padding: 2.25rem clamp(1.25rem, 3.5vw, 3.25rem);
    width: 100%;
    max-width: 1600px;
    margin-inline: auto;
    animation: fadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Mobile Backdrop */
  .mobile-backdrop {
    display: none;
    position: fixed;
    inset: 0;
    background: var(--overlay);
    backdrop-filter: blur(8px);
    z-index: 190;
  }

  /* ── Universal Component Tokens ────────────────────────────────────────── */
  :global(.card) {
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 1.35rem 1.5rem;
    box-shadow: var(--shadow-sm);
    transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.2s ease;
    overflow: hidden;
    position: relative;
  }

  :global(.card:hover) {
    border-color: var(--border-medium);
  }

  :global(.section-title) {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 700;
    letter-spacing: -0.01em;
    line-height: 1.4;
    color: var(--text);
    margin-bottom: 1.125rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  :global(.page-header) {
    margin-bottom: 1.75rem;
  }

  :global(.page-header h1) {
    font-size: 1.625rem;
    font-weight: 700;
    letter-spacing: -0.025em;
    color: var(--text);
    line-height: 1.25;
    margin-bottom: 0.375rem;
  }

  :global(.page-header p) {
    font-size: 0.875rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  :global(.page-header-row) {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  :global(.filter-bar) {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin-bottom: 1.5rem;
    flex-wrap: wrap;
    padding: 0.625rem 0.875rem;
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    backdrop-filter: blur(12px);
  }

  :global(table) {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
  }

  :global(th) {
    font-family: var(--font-sans);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    text-align: left;
    padding: 0.75rem 1rem;
    background: var(--raised);
    border-bottom: 1px solid var(--border-subtle);
  }

  :global(th:first-child) {
    border-top-left-radius: var(--radius-sm);
  }
  :global(th:last-child) {
    border-top-right-radius: var(--radius-sm);
  }

  :global(td) {
    padding: 0.875rem 1rem;
    border-bottom: 1px solid var(--border-subtle);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    transition: color 0.15s, background-color 0.15s;
  }

  :global(tbody tr) {
    transition: background-color 0.15s ease;
  }

  :global(tbody tr:hover) {
    background: var(--hover);
  }

  :global(tbody tr:last-child td) {
    border-bottom: none;
  }

  :global(.mono) { font-family: var(--mono); }
  :global(.numeric) {
    font-family: var(--font-numeric);
    font-variant-numeric: tabular-nums;
  }
  :global(code), :global(pre), :global(kbd) { font-family: var(--mono); }
  :global(.accent) { color: var(--accent); }
  :global(.green) { color: var(--green); }
  :global(.blue) { color: var(--blue); }
  :global(.purple) { color: var(--purple); }

  :global(.state-msg) {
    text-align: center;
    padding: 4.5rem 2rem;
    color: var(--text-muted);
    font-size: 0.875rem;
    background: var(--surface);
    border: 1px dashed var(--border-subtle);
    border-radius: var(--radius-md);
  }

  :global(.state-msg h2) {
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 0.5rem;
  }

  :global(.state-msg.error) {
    color: var(--rose);
    border-color: var(--rose-dim);
    background: var(--rose-dim);
  }

  /* ── Reduced Motion ───────────────────────────────────────────────────── */
  @media (prefers-reduced-motion: reduce) {
    :global(*) {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
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
      padding: 1.25rem 1rem;
    }
    .public-shell {
      padding: 1rem 0.875rem 1.5rem;
    }
    .public-header {
      margin-bottom: 1rem;
    }
    .public-unlock {
      height: 2.25rem;
      padding: 0 0.875rem;
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
