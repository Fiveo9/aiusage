import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'
import { createRequestTracker } from '../src/lib/sessions-paging.js'
import { createScriptHarness, deferred, flushScript } from './script-harness.js'

const views: Array<ReturnType<typeof createScriptHarness>> = []
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('alert', vi.fn()) })
afterEach(() => { for (const rendered of views.splice(0)) rendered.destroy(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function base() {
  return { t: writable((key: string) => `en:${key}`), recalcStatus: writable('idle'), displayCurrency: writable('USD'), exchangeRate: writable(0.137),
    createRequestTracker, fetchPricing: async () => ({ models: [], targets: [], localBindings: [], registry: { totalPrices: 0 } }),
    fetchPricingRecalcStatus: async () => ({ state: 'idle', needsRecalc: false }),
    fetchConfig: async () => ({ sync: { backend: 'github', repo: 'owner/old' }, credentialStatus: { githubApp: true }, syncInterval: null }),
    fetchDetectedTools: async () => ({ tools: [] }), fetchSyncStatus: async () => ({ status: { isRunning: false } }),
    splitSettingsSources: () => ({ manualImportTools: [], activeDetectedTools: [], notFoundDetectedTools: [] }),
    githubConnection: vi.fn(async () => ({ ok: true })), notifySettingsUpdated: vi.fn(), saveConfig: vi.fn(async () => ({})),
  }
}
function view(page: 'pricing' | 'settings', input: Record<string, unknown>, fields: string | ((source: string) => string), setup = '') {
  const result = createScriptHarness(new URL(`../src/routes/${page}/+page.svelte`, import.meta.url), input, fields, setup)
  views.push(result)
  return result
}
const repoSetup = `syncData = { backend: 'github', repo: 'owner/old', bucket: '', prefix: '', endpoint: '', region: '' };
  ghConnection = { sessionId: 'synthetic-session' }; prevRepo = 'owner/old'; savedSyncSnapshot = syncSnapshot();`

describe('review pricing lifecycle and single polling owner', () => {
  it('tracks global display currency changes after initial construction', async () => {
    const input = base()
    const rendered = view('pricing', input, '{ viewCurrency }')
    input.displayCurrency.set('CNY'); await flushScript()
    expect(rendered.reports.at(-1).viewCurrency).toBe('CNY')
  })
  it('does not restart polling from a response received after unmount', async () => {
    const status = deferred()
    const rendered = view('pricing', { ...base(), fetchPricingRecalcStatus: () => status.promise }, '{ refreshRecalcStatus }')
    const refreshing = rendered.reports.at(-1).refreshRecalcStatus()
    rendered.destroy(); status.resolve({ state: 'running' }); await refreshing; await flushScript()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('uses only the owned completion loop, without a simultaneous interval poll', async () => {
    const status = { state: 'queued', total: 1, processed: 0 }
    const fetchPricingRecalcStatus = vi.fn(async () => status)
    const rendered = view('pricing', { ...base(), recalcPricing: async () => ({ accepted: true, status }), fetchPricingRecalcStatus }, '{ startRecalcCosts }')
    const running = rendered.reports.at(-1).startRecalcCosts()
    try {
      await flushScript(); await vi.advanceTimersByTimeAsync(750)
      expect(fetchPricingRecalcStatus).toHaveBeenCalledTimes(3)
    } finally {
      rendered.destroy(); await vi.advanceTimersByTimeAsync(1000); await running
    }
  })
  it('releases completion sleep timers immediately on unmount', async () => {
    const status = { state: 'queued', total: 1, processed: 0 }
    const rendered = view('pricing', { ...base(), recalcPricing: async () => ({ accepted: true, status }), fetchPricingRecalcStatus: async () => status }, '{ startRecalcCosts }')
    const running = rendered.reports.at(-1).startRecalcCosts(); await flushScript()
    rendered.destroy()
    try { expect(vi.getTimerCount()).toBe(0) }
    finally { await vi.advanceTimersByTimeAsync(1000); await running }
  })
  it('refuses a negative rate before invoking the API', async () => {
    const updatePricing = vi.fn(async () => ({}))
    const rendered = view('pricing', { ...base(), updatePricing }, '{ saveEdit }', 'editValues = { input: -1, output: 0 }; editingCurrency = "USD";')
    await rendered.reports.at(-1).saveEdit('boundary-model')
    expect(updatePricing).not.toHaveBeenCalled()
  })
})

describe('review settings receipts and timer ownership', () => {
  it('confirms the selected repository and updates the saved snapshot/previous repo', async () => {
    const rendered = view('settings', base(), '{ selectGitHubRepository, prevRepo, syncDirty }', repoSetup)
    await rendered.reports.at(-1).selectGitHubRepository('owner/new'); await flushScript()
    expect(rendered.reports.at(-1)).toMatchObject({ prevRepo: 'owner/new', syncDirty: false })
  })
  it('does not claim an unrelated automatic-sync draft was saved by repository selection', async () => {
    const setup = `${repoSetup} autoSyncEnabled = true; savedSyncSnapshot = syncSnapshot(); autoSyncEnabled = false;`
    const rendered = view('settings', base(), '{ selectGitHubRepository, prevRepo, syncDirty }', setup)
    await rendered.reports.at(-1).selectGitHubRepository('owner/new'); await flushScript()
    expect(rendered.reports.at(-1)).toMatchObject({ prevRepo: 'owner/new', syncDirty: true })
  })
  it('starts polling an already running sync when the settings page mounts', async () => {
    const fetchSyncStatus = vi.fn(async () => ({ status: { isRunning: true } }))
    const rendered = view('settings', { ...base(), fetchSyncStatus }, '{ syncRunning }')
    await rendered.mount(); await flushScript(); await vi.advanceTimersByTimeAsync(900)
    expect(fetchSyncStatus.mock.calls.length).toBeGreaterThan(1)
    rendered.destroy(); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['saveGeneral', 'saveSync'])('does not create a saved notice from a late %s receipt', async method => {
    const saving = deferred()
    const rendered = view('settings', { ...base(), saveConfig: () => saving.promise }, `{ ${method} }`,
      'syncData.backend = "cloud";')
    const result = rendered.reports.at(-1)[method](); await flushScript(); rendered.destroy()
    saving.resolve({ ok: true }); await result; await flushScript()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels an acknowledged GitHub flow received after unmount instead of scheduling its poll', async () => {
    const starting = deferred()
    const githubConnection = vi.fn((action: string) => action === 'start' ? starting.promise : Promise.resolve({ ok: true }))
    const rendered = view('settings', { ...base(), githubConnection }, '{ connectGitHub }')
    const result = rendered.reports.at(-1).connectGitHub(); await flushScript(); rendered.destroy()
    starting.resolve({ sessionId: 'synthetic-late-flow' }); await result; await flushScript()
    expect(vi.getTimerCount()).toBe(0)
    expect(githubConnection).toHaveBeenCalledWith('cancel', { sessionId: 'synthetic-late-flow' })
  })
})

describe('review remaining template language dependencies', () => {
  it('updates pricing binding/action labels through actual template arguments', async () => {
    const input = base()
    const rendered = view('pricing', input, source => {
      const markup = source.slice(source.indexOf('</script>') + 9)
      const bindingArgs = markup.match(/bindingLabel\(([^)]*)\)/)![1].split(',').slice(1).join(',')
      const hasActionT = /aliasActionLabel\([^)]*\$t\)/.test(markup)
      const binding = '{ hasPrice: true, modelKey: "key", bindingType: "manual", hasManualBinding: true }'
      return `{ binding: bindingLabel(${binding}${bindingArgs ? `,${bindingArgs}` : ''}),
        action: aliasActionLabel("alias", ${binding}, "key"${hasActionT ? ', $t' : ''}) }`
    })
    input.t.set((key: string) => `zh:${key}`); await flushScript()
    expect(rendered.reports.at(-1)).toEqual({ binding: 'zh:pricing.manualBinding', action: 'zh:pricing.unbindAlias' })
  })
  it('updates the settings never-synced label through its template call', async () => {
    const input = base()
    const rendered = view('settings', input, source => {
      const args = source.slice(source.indexOf('</script>') + 9).match(/formatSyncTime\(([^)]*)\)/)![1].split(',').slice(1).join(',')
      return `{ label: formatSyncTime(null${args ? `,${args}` : ''}) }`
    })
    input.t.set((key: string) => `zh:${key}`); await flushScript()
    expect(rendered.reports.at(-1).label).toBe('zh:settings.syncNever')
  })
})
