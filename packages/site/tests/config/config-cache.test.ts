import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A small stand-in for the postgres.js client. `site_config` is the `rows`
// map; a test can hold a SELECT back with `holdNextSelect` to interleave it
// with a write, or make every statement fail with `failing`.
const db = vi.hoisted(() => {
  const state = {
    rows: new Map<string, number>(),
    selects: [] as string[],
    failing: false,
    held: null as null | { release: () => void },
    holdNext: false,
  }
  function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const text = strings.join('?').replace(/\s+/g, ' ').trim()
    if (state.failing) return Promise.reject(new Error('connection refused'))
    if (text.startsWith('SELECT value FROM site_config WHERE key = ?')) {
      const key = values[0] as string
      state.selects.push(key)
      // The result is fixed when the statement runs, as it is in the database.
      const result = state.rows.has(key) ? [{ value: state.rows.get(key) }] : []
      if (state.holdNext) {
        state.holdNext = false
        return new Promise(resolve => { state.held = { release: () => resolve(result) } })
      }
      return Promise.resolve(result)
    }
    if (text.startsWith('INSERT INTO site_config')) {
      state.rows.set(values[0] as string, values[1] as number)
      return Promise.resolve([])
    }
    throw new Error(`unexpected statement: ${text}`)
  }
  return { state, sql }
})

vi.mock('../../src/lib/server/db/pool.js', () => ({ sql: db.sql }))

import { CFG, getConfigSync, getConfigValue, getDefaultValue, invalidateConfigCache, setConfig } from '../../src/lib/server/config.js'

const KEY = CFG.UPLOAD_RATE_LIMIT
const DEFAULT = getDefaultValue(KEY)

beforeEach(() => {
  db.state.rows.clear()
  db.state.selects.length = 0
  db.state.failing = false
  db.state.held = null
  db.state.holdNext = false
  invalidateConfigCache()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('site config cache', () => {
  it('queries once for a key that has no row, then answers with the default from the cache', async () => {
    expect(DEFAULT).toBe(30)

    expect(await getConfigValue(KEY)).toBe(DEFAULT)
    expect(await getConfigValue(KEY)).toBe(DEFAULT)
    expect(await getConfigValue(KEY)).toBe(DEFAULT)

    expect(db.state.selects).toEqual([KEY])
  })

  it('queries once for a key that has a row', async () => {
    db.state.rows.set(KEY, 7)

    expect(await getConfigValue(KEY)).toBe(7)
    expect(await getConfigValue(KEY)).toBe(7)

    expect(db.state.selects).toEqual([KEY])
  })

  it('keeps a stored zero apart from a missing row', async () => {
    db.state.rows.set(CFG.RISK_RULE_REPEAT, 0)

    expect(await getConfigValue(CFG.RISK_RULE_REPEAT)).toBe(0)
    expect(await getConfigValue(CFG.RISK_RULE_REPEAT)).toBe(0)
    expect(getConfigSync(CFG.RISK_RULE_REPEAT, 1)).toBe(0)
  })

  it('returns a value saved through setConfig at once, also when the missing row was cached', async () => {
    expect(await getConfigValue(KEY)).toBe(DEFAULT)

    await setConfig(KEY, 5, 'description', 'admin_1')

    expect(await getConfigValue(KEY)).toBe(5)
    expect(getConfigSync(KEY, DEFAULT)).toBe(5)
    expect(db.state.selects).toEqual([KEY])
  })

  it('picks up a row written by another server instance once the 60 second TTL has passed', async () => {
    expect(await getConfigValue(KEY)).toBe(DEFAULT)

    // Another instance saves the value: the row changes, this cache does not.
    db.state.rows.set(KEY, 9)

    vi.advanceTimersByTime(59_999)
    expect(await getConfigValue(KEY)).toBe(DEFAULT)
    expect(db.state.selects).toHaveLength(1)

    vi.advanceTimersByTime(1)
    expect(await getConfigValue(KEY)).toBe(9)
    expect(db.state.selects).toHaveLength(2)
  })

  it('gives the caller its default from getConfigSync while a missing row is cached', async () => {
    await getConfigValue(KEY)

    expect(getConfigSync(KEY, 123)).toBe(123)
  })

  it('does not cache anything when the database is unavailable', async () => {
    db.state.failing = true
    expect(await getConfigValue(KEY)).toBe(DEFAULT)

    db.state.failing = false
    db.state.rows.set(KEY, 4)
    expect(await getConfigValue(KEY)).toBe(4)
  })

  it('does not let a read that started before a save overwrite the saved value', async () => {
    // The read runs before the save and finds no row, but its result arrives
    // after the save has finished.
    db.state.holdNext = true
    const staleRead = getConfigValue(KEY)
    await setConfig(KEY, 5, 'description', 'admin_1')
    db.state.held!.release()
    expect(await staleRead).toBe(DEFAULT)

    expect(await getConfigValue(KEY)).toBe(5)
  })

  it('queries again after invalidateConfigCache', async () => {
    await getConfigValue(KEY)
    invalidateConfigCache()
    db.state.rows.set(KEY, 2)

    expect(await getConfigValue(KEY)).toBe(2)
    expect(db.state.selects).toHaveLength(2)
  })
})
