import { expect, it, vi } from 'vitest'

vi.mock('../../src/lib/server/db/pool.js', async () => ({ sql: (await import('../helpers/pglite-sql.js')).sql }))
vi.mock('../../src/lib/server/pricing/curated-prices.js', () => ({ ensureCuratedPrices: async () => 0 }))
vi.mock('../../src/lib/server/pricing/curated-aliases.js', () => ({ ensureCuratedPricingAliases: async () => ({ added: 0, updated: 0 }) }))

import { runMigrations } from '../../src/lib/server/db/schema.js'
import { query } from '../helpers/pglite-sql.js'

it('preserves both existing bans and the separate per-user enable preference during v23 upgrade', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await runMigrations()
    // Recreate the v22 column/version boundary in this isolated database only.
    await query('ALTER TABLE users RENAME COLUMN cloud_sync_banned TO cloud_sync_enabled')
    await query('DELETE FROM schema_migrations WHERE version = 23')
    await query(`INSERT INTO users (id, username, email, display_name, cloud_sync_enabled) VALUES
      ('f21-banned', 'f21-banned', 'banned@example.test', 'Banned fixture', TRUE),
      ('f21-allowed', 'f21-allowed', 'allowed@example.test', 'Allowed fixture', FALSE)`)
    await query(`INSERT INTO user_sync_settings (user_id, cloud_sync_enabled) VALUES
      ('f21-banned', TRUE), ('f21-allowed', FALSE)`)

    await runMigrations()
    expect(await query('SELECT id, cloud_sync_banned FROM users ORDER BY id')).toEqual([
      { id: 'f21-allowed', cloud_sync_banned: false }, { id: 'f21-banned', cloud_sync_banned: true },
    ])
    expect(await query('SELECT user_id, cloud_sync_enabled FROM user_sync_settings ORDER BY user_id')).toEqual([
      { user_id: 'f21-allowed', cloud_sync_enabled: false }, { user_id: 'f21-banned', cloud_sync_enabled: true },
    ])
    expect(await query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'cloud_sync_enabled'"))
      .toEqual([])
    const versions = await query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
    expect(versions).toHaveLength(22)
    expect(versions.at(-1)?.version).toBe(23)
    await runMigrations()
    expect(await query('SELECT version FROM schema_migrations ORDER BY version')).toEqual(versions)
  } finally {
    log.mockRestore()
  }
}, 15000)
