import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({ sessions: false }))
vi.mock('../../src/lib/server/db/pool.js', async () => {
  const { sql } = await import('../helpers/pglite-sql.js')
  function wrap(tag: any): any {
    const wrapped = (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (faults.sessions && strings.join('').includes('DELETE FROM sessions')) throw new Error('synthetic revoke failure')
      return tag(strings, ...values)
    }
    return Object.assign(wrapped, { begin: (fn: (tx: any) => Promise<unknown>) => tag.begin((tx: any) => fn(wrap(tx))) })
  }
  return { sql: wrap(sql) }
})
vi.mock('$env/dynamic/private', () => ({ env: { IP_HASH_SECRET: 'synthetic-mail-test-only', SITE_URL: 'https://service.invalid/' } }))
vi.mock('../../src/lib/server/auth/password.js', async original => ({
  ...await original<typeof import('../../src/lib/server/auth/password.js')>(),
  hashPassword: vi.fn(async () => 'synthetic-new-hash'), verifyPassword: vi.fn(async () => true),
}))
vi.mock('../../src/lib/server/auth/email-verification.js', async original => ({
  ...await original<typeof import('../../src/lib/server/auth/email-verification.js')>(),
  sendVerificationEmail: vi.fn(async () => {}), sendPasswordResetEmail: vi.fn(async () => {}),
}))

import { GET as devices } from '../../src/routes/api/me/devices/+server.js'
import { GET as verified } from '../../src/routes/api/auth/check-verified/+server.js'
import { load as verificationPage } from '../../src/routes/verify-email/+page.server.js'
import { POST as reset } from '../../src/routes/api/auth/reset-password/+server.js'
import { POST as register } from '../../src/routes/api/auth/register/+server.js'
import { POST as resend } from '../../src/routes/api/auth/resend-verification/+server.js'
import { POST as forgot } from '../../src/routes/api/auth/forgot-password/+server.js'
import { PUT as password } from '../../src/routes/api/me/password/+server.js'
import { PUT as profile } from '../../src/routes/api/me/profile/+server.js'
import { checkVerificationEmailRateLimit, createEmailVerification, createEmailVerificationWithPolling, createPasswordResetToken, sendVerificationEmail, sendPasswordResetEmail } from '../../src/lib/server/auth/email-verification.js'
import { POST as verifyEmail } from '../../src/routes/api/auth/verify-email/+server.js'
import { CFG, getConfigValue, invalidateConfigCache } from '../../src/lib/server/config.js'
import { hashPassword } from '../../src/lib/server/auth/password.js'
import { migrateTestDatabase, query, truncate } from '../helpers/pglite-sql.js'

const user = { id: 'owner', username: 'owner', email: 'owner@example.test', display_name: 'Owner', avatar_url: null, role: 'user', status: 'active' }
function event(path: string, body?: unknown) {
  const url = new URL(`https://service.invalid${path}`)
  return { url, locals: { user }, cookies: { get: () => 'current' }, getClientAddress: () => '127.0.0.1',
    request: new Request(url, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }) } as any
}
beforeAll(() => migrateTestDatabase(), 15_000)
beforeEach(async () => {
  faults.sessions = false
  vi.mocked(sendVerificationEmail).mockReset().mockResolvedValue(undefined)
  vi.mocked(sendPasswordResetEmail).mockClear()
  vi.mocked(hashPassword).mockClear()
  invalidateConfigCache()
  await truncate('users', 'email_send_attempts')
  await query("INSERT INTO users (id,username,email,email_verified,display_name,password_hash) VALUES ('owner','owner','owner@example.test',TRUE,'Owner','synthetic-old-hash')")
})

