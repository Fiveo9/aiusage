import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../src/lib/server/db/pool.js', async () => ({ sql: (await import('../helpers/pglite-sql.js')).sql }))
import { consumeOAuthState, MAX_OAUTH_STATES, saveOAuthState } from '../../src/lib/server/oauth/state-store.js'
import { runMigrations } from '../../src/lib/server/db/schema.js'
import { migrateTestDatabase, query, truncate } from '../helpers/pglite-sql.js'

beforeAll(() => migrateTestDatabase(), 15_000)
beforeEach(() => truncate('users', 'oauth_states'))

describe('browser-bound database OAuth states', () => {
  it('stores hashes, uses the configured TTL, and permits one successful consume', async () => {
    const age = await saveOAuthState('state-1', 'browser-1', { provider: 'github', mode: 'login' })
    const rows = await query<{ state_hash: string; browser_nonce_hash: string; seconds: string }>(
      'SELECT state_hash, browser_nonce_hash, EXTRACT(EPOCH FROM (expires_at - NOW())) AS seconds FROM oauth_states')
    expect(rows[0].state_hash).toHaveLength(64)
    expect(rows[0].browser_nonce_hash).toHaveLength(64)
    expect(Number(rows[0].seconds)).toBeCloseTo(age, 0)
    expect(age).toBe(600)
    expect(await consumeOAuthState('state-1', undefined, 'github')).toBeNull()
    expect(await consumeOAuthState('state-1', 'other-browser', 'github')).toBeNull()
    expect(await consumeOAuthState('state-1', 'browser-1', 'linux_do')).toBeNull()
    expect(await consumeOAuthState('state-1', 'browser-1', 'github')).toEqual({ provider: 'github', mode: 'login' })
    expect(await consumeOAuthState('state-1', 'browser-1', 'github')).toBeNull()
  })

  it('requires the original live binding session and retains the state after mismatches', async () => {
    await query("INSERT INTO users (id, username, email, display_name) VALUES ('owner', 'owner', 'owner@example.test', 'Owner')")
    await saveOAuthState('bind-state', 'browser-1', { provider: 'github', mode: 'bind', userId: 'owner', sessionId: 'session-1' })
    const rows = await query<{ session_id_hash: string }>('SELECT session_id_hash FROM oauth_states')
    expect(rows[0].session_id_hash).toHaveLength(64)
    expect(await consumeOAuthState('bind-state', 'browser-1', 'github')).toBeNull()
    expect(await consumeOAuthState('bind-state', 'browser-1', 'github', 'session-2')).toBeNull()
    expect(await consumeOAuthState('bind-state', 'browser-1', 'github', 'session-1'))
      .toEqual({ provider: 'github', mode: 'bind', userId: 'owner' })
  })

  it('rejects expired states and prunes them when issuing a new state', async () => {
    await saveOAuthState('expired', 'browser-1', { provider: 'github', mode: 'login' })
    await query("UPDATE oauth_states SET expires_at = NOW() - INTERVAL '1 second'")
    expect(await consumeOAuthState('expired', 'browser-1', 'github')).toBeNull()
    await saveOAuthState('fresh', 'browser-1', { provider: 'github', mode: 'login' })
    expect(await query('SELECT COUNT(*) AS count FROM oauth_states')).toEqual([{ count: '1' }])
  })

  it('consumes a state atomically under concurrent callbacks', async () => {
    await saveOAuthState('once', 'browser-1', { provider: 'github', mode: 'login' })
    const values = await Promise.all([
      consumeOAuthState('once', 'browser-1', 'github'), consumeOAuthState('once', 'browser-1', 'github'),
    ])
    expect(values.filter(Boolean)).toHaveLength(1)
  })

  it('enforces the capacity atomically when two issuers compete for the last slot', async () => {
    await query(`INSERT INTO oauth_states (state_hash, browser_nonce_hash, provider, mode, expires_at)
      SELECT md5(n::text) || md5(n::text), md5(n::text), 'github', 'login', NOW() + INTERVAL '1 hour'
      FROM generate_series(1, $1::integer) AS n`, [MAX_OAUTH_STATES - 1])
    const results = await Promise.allSettled([
      saveOAuthState('last-1', 'browser-1', { provider: 'github', mode: 'login' }),
      saveOAuthState('last-2', 'browser-2', { provider: 'github', mode: 'login' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await query('SELECT COUNT(*) AS count FROM oauth_states')).toEqual([{ count: String(MAX_OAUTH_STATES) }])
  })

  it('migration v19 enforces one identity per user and provider at the database boundary', async () => {
    await query("INSERT INTO users (id, username, email, display_name) VALUES ('owner', 'owner', 'owner@example.test', 'Owner')")
    await query("INSERT INTO user_identities (id, user_id, provider, provider_user_id) VALUES ('identity-1', 'owner', 'github', 'provider-1')")
    await expect(query("INSERT INTO user_identities (id, user_id, provider, provider_user_id) VALUES ('identity-2', 'owner', 'github', 'provider-2')"))
      .rejects.toMatchObject({ code: '23505' })
    expect(await query('SELECT version FROM schema_migrations WHERE version = 19')).toEqual([{ version: 19 }])
  })

  it('refuses a legacy duplicate migration without deleting or merging identities', async () => {
    await query('ALTER TABLE user_identities DROP CONSTRAINT user_identities_user_provider_key')
    await query('DROP TABLE oauth_states')
    await query('DELETE FROM schema_migrations WHERE version = 19')
    await query("INSERT INTO users (id, username, email, display_name) VALUES ('owner', 'owner', 'owner@example.test', 'Owner')")
    await query("INSERT INTO user_identities (id, user_id, provider, provider_user_id) VALUES ('identity-1', 'owner', 'github', 'provider-1'), ('identity-2', 'owner', 'github', 'provider-2')")
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await expect(runMigrations()).rejects.toThrow('Duplicate OAuth providers must be resolved')
      expect(await query('SELECT id FROM user_identities ORDER BY id')).toEqual([{ id: 'identity-1' }, { id: 'identity-2' }])
      expect(await query('SELECT version FROM schema_migrations WHERE version = 19')).toEqual([])
    } finally { log.mockRestore() }
  })
})
