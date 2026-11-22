import { expect, it, vi } from 'vitest'

const startup = vi.hoisted(() => ({ fail: true }))
vi.mock('../../src/lib/server/db/pool.js', async () => ({ sql: (await import('../helpers/pglite-sql.js')).sql }))
vi.mock('../../src/lib/server/pricing/curated-prices.js', () => ({
  ensureCuratedPrices: async () => {
    if (startup.fail) throw new Error('synthetic startup failure after migrations')
    return 0
  },
}))
vi.mock('../../src/lib/server/pricing/curated-aliases.js', () => ({
  ensureCuratedPricingAliases: async () => ({ added: 0, updated: 0 }),
}))

import { runMigrations } from '../../src/lib/server/db/schema.js'
import { query } from '../helpers/pglite-sql.js'

it('rolls back schema and migration versions together, then permits a successful retry', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await expect(runMigrations()).rejects.toThrow('synthetic startup failure after migrations')
    expect(await query("SELECT to_regclass('schema_migrations') AS versions, to_regclass('users') AS users"))
      .toEqual([{ versions: null, users: null }])

    startup.fail = false
    await runMigrations()
    const versions = await query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
    expect(versions.map(row => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21])
    expect(await query("SELECT column_name FROM information_schema.columns WHERE table_name = 'cloud_usage_records' AND column_name = 'session_title'"))
      .toEqual([{ column_name: 'session_title' }])
    expect(await query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'cloud_sync_batches' AND column_name = 'response_summary'"))
      .toEqual([{ column_name: 'response_summary', data_type: 'text' }])

    await runMigrations()
    expect(await query('SELECT version FROM schema_migrations ORDER BY version')).toEqual(versions)
  } finally {
    log.mockRestore()
  }
}, 15000)
