import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../src/lib/server/db/pool.js', async () => ({ sql: (await import('../helpers/pglite-sql.js')).sql }))
vi.mock('$env/dynamic/private', () => ({ env: { ADMIN_EMAILS: 'admin@example.test' } }))
import { bindOAuthIdentity, findOrCreateOAuthUser, maybeGrantAdmin, type OAuthProfile } from '../../src/lib/server/oauth/providers.js'
import { migrateTestDatabase, query, truncate } from '../helpers/pglite-sql.js'

beforeAll(() => migrateTestDatabase(), 15_000)
beforeEach(() => truncate('users'))

function profile(overrides: Partial<OAuthProfile> = {}): OAuthProfile {
  return { provider: 'github', providerUserId: 'provider-1', username: 'fixture',
    email: 'admin@example.test', emailVerified: false, avatarUrl: null, rawProfile: {}, ...overrides }
}
async function user(verified: boolean, email = 'admin@example.test') {
  await query(`INSERT INTO users (id, username, email, email_verified, display_name) VALUES ('owner', 'owner', $1, $2, 'Owner')`, [email, verified])
}

describe('OAuth email ownership and one identity per provider', () => {
  it('does not merge an unverified OAuth email into a verified account', async () => {
    await user(true)
    await expect(findOrCreateOAuthUser(profile())).rejects.toThrow()
    expect(await query('SELECT id FROM user_identities')).toEqual([])
    expect(await query('SELECT role FROM users')).toEqual([{ role: 'user' }])
  })

  it('does not merge a verified OAuth email into an unverified account', async () => {
    await user(false)
    await expect(findOrCreateOAuthUser(profile({ emailVerified: true }))).rejects.toThrow()
    expect(await query('SELECT id FROM user_identities')).toEqual([])
    expect(await query('SELECT role FROM users')).toEqual([{ role: 'user' }])
  })

  it('matches email case only when both accounts are verified', async () => {
    await user(true, 'Owner@Example.test')
    const account = await findOrCreateOAuthUser(profile({ email: 'owner@example.test', emailVerified: true }))
    expect(account.id).toBe('owner')
    expect(await query('SELECT user_id FROM user_identities')).toEqual([{ user_id: 'owner' }])
    expect(await query('SELECT id FROM users')).toEqual([{ id: 'owner' }])
  })

  it('rejects ambiguous pre-existing accounts differing only in email case', async () => {
    await user(true)
    await query("INSERT INTO users (id, username, email, email_verified, display_name) VALUES ('other', 'other', 'ADMIN@EXAMPLE.TEST', TRUE, 'Other')")
    await expect(findOrCreateOAuthUser(profile({ emailVerified: true }))).rejects.toThrow('email_ambiguous')
    expect(await query('SELECT id FROM user_identities')).toEqual([])
    expect(await query('SELECT COUNT(*) AS count FROM users')).toEqual([{ count: '2' }])
  })

  it.each([false, true])('only grants admin to a newly created verified account (%s)', async emailVerified => {
    const account = await findOrCreateOAuthUser(profile({ emailVerified }))
    expect(await query('SELECT role FROM users WHERE id = $1', [account.id]))
      .toEqual([{ role: emailVerified ? 'admin' : 'user' }])
  })

  it('does not grant admin when the stored email is unverified', async () => {
    await user(false)
    await maybeGrantAdmin('owner', 'admin@example.test', true)
    expect(await query('SELECT role FROM users')).toEqual([{ role: 'user' }])
  })

  it('does not grant admin without verified provider email ownership', async () => {
    await user(true)
    await maybeGrantAdmin('owner', 'admin@example.test', false)
    expect(await query('SELECT role FROM users')).toEqual([{ role: 'user' }])
  })

  it.each(['provider-1', 'provider-2'])('rejects repeated binding of the same provider (%s)', async providerUserId => {
    await user(true)
    expect(await bindOAuthIdentity('owner', profile())).toEqual({})
    const result = await bindOAuthIdentity('owner', profile({ providerUserId }))
    expect(result.error).toBeTruthy()
    expect(await query('SELECT provider_user_id FROM user_identities')).toEqual([{ provider_user_id: 'provider-1' }])
  })

  it('cannot bypass the provider uniqueness rule through verified email merging', async () => {
    await user(true)
    await bindOAuthIdentity('owner', profile())
    await expect(findOrCreateOAuthUser(profile({ providerUserId: 'provider-2', emailVerified: true }))).rejects.toThrow()
    expect(await query('SELECT provider_user_id FROM user_identities')).toEqual([{ provider_user_id: 'provider-1' }])
  })
})
