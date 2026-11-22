import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../src/lib/server/db/pool.js', async () => ({ sql: (await import('../helpers/pglite-sql.js')).sql }))
import { GET as identities } from '../../src/routes/api/me/identities/+server.js'
import { DELETE as unlink } from '../../src/routes/api/me/identities/[provider]/+server.js'
import { load as settingsLoad } from '../../src/routes/settings/+page.server.js'
import { load as adminLoad } from '../../src/routes/admin/+page.server.js'
import { banUser } from '../../src/lib/server/admin/operations.js'
import { bindOAuthIdentity, findOrCreateOAuthUser } from '../../src/lib/server/oauth/providers.js'
import { migrateTestDatabase, query, truncate } from '../helpers/pglite-sql.js'

const owner = { id: 'owner', username: 'owner', email: 'owner@example.test', display_name: 'Owner', avatar_url: null, role: 'user', status: 'active' }
beforeAll(() => migrateTestDatabase(), 15_000)
beforeEach(async () => {
  await truncate('users')
  await query("INSERT INTO users (id, username, email, display_name, role) VALUES ('owner', 'owner', 'owner@example.test', 'Owner', 'user'), ('admin', 'admin', 'admin@example.test', 'Admin', 'admin')")
  await query("INSERT INTO sessions (sid, user_id, expires_at) VALUES ('session-1', 'owner', NOW() + INTERVAL '1 day'), ('admin-session', 'admin', NOW() + INTERVAL '1 day')")
})
function event(provider = 'github', user = owner) {
  return { locals: { user }, cookies: { get: () => 'session-1' }, params: { provider } } as any
}
async function identity(provider: string) {
  await query('INSERT INTO user_identities (id, user_id, provider, provider_user_id) VALUES ($1, $2, $3, $4)',
    [`identity-${provider}`, 'owner', provider, `provider-${provider}`])
}

describe('banned sessions and usable login methods', () => {
  it.each([['GET', identities], ['DELETE', unlink]] as const)('rejects a banned session at identities %s', async (_name, handler) => {
    await identity('github')
    await identity('linux_do')
    await query("UPDATE users SET status = 'banned' WHERE id = 'owner'")
    await expect(handler(event('github', { ...owner, status: 'banned' }))).rejects.toMatchObject({ status: 403 })
  })

  it.each([['settings', settingsLoad], ['admin', adminLoad]] as const)('rejects banned users before loading %s pages', async (_name, load) => {
    await expect(load(event('github', { ...owner, role: 'admin', status: 'banned' }))).rejects.toMatchObject({ status: 403 })
  })

  it('does not unlink the only OAuth identity when a password exists but email is unverified', async () => {
    await identity('github')
    await query("UPDATE users SET password_hash = 'synthetic-hash', email_verified = FALSE WHERE id = 'owner'")
    const response = await unlink(event()) as Response
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'cannot_unlink_last' })
    expect(await query('SELECT provider FROM user_identities')).toEqual([{ provider: 'github' }])
  })

  it('allows the last OAuth identity to be removed when verified password login remains', async () => {
    await identity('github')
    await query("UPDATE users SET password_hash = 'synthetic-hash', email_verified = TRUE WHERE id = 'owner'")
    expect((await unlink(event()) as Response).status).toBe(200)
    expect(await query('SELECT provider FROM user_identities')).toEqual([])
  })

  it('serializes competing unlinks so at least one usable identity remains', async () => {
    await identity('github')
    await identity('linux_do')
    const responses = await Promise.all([unlink(event('github')), unlink(event('linux_do'))]) as Response[]
    expect(responses.map(response => response.status).sort()).toEqual([200, 400])
    expect(await query('SELECT provider FROM user_identities')).toHaveLength(1)
  })

  it('bans the user and removes only that user sessions in one transaction', async () => {
    await query("INSERT INTO sessions (sid, user_id, expires_at) VALUES ('session-2', 'owner', NOW() + INTERVAL '1 day')")
    await banUser('admin', 'owner', 'synthetic reason')
    expect(await query("SELECT status FROM users WHERE id = 'owner'")).toEqual([{ status: 'banned' }])
    expect(await query('SELECT sid FROM sessions')).toEqual([{ sid: 'admin-session' }])
    expect(await query('SELECT action FROM admin_audit_logs')).toEqual([{ action: 'ban_user' }])
  })

  it('checks a ban again under the binding user lock', async () => {
    await query("UPDATE users SET status = 'banned' WHERE id = 'owner'")
    const result = await bindOAuthIdentity('owner', { provider: 'github', providerUserId: 'provider-1',
      username: 'owner', email: null, emailVerified: false, avatarUrl: null, rawProfile: {} })
    expect(result).toEqual({ error: 'user_banned' })
    expect(await query('SELECT id FROM user_identities')).toEqual([])
  })

  it('does not add a merged identity to a banned verified account', async () => {
    await query("UPDATE users SET status = 'banned', email_verified = TRUE WHERE id = 'owner'")
    const account = await findOrCreateOAuthUser({ provider: 'github', providerUserId: 'provider-1',
      username: 'owner', email: 'owner@example.test', emailVerified: true, avatarUrl: null, rawProfile: {} })
    expect(account.status).toBe('banned')
    expect(await query('SELECT id FROM user_identities')).toEqual([])
  })

  it('rolls back the ban when session invalidation fails', async () => {
    await query(`CREATE FUNCTION reject_session_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic session cleanup failure'; END $$`)
    await query('CREATE TRIGGER reject_session_cleanup BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION reject_session_cleanup()')
    try {
      await expect(banUser('admin', 'owner', 'synthetic reason')).rejects.toThrow('synthetic session cleanup failure')
      expect(await query("SELECT status FROM users WHERE id = 'owner'")).toEqual([{ status: 'active' }])
      expect(await query("SELECT sid FROM sessions WHERE user_id = 'owner'")).toEqual([{ sid: 'session-1' }])
    } finally {
      await query('DROP TRIGGER reject_session_cleanup ON sessions')
      await query('DROP FUNCTION reject_session_cleanup()')
    }
  })
})
