import { afterEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('model display preference', () => {
  it('defaults to full names when rendering without a browser', async () => {
    const { modelDisplayMode } = await import('../src/lib/stores.js')
    expect(get(modelDisplayMode)).toBe('full')
  })

  it('remembers either choice after reloading the shared store', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    })
    let stores = await import('../src/lib/stores.js')
    expect(get(stores.modelDisplayMode)).toBe('full')
    stores.modelDisplayMode.set('merged')
    expect(values.get('aiusage-modelDisplayMode')).toBe('"merged"')
    vi.resetModules()
    stores = await import('../src/lib/stores.js')
    expect(get(stores.modelDisplayMode)).toBe('merged')
    stores.modelDisplayMode.set('full')
    vi.resetModules()
    stores = await import('../src/lib/stores.js')
    expect(get(stores.modelDisplayMode)).toBe('full')
  })

  it('still allows switching if browser storage is unavailable', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('Storage blocked') },
      setItem: () => { throw new Error('Storage blocked') },
    })
    const { modelDisplayMode } = await import('../src/lib/stores.js')
    expect(get(modelDisplayMode)).toBe('full')
    expect(() => modelDisplayMode.set('merged')).not.toThrow()
    expect(get(modelDisplayMode)).toBe('merged')
  })
})
