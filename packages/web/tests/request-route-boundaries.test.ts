import { afterEach, describe, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import { writable } from 'svelte/store'
import { createRequestTracker } from '../src/lib/sessions-paging.js'
import { createScriptHarness, deferred, flushScript } from './script-harness.js'

const views: Array<ReturnType<typeof createScriptHarness>> = []
afterEach(() => { for (const view of views.splice(0)) view.destroy(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function base() {
  const format = Object.assign((value: number) => String(value), { subscribe: (run: (value: unknown) => void) => { run(format); return () => {} } })
  return { dateRange: writable({ range: 'day' }), selectedDevice: writable(''), selectedTool: writable('codex'),
    modelDisplayMode: writable('full'), formatTokens: (value: number) => String(value), formatNumber: (value: number) => String(value),
    formatCost: format, groupModels: (values: unknown[]) => values, t: writable((key: string) => `en:${key}`), lang: writable('en'),
    createRequestTracker, fetchQuotas: async () => ({ quotas: [] }),
    page: writable({ params: { sessionId: 'first' }, url: new URL('http://localhost/sessions/first?device=a&tool=codex') }),
    tick,
  }
}
function view(path: string, props: Record<string, unknown>, fields: string | ((source: string) => string), setup = '') {
  const result = createScriptHarness(new URL(`../src/${path}`, import.meta.url), props, fields, setup)
  views.push(result)
  return result
}
function extraArgs(source: string, name: string) {
  const markup = source.slice(source.indexOf('</script>') + '</script>'.length)
  const call = markup.match(new RegExp(`${name}\\(([^)]*)\\)`))
  if (!call) throw new Error(`Delivered call ${name} is missing`)
  const rest = call[1].split(',').slice(1).join(',').trim()
  return rest ? `, ${rest}` : ''
}

describe('review delivered filter request isolation', () => {
  it.each([
    ['tokens', 'fetchTokens'], ['models', 'fetchModels'], ['projects', 'fetchProjects'], ['tool-calls', 'fetchToolCalls'],
  ])('keeps the latest %s response when an older request fails later', async (route, fetchName) => {
    const first = deferred(), second = deferred()
    const input = base()
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const rendered = view(`routes/${route}/+page.svelte`, { ...input, [fetchName]: fetcher }, '{ data, error, loading }')
    input.dateRange.set({ range: 'week' }); await tick()
    const newest = { marker: 'latest', data: [], models: [], projects: [] }
    second.resolve(newest); await flushScript()
    first.reject(new Error('synthetic stale failure')); await flushScript()
    expect(rendered.reports.at(-1)).toMatchObject({ data: newest, error: null, loading: false })
  })
})

describe('review session detail navigation', () => {
  it.each([true, false])('reloads on an in-place route/query change (new session=%s)', async changeId => {
    const first = deferred(), second = deferred()
    const input = base()
    const fetchSessionDetail = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const rendered = view('routes/sessions/[sessionId]/+page.svelte', { ...input, fetchSessionDetail }, '{ data, error, loading }')
    const mounted = rendered.mount().catch(error => error)
    try {
      await flushScript()
      const nextId = changeId ? 'second' : 'first'
      input.page.set({ params: { sessionId: nextId }, url: new URL(`http://localhost/sessions/${nextId}?device=b&tool=claude-code`) })
      await flushScript()
      expect(fetchSessionDetail).toHaveBeenCalledTimes(2)
      expect(fetchSessionDetail).toHaveBeenLastCalledWith(nextId, { device: 'b', tool: 'claude-code' })
      second.resolve({ marker: 'newest', session: {}, records: [] }); await flushScript()
      first.resolve({ marker: 'older', session: {}, records: [] }); await mounted; await flushScript()
      expect(rendered.reports.at(-1).data.marker).toBe('newest')
    } finally {
      first.resolve({ session: {}, records: [] }); second.resolve({ session: {}, records: [] }); await mounted
    }
  })
})

describe('review delivered IME and selector boundaries', () => {
  it.each([{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }])('does not execute a palette command while composing %j', async composition => {
    const goto = vi.fn()
    const rendered = view('lib/components/ui/CommandPalette.svelte', { ...base(), open: true, goto }, '{ handleWindowKeydown }')
    await rendered.reports.at(-1).handleWindowKeydown({ ...composition, key: 'Enter', preventDefault: vi.fn() })
    expect(goto).not.toHaveBeenCalled()
  })
  it('still executes an explicit non-composing Enter', async () => {
    const goto = vi.fn()
    const rendered = view('lib/components/ui/CommandPalette.svelte', { ...base(), open: true, goto }, '{ handleWindowKeydown }')
    await rendered.reports.at(-1).handleWindowKeydown({ key: 'Enter', keyCode: 13, isComposing: false, preventDefault: vi.fn() })
    expect(goto).toHaveBeenCalledWith('/')
  })
  it('does not accept a device list from an unsuccessful response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ devices: [{ deviceInstanceId: 'untrusted-fixture' }] }) })))
    const rendered = view('lib/components/DeviceSelector.svelte', { ...base(), setDevice: vi.fn() }, '{ devices, loading }')
    await rendered.mount(); await flushScript()
    expect(rendered.reports.at(-1).devices).toEqual([])
  })
  it('does not publish a reversed custom date range', () => {
    const setCustomRange = vi.fn()
    const rendered = view('lib/components/DateRangeSelector.svelte', { ...base(), setCustomRange, setRange: vi.fn() }, '{ handleCustomRange }',
      'customFrom = "2026-01-03"; customTo = "2026-01-02";')
    rendered.reports.at(-1).handleCustomRange()
    expect(setCustomRange).not.toHaveBeenCalled()
  })
  it('contains an invalid quota reset date instead of displaying NaN', () => {
    const rendered = view('routes/quotas/+page.svelte', base(), '{ value: countdownStr("not-a-date") }')
    expect(rendered.reports.at(-1).value).toBeNull()
  })
})

describe('review template translation dependencies', () => {
  it('updates tool type labels when language changes', async () => {
    const input = base()
    const rendered = view('routes/tool-calls/+page.svelte', { ...input, fetchToolCalls: async () => ({}) }, source => {
      const markup = source.slice(source.indexOf('</script>') + 9)
      const args = markup.match(/type\.label\(([^)]*)\)/)![1]
      return `{ label: TYPES[0].label(${args}) }`
    })
    input.t.set((key: string) => `zh:${key}`); await flushScript()
    expect(rendered.reports.at(-1).label).toBe('zh:toolCalls.typeAll')
  })
  it('updates the session gap label through its actual template call', async () => {
    const input = base()
    const rendered = view('routes/sessions/[sessionId]/+page.svelte', { ...input, fetchSessionDetail: async () => ({}) },
      source => `{ label: formatGap(1000${extraArgs(source, 'formatGap')}) }`)
    input.t.set((key: string) => `zh:${key}`); await flushScript()
    expect(rendered.reports.at(-1).label).toContain('zh:sessions.detail.gap')
  })
  it('updates quota tier/tool/never labels through the delivered template calls', async () => {
    const input = base()
    const rendered = view('routes/quotas/+page.svelte', input, source => `{
      tier: tierLabel("five_hour"${extraArgs(source, 'tierLabel')}),
      tool: toolLabel("codex"${extraArgs(source, 'toolLabel')}),
      time: formatQueryTime(null${extraArgs(source, 'formatQueryTime')})
    }`)
    input.t.set((key: string) => `zh:${key}`); await flushScript()
    expect(rendered.reports.at(-1)).toEqual({ tier: 'zh:quotas.fiveHour', tool: 'zh:quotas.toolLabels.codex', time: 'zh:quotas.never' })
  })
})
