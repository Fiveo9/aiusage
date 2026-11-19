import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ queries: [] as string[], fail: false, begin: vi.fn(), seed: vi.fn() }))
vi.mock('../../src/lib/server/db/pool.js', () => {
  const tx = async (strings: TemplateStringsArray) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim()
    state.queries.push(text)
    if (text.startsWith('SELECT version')) {
      if (state.fail) throw Error('synthetic migration failure')
      return [1,2,3,4,5,6,7,8,9,11,12,13,14,15,16,17].map(version => ({ version }))
    }
    return []
  }
  return { sql: { begin: state.begin.mockImplementation(async (work: any) => work(tx)) } }
})
vi.mock('../../src/lib/server/pricing/curated-prices.js', () => ({ ensureCuratedPrices: state.seed }))
vi.mock('../../src/lib/server/pricing/curated-aliases.js', () => ({ ensureCuratedPricingAliases: state.seed }))
import { runMigrations } from '../../src/lib/server/db/schema.js'

beforeEach(() => { state.queries.length = 0; state.fail = false; vi.clearAllMocks() })

it('locks inside one transaction before creating or reading migration state', async () => {
  await runMigrations()
  expect(state.begin).toHaveBeenCalledTimes(1)
  expect(state.queries[0]).toBe('SELECT pg_advisory_xact_lock(1634304371, 1)')
  expect(state.queries[1]).toMatch(/^CREATE TABLE IF NOT EXISTS schema_migrations/)
  expect(state.queries[2]).toMatch(/^SELECT version/)
  expect(state.seed).toHaveBeenCalledTimes(2)
})

it('propagates failure to the transaction and skips startup defaults', async () => {
  state.fail = true
  await expect(runMigrations()).rejects.toThrow('synthetic migration failure')
  expect(state.seed).not.toHaveBeenCalled()
})
