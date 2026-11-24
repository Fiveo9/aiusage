import { afterEach, describe, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import { writable } from 'svelte/store'
import { createRequestTracker } from '../src/lib/sessions-paging.js'
import { getAuthShellState } from '../src/lib/auth-shell.js'
import { tokenComposition } from '../src/lib/token-composition.js'
import { createScriptHarness, deferred, flushScript } from './script-harness.js'

const alive: Array<ReturnType<typeof createScriptHarness>> = []
afterEach(() => { for (const harness of alive.splice(0)) harness.destroy(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function props() {
  const format = Object.assign((n: number) => `$${n.toFixed(2)}`, { subscribe: (run: (value: unknown) => void) => { run(format); return () => {} } })
  return { dateRange: writable({ range: 'day' }), selectedDevice: writable(''), selectedTool: writable('codex'),
    displayCurrency: writable('USD'), exchangeRate: writable(0.137), formatCost: format,
    formatTokens: (n: number) => String(n), formatNumber: (n: number) => String(n),
    t: writable((key: string) => key), tokenComposition, createRequestTracker,
    tweened: (value: number) => writable(value), cubicOut: (value: number) => value,
    page: writable({ url: new URL('http://localhost/overview'), params: {} }),
    getAuthShellState, initTheme: () => () => {},
    displayOutputTokens: (data: any) => (data?.outputTokens || 0) + (data?.thinkingTokens || 0),
  }
}
function harness(path: string, supplied: Record<string, unknown>, fields: string) {
  const result = createScriptHarness(new URL(`../src/${path}`, import.meta.url), supplied, fields)
  alive.push(result)
  return result
}

describe('review delivered ToolSelector request lifecycle', () => {
  it('ignores a late error from an older filter and preserves the current selected tool', async () => {
    const first = deferred(), second = deferred()
    const input = props()
    const fetchTools = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const view = harness('lib/components/ToolSelector.svelte', { ...input, fetchTools, setTool: (tool: string) => input.selectedTool.set(tool) }, '{ tools, loading }')
    input.dateRange.set({ range: 'week' }); await tick()
    second.resolve({ tools: [{ tool: 'codex', label: 'Codex' }] }); await flushScript()
    first.reject(new Error('synthetic earlier failure')); await flushScript()
    expect(view.reports.at(-1).tools).toEqual([{ tool: 'codex', label: 'Codex' }])
    let selected = ''; const stop = input.selectedTool.subscribe(value => { selected = value }); stop()
    expect(selected).toBe('codex')
  })
  it('does not clear a persisted selection on the initial request failure', async () => {
    const input = props()
    const setTool = vi.fn()
    harness('lib/components/ToolSelector.svelte', { ...input, setTool, fetchTools: async () => { throw new Error('synthetic unavailable') } }, '{ tools, loading }')
    await flushScript()
    expect(setTool).not.toHaveBeenCalled()
  })
})

describe('review delivered Home/Overview lifecycle', () => {
  function browser() {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  }
  it('honors refreshInterval=0 as manual mode without periodic refresh timers', async () => {
    vi.useFakeTimers(); browser()
    const view = harness('routes/+page.svelte', { ...props(),
      fetchConfig: async () => ({ refreshInterval: 0 }), fetchHomeSummary: async () => ({ totalTokens: 1, totalCost: 0, activeDays: 1 }),
      fetchQuotas: async () => ({ quotas: [] }), triggerRefresh: async () => ({}), SETTINGS_UPDATED_EVENT: 'synthetic-settings',
    }, '{ globalRefreshMs, countdown, loading }')
    await view.mount(); await flushScript(); await vi.advanceTimersByTimeAsync(300)
    expect(view.reports.at(-1).globalRefreshMs).toBe(0)
    expect(vi.getTimerCount()).toBe(1) // The visible clock, not a refresh loop.
  })
  it('does not create barsReady timers from a summary response received after unmount', async () => {
    vi.useFakeTimers(); browser()
    const summary = deferred()
    const view = harness('routes/+page.svelte', { ...props(),
      fetchConfig: async () => ({ refreshInterval: 0 }), fetchHomeSummary: () => summary.promise,
      fetchQuotas: async () => ({ quotas: [] }), triggerRefresh: async () => ({}), SETTINGS_UPDATED_EVENT: 'synthetic-settings',
    }, '{ loading, barsReady }')
    const mounted = view.mount(); await flushScript(); view.destroy()
    summary.resolve({ totalTokens: 1, totalCost: 0, activeDays: 1 }); await mounted; await flushScript()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not issue a new Overview load when its background refresh completes after unmount', async () => {
    const refreshing = deferred()
    const fetchSummary = vi.fn(async () => ({ totalTokens: 1, totalCost: 0 }))
    const view = harness('routes/overview/+page.svelte', { ...props(), fetchSummary, refreshData: () => refreshing.promise }, '{ loading, data }')
    await view.mount(); view.destroy(); refreshing.resolve({}); await flushScript()
    expect(fetchSummary).toHaveBeenCalledTimes(1)
  })
})

describe('review delivered auth shell gating', () => {
  it('keeps auth status failure out of the full shell', async () => {
    const view = harness('routes/+layout.svelte', { ...props(), fetchAuthStatus: async () => { throw new Error('synthetic unavailable') }, fetchConfig: async () => ({}) }, '{ shellState, authLoading }')
    await view.mount(); await flushScript()
    expect(view.reports.at(-1).shellState).not.toBe('shell')
  })
  it('does not fetch protected config before a known authenticated status', async () => {
    const status = deferred()
    const fetchConfig = vi.fn(async () => ({}))
    const view = harness('routes/+layout.svelte', { ...props(), fetchAuthStatus: () => status.promise, fetchConfig }, '{ shellState, authLoading }')
    await view.mount(); await flushScript()
    expect(fetchConfig).not.toHaveBeenCalled()
    status.resolve({ enabled: true, authenticated: false }); await flushScript()
    expect(fetchConfig).not.toHaveBeenCalled()
  })
})
