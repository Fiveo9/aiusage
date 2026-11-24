import { afterEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.restoreAllMocks() })

describe('review responsive currency and safe persisted values', () => {
  it('publishes a reactive formatter when currency or rate changes', async () => {
    const stores = await import('../src/lib/stores.js')
    expect(typeof (stores.formatCost as any).subscribe).toBe('function')
    const values: string[] = []
    const stop = (stores.formatCost as any).subscribe((format: (n: number) => string) => values.push(format(1)))
    try {
      stores.displayCurrency.set('CNY')
      stores.exchangeRate.set(0.5)
      expect(values.at(-1)).toBe('¥2.00')
      stores.exchangeRate.set(0.25)
      expect(values.at(-1)).toBe('¥4.00')
    } finally { stop() }
  })
  it.each([0, -1, NaN, Infinity])('keeps costs finite when the stored CNY rate is invalid %j', async rate => {
    const stores = await import('../src/lib/stores.js')
    stores.displayCurrency.set('CNY'); stores.exchangeRate.set(rate)
    const format = typeof stores.formatCost === 'function' ? stores.formatCost : get(stores.formatCost)
    expect(format(1)).not.toMatch(/Infinity|NaN/)
  })
  it('uses absolute magnitude for negative-value precision and rejects a nonfinite amount', async () => {
    const stores = await import('../src/lib/stores.js')
    const format = typeof stores.formatCost === 'function' ? stores.formatCost : get(stores.formatCost)
    expect(format(-2)).toBe('$-2.00')
    expect(format(NaN)).toBe('—')
  })
  it.each([
    ['aiusage-modelDisplayMode', 'null', 'modelDisplayMode', 'full'],
    ['aiusage-selectedDevice', '123', 'selectedDevice', ''],
    ['aiusage-selectedTool', '{}', 'selectedTool', ''],
    ['aiusage-dateRange', '[]', 'dateRange', { range: 'day' }],
  ])('falls back on an unexpected stored type for %s', async (key, value, store, expected) => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', { getItem: (requested: string) => requested === key ? value : null, setItem: vi.fn() })
    const stores = await import('../src/lib/stores.js')
    expect(get((stores as any)[store as string])).toEqual(expected)
  })
  it('preserves a valid custom date range', async () => {
    const range = { from: '2026-01-01', to: '2026-01-31', month: '2026-01' }
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'aiusage-dateRange' ? JSON.stringify(range) : null, setItem: vi.fn() })
    const { dateRange } = await import('../src/lib/stores.js')
    expect(get(dateRange)).toEqual(range)
  })
})

describe('review blocked storage and theme subscription ownership', () => {
  function browser(blockReads: boolean) {
    const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    vi.stubGlobal('window', { matchMedia: () => media })
    vi.stubGlobal('document', { documentElement: { setAttribute: vi.fn() } })
    vi.stubGlobal('localStorage', { getItem: () => { if (blockReads) throw new DOMException('blocked', 'SecurityError'); return null },
      setItem: () => { throw new DOMException('blocked', 'SecurityError') } })
    return media
  }
  it('loads and toggles theme and language even when storage is blocked', async () => {
    browser(true)
    const theme = await import('../src/lib/theme.js')
    const locale = await import('../src/lib/i18n.js')
    const cleanup = theme.initTheme()
    try {
      expect(() => theme.cycleTheme()).not.toThrow()
      expect(() => locale.toggleLang()).not.toThrow()
      expect(get(locale.lang)).toBe('zh')
    } finally { cleanup?.() }
  })
  it('unsubscribes both theme listeners on cleanup', async () => {
    const media = browser(false)
    const theme = await import('../src/lib/theme.js')
    const cleanup = theme.initTheme()
    expect(typeof cleanup).toBe('function')
    cleanup!()
    const apply = vi.mocked(document.documentElement.setAttribute)
    const before = apply.mock.calls.length
    theme.userPref.set('dark')
    expect(apply.mock.calls.length).toBe(before)
    expect(media.removeEventListener).toHaveBeenCalledWith('change', media.addEventListener.mock.calls[0][1])
  })
})

describe('review API per-caller isolation and response parsing', () => {
  it('does not join custom-signal requests, so one abort cannot cancel another caller', async () => {
    const api = await import('../src/lib/api.js')
    const pending: Array<{ resolve: (value: unknown) => void }> = []
    const fetcher = vi.fn((_url, options) => new Promise((resolve, reject) => {
      pending.push({ resolve })
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }))
    vi.stubGlobal('fetch', fetcher)
    const first = new AbortController(), second = new AbortController()
    const a = api.fetchSummary({ range: 'day' }, { signal: first.signal }).catch(error => error)
    const b = api.fetchSummary({ range: 'day' }, { signal: second.signal }).catch(error => error)
    try {
      expect(fetcher).toHaveBeenCalledTimes(2)
      first.abort(new Error('synthetic abort'))
      pending[1].resolve({ ok: true, json: async () => ({ totalTokens: 7 }) })
      expect(await b).toEqual({ totalTokens: 7 })
      expect(await a).toBeInstanceOf(Error)
    } finally { first.abort(); second.abort(); for (const slot of pending) slot.resolve({ ok: true, json: async () => ({}) }); await Promise.all([a, b]) }
  })
  it('does not deduplicate POST refresh requests', async () => {
    const api = await import('../src/lib/api.js')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })))
    await Promise.all([api.refreshData(), api.refreshData()])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('contains asynchronous cloud-status JSON failures across both attempts', async () => {
    const api = await import('../src/lib/api.js')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { throw new Error('synthetic malformed JSON') } })))
    await expect(api.fetchCloudSyncStatus('https://synthetic.invalid')).resolves.toEqual({ enabled: false })
  })
  it('turns malformed GitHub JSON into a controlled connection error', async () => {
    const api = await import('../src/lib/api.js')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { throw new Error('synthetic malformed JSON') } })))
    await expect(api.githubConnection('start')).rejects.toThrow('GitHub connection failed')
  })
})
