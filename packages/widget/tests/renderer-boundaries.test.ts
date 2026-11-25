import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import { t } from '../src/i18n'
import { getDefaultSettings } from '../src/settings'
import * as currency from '../src/currency'
import { renderer, flushRenderer } from './renderer-harness'

const views: ReturnType<typeof renderer>[] = []
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }) })
afterEach(() => { for (const view of views.splice(0)) view.destroy(); vi.useRealTimers(); vi.unstubAllGlobals() })
function view(name: string, props: Record<string, unknown>, fields: string) {
  const result = renderer(new URL(`../src/renderer/${name}.svelte`, import.meta.url), { ...currency, t, tick, ...props }, fields)
  views.push(result); return result
}
function widget(extra = {}) {
  return { getData: vi.fn(async () => ({ todayTokens: { total: 1 }, rangeTokens: { total: 1 }, rangeDays: 7, lastUpdated: 1 })),
    getSettings: vi.fn(async () => getDefaultSettings()), getExchangeRate: vi.fn(async () => ({ rate: 7, fetchedAt: Date.now() })),
    saveSettings: vi.fn(async (value: unknown) => value), resizeWindow() {},
    onDataUpdate: vi.fn(() => () => {}), onInstallStatus: vi.fn(() => () => {}), onSetupStatus: vi.fn(() => () => {}), ...extra }
}
it('resets loading on a failed renderer refresh', async () => {
  vi.stubGlobal('window', { widget: widget({ getData: async () => { throw Error('synthetic unavailable') } }) })
  const rendered = view('App', {}, '{ refresh, loading }')
  await rendered.reports.at(-1).refresh().catch(() => {})
  await flushRenderer(); expect(rendered.reports.at(-1).loading).toBe(false)
})
it('re-fetches missing/stale CNY rates and refreshes the synced-time translation', async () => {
  const api = widget({ getExchangeRate: vi.fn(async () => ({ rate: 7, fetchedAt: Date.now() - 7 * 3600000 })) })
  vi.stubGlobal('window', { widget: api })
  const rendered = view('App', {}, '{ saveSettings, updatedStr }')
  await rendered.mount(); await flushRenderer()
  await rendered.reports.at(-1).saveSettings({ detail: { ...getDefaultSettings(), currency: 'CNY', locale: 'zh' } })
  await flushRenderer()
  expect(api.getExchangeRate.mock.calls.length).toBeGreaterThan(1)
  expect(rendered.reports.at(-1).updatedStr).toContain('同步于')
})
it('cleans status timers and owned preload subscriptions on unmount', async () => {
  const api = widget(), cleanup = vi.fn()
  api.onInstallStatus = vi.fn(() => cleanup)
  vi.stubGlobal('window', { widget: api })
  const rendered = view('App', {}, '{ loading }'); await rendered.mount(); await flushRenderer()
  ;(api.onInstallStatus.mock.calls[0][0] as any)({ phase: 'done' })
  rendered.destroy()
  expect(vi.getTimerCount()).toBe(0)
  expect(cleanup).toHaveBeenCalledOnce()
})
it('updates the settings draft when external confirmed settings change', async () => {
  const rendered = view('components/SettingsPanel', { settings: getDefaultSettings(), currencies: currency.currencies,
    createEventDispatcher: () => () => {} }, '{ local }')
  rendered.component.$set({ settings: { ...getDefaultSettings(), rangeDays: 7, currency: 'CNY' } })
  await flushRenderer(); expect(rendered.reports.at(-1).local).toMatchObject({ rangeDays: 7, currency: 'CNY' })
})
it('does not create an empty-chart hover index', () => {
  const rendered = view('components/ActivityChart', { data: [] }, '{ handleMouseMove, hoveredIndex }')
  rendered.reports.at(-1).handleMouseMove({ clientX: 3, currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 100 }) } })
  expect(rendered.component).toBeDefined()
  return flushRenderer().then(() => expect(rendered.reports.at(-1).hoveredIndex).toBeNull())
})
it('does not draw a fake zero cost line while a CNY conversion is unavailable', () => {
  const rendered = view('components/ActivityChart', { data: [{ date: '2026-01-01', tokens: 1, cost: 1 },
    { date: '2026-01-02', tokens: 2, cost: 2 }], showCost: true, currency: 'CNY', exchangeRate: null }, '{ costLinePath }')
  expect(rendered.reports.at(-1).costLinePath).toBe('')
})
it('localizes the actual token breakdown segments', () => {
  const rendered = view('components/TokenBreakdown', { input: 1, locale: 'zh' }, '{ segments }')
  expect(rendered.reports.at(-1).segments[0].label).toBe('输入')
})