describe('account state consistency', () => {
  it('lists every device even when names match', async () => {
    await query("INSERT INTO user_devices (id,user_id,name,secret_hash,secret_encrypted,status) VALUES ('one','owner','same','synthetic','synthetic','active'),('two','owner','same','synthetic','synthetic','active')")
    expect((await (await devices(event('/api/me/devices')) as Response).json()).devices).toHaveLength(2)
  })

  it('does not expose verified status for arbitrary email addresses', async () => {
    expect(await (await verified(event('/api/auth/check-verified?email=owner@example.test')) as Response).json()).toEqual({ verified: false })
  })

  it.each(['missing', 'verified', 'unverified'])('uses the same resend response for %s accounts', async state => {
    if (state === 'unverified') await query("UPDATE users SET email_verified=FALSE WHERE id='owner'")
    const response = await resend(event('/api/auth/resend-verification', { email: state === 'missing' ? 'missing@example.test' : user.email })) as Response
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, message: 'If an account exists, a verification email has been sent' })
  })

  it('normalizes legacy email casing in the forgot-password flow', async () => {
    await query("UPDATE users SET email='Owner@Example.TEST' WHERE id='owner'")
    expect((await forgot(event('/api/auth/forgot-password', { email: ' OWNER@example.test ' })) as Response).status).toBe(200)
    expect(sendPasswordResetEmail).toHaveBeenCalledOnce()
  })

  it('rejects a new registration matching a legacy mixed-case email', async () => {
    await query("UPDATE users SET email='Owner@Example.TEST' WHERE id='owner'")
    expect((await register(event('/api/auth/register', { username: 'new-owner', email: 'OWNER@example.test', password: 'synthetic-input' })) as Response).status).toBe(409)
    expect(await query('SELECT id FROM users')).toHaveLength(1)
  })

  it('does not consume an email verification token on GET', async () => {
    const url = await createEmailVerification('owner', user.email)
    await verificationPage(event(new URL(url).pathname + new URL(url).search))
    expect((await query('SELECT consumed_at FROM email_verification_tokens'))[0].consumed_at).toBeNull()
  })

  it('polls only with a separate random ticket, which cannot verify email', async () => {
    await query("UPDATE users SET email_verified=FALSE WHERE id='owner'")
    const ticket = await createEmailVerificationWithPolling('owner', user.email)
    expect((await verifyEmail(event('/api/auth/verify-email', { token: ticket.pollToken })) as Response).status).toBe(400)
    const token = new URL(ticket.url).searchParams.get('token')
    expect((await verifyEmail(event('/api/auth/verify-email', { token })) as Response).status).toBe(200)
    expect(await (await verified(event(`/api/auth/check-verified?token=${ticket.pollToken}`)) as Response).json()).toEqual({ verified: true })
  })

  it('rolls back password and token consumption if session revocation fails', async () => {
    const token = new URL(await createPasswordResetToken('owner')).searchParams.get('token')
    faults.sessions = true
    await expect(reset(event('/api/auth/reset-password', { token, password: 'synthetic-input' }))).rejects.toThrow('synthetic revoke failure')
    expect((await query('SELECT consumed_at FROM password_reset_tokens'))[0].consumed_at).toBeNull()
    expect((await query("SELECT password_hash FROM users WHERE id='owner'"))[0].password_hash).toBe('synthetic-old-hash')
  })

  it('does not perform bcrypt for an invalid reset token', async () => {
    expect((await reset(event('/api/auth/reset-password', { token: 'x'.repeat(48), password: 'synthetic-input' })) as Response).status).toBe(400)
    expect(hashPassword).not.toHaveBeenCalled()
  })

  it('preserves the current session and revokes other sessions on password change', async () => {
    await query("INSERT INTO sessions (sid,user_id,expires_at) VALUES ('current','owner',NOW()+INTERVAL '1 day'),('other','owner',NOW()+INTERVAL '1 day')")
    expect((await password(event('/api/me/password', { current_password: 'synthetic-input', new_password: 'synthetic-new-input' })) as Response).status).toBe(200)
    expect((await query('SELECT sid FROM sessions')).map(row => row.sid)).toEqual(['current'])
  })

  it('serializes concurrent renames against the fresh cooldown state', async () => {
    const results = await Promise.all(['new-one', 'new-two'].map(username => profile(event('/api/me/profile', { username }))))
    expect(results.map(response => (response as Response).status).sort()).toEqual([200, 429])
  })

  it('rejects registration of another user’s reserved username', async () => {
    await query("INSERT INTO reserved_usernames (username,user_id,reserved_until) VALUES ('reserved','owner',NOW()+INTERVAL '1 day')")
    expect((await register(event('/api/auth/register', { username: 'reserved', email: 'new@example.test', password: 'synthetic-input' })) as Response).status).toBe(409)
  })

  it('atomically reserves email attempts before any send', async () => {
    const max = Math.min(await getConfigValue(CFG.EMAIL_IP_LIMIT), await getConfigValue(CFG.EMAIL_LIMIT))
    const results = await Promise.all(Array.from({ length: max + 5 }, () => checkVerificationEmailRateLimit('127.0.0.2', 'new@example.test')))
    const allowed = results.filter(result => result === null).length
    expect(allowed).toBe(max)
    expect(Number((await query('SELECT COUNT(*) AS count FROM email_send_attempts'))[0].count)).toBe(max)
  })

  it('does not delete an already-created account after a delivery failure', async () => {
    vi.mocked(sendVerificationEmail).mockRejectedValue(new Error('synthetic delivery failure'))
    await register(event('/api/auth/register', { username: 'new-user', email: 'new@example.test', password: 'synthetic-input' }))
    expect(await query("SELECT id FROM users WHERE username='new-user'")).toHaveLength(1)
  })
})
