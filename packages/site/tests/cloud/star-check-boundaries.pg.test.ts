import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../src/lib/server/db/pool.js', async () => ({ sql: (await import('../helpers/pglite-sql.js')).sql }))
vi.mock('$env/dynamic/private', () => ({ env: { SITE_URL: 'https://service.invalid///' } }))
import { checkCloudSyncAccess } from '../../src/lib/server/cloud/star-check.js'
import { findOrCreateOAuthUser } from '../../src/lib/server/oauth/providers.js'
import { DELETE as unlink } from '../../src/routes/api/me/identities/[provider]/+server.js'
import { invalidateConfigCache } from '../../src/lib/server/config.js'
import { migrateTestDatabase, query, truncate } from '../helpers/pglite-sql.js'

const user = { id: 'owner', username: 'owner', email: 'owner@example.test', display_name: 'Owner', avatar_url: null, role: 'user', status: 'active' }
beforeAll(() => migrateTestDatabase(), 15_000)
beforeEach(async () => {
  invalidateConfigCache()
  await truncate('users')
  await query("INSERT INTO users (id,username,email,email_verified,password_hash,display_name) VALUES ('owner','owner','owner@example.test',TRUE,'synthetic','Owner')")
  await query("INSERT INTO user_identities (id,user_id,provider,provider_user_id,access_token) VALUES ('identity','owner','github','synthetic-provider','synthetic-test-only')")
  vi.stubGlobal('fetch', vi.fn())
})

describe('star check failure boundaries', () => {
  it.each([401, 500, 429])('does not cache GitHub HTTP %s as a star result', async status => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status }))
    const result = await checkCloudSyncAccess('owner')
    expect(result.error_code).toBe(status === 401 ? 'GITHUB_BINDING_REQUIRED' : 'GITHUB_UNAVAILABLE')
    expect((await query("SELECT github_star_checked_at FROM users WHERE id='owner'"))[0].github_star_checked_at).toBeNull()
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })
  it('treats only an explicit 404 as not starred', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }))
    expect((await checkCloudSyncAccess('owner')).error_code).toBe('STAR_REQUIRED')
    expect((await query("SELECT github_star_checked_at FROM users WHERE id='owner'"))[0].github_star_checked_at).not.toBeNull()
  })
  it('uses the configured site URL for binding instructions', async () => {
    await query("UPDATE user_identities SET access_token=NULL WHERE user_id='owner'")
    expect((await checkCloudSyncAccess('owner')).url).toBe('https://service.invalid/settings')
  })
  it('does not accept a future-dated positive cache', async () => {
    await query("UPDATE users SET github_starred=TRUE, github_star_checked_at=NOW()+INTERVAL '1 day' WHERE id='owner'")
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }))
    expect((await checkCloudSyncAccess('owner')).error_code).toBe('GITHUB_UNAVAILABLE')
  })
  it('does not apply an in-flight result after the GitHub identity changes', async () => {
    vi.mocked(fetch).mockImplementation(async () => {
      await query("UPDATE user_identities SET access_token='synthetic-replacement-test-only' WHERE id='identity'")
      return new Response(null, { status: 204 })
    })
    expect((await checkCloudSyncAccess('owner')).error_code).toBe('GITHUB_BINDING_REQUIRED')
    expect((await query("SELECT github_star_checked_at FROM users WHERE id='owner'"))[0].github_star_checked_at).toBeNull()
  })
  it('clears a previously positive cache when a GitHub identity is unlinked', async () => {
    await query("UPDATE users SET github_starred=TRUE, github_star_checked_at=NOW() WHERE id='owner'")
    await unlink({ locals: { user }, params: { provider: 'github' } } as any)
    expect((await query("SELECT github_starred,github_star_checked_at FROM users WHERE id='owner'"))[0]).toEqual({ github_starred: false, github_star_checked_at: null })
  })
  it('clears a previously positive cache when GitHub credentials are refreshed', async () => {
    await query("UPDATE users SET github_starred=TRUE, github_star_checked_at=NOW() WHERE id='owner'")
    await findOrCreateOAuthUser({ provider: 'github', providerUserId: 'synthetic-provider', username: 'owner', email: null, emailVerified: false, avatarUrl: null, rawProfile: {} }, 'synthetic-new-test-only')
    expect((await query("SELECT github_starred,github_star_checked_at FROM users WHERE id='owner'"))[0]).toEqual({ github_starred: false, github_star_checked_at: null })
  })
})
