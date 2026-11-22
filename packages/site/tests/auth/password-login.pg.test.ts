import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../src/lib/server/db/pool.js', async () => ({ sql: (await import('../helpers/pglite-sql.js')).sql }))
vi.mock('$env/dynamic/private', () => ({ env: { ADMIN_EMAILS: 'admin@example.test', IP_HASH_SECRET: 'synthetic-value', SITE_URL: 'https://service.invalid' } }))
vi.mock('../../src/lib/server/auth/password.js', async original => ({
  ...await original<typeof import('../../src/lib/server/auth/password.js')>(), verifyPassword: vi.fn(async () => false),
}))
import { POST } from '../../src/routes/api/auth/login/+server.js'
import { verifyPassword, DUMMY_PASSWORD_HASH } from '../../src/lib/server/auth/password.js'
import { migrateTestDatabase, query, truncate } from '../helpers/pglite-sql.js'

beforeAll(() => migrateTestDatabase(), 15_000)
beforeEach(async () => { await truncate('users', 'auth_rate_limits'); vi.mocked(verifyPassword).mockReset().mockResolvedValue(false) })
function event(body: unknown, ip = '127.0.0.1') {
  const request = new Request('https://service.invalid/api/auth/login', { method: 'POST', body: JSON.stringify(body) })
  return { request, getClientAddress: () => ip, cookies: { set: vi.fn() } } as any
}

describe('password login defenses', () => {
  it('performs the dummy comparison when an account does not exist', async () => {
    expect((await POST(event({ login: 'unknown', password: 'synthetic-input' })) as Response).status).toBe(401)
    expect(verifyPassword).toHaveBeenCalledWith('synthetic-input', DUMMY_PASSWORD_HASH)
  })

  it.each([Array(8).fill('x'), 'x'.repeat(73)])('rejects invalid passwords before bcrypt', async password => {
    expect((await POST(event({ login: 'unknown', password })) as Response).status).toBe(400)
    expect(verifyPassword).not.toHaveBeenCalled()
  })

  it('limits account attempts even when the source IP changes', async () => {
    for (let i = 0; i < 10; i++) expect((await POST(event({ login: 'unknown', password: 'synthetic-input' }, `127.0.0.${i + 1}`)) as Response).status).toBe(401)
    const response = await POST(event({ login: 'unknown', password: 'synthetic-input' }, '127.0.0.100')) as Response
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('retains verified password-login admin grants with an explicit ownership flag', async () => {
    await query("INSERT INTO users (id, username, email, email_verified, password_hash, display_name) VALUES ('owner', 'owner', 'admin@example.test', TRUE, 'synthetic-hash', 'Owner')")
    vi.mocked(verifyPassword).mockResolvedValue(true)
    const response = await POST(event({ login: 'owner', password: 'synthetic-input' })) as Response
    expect(response.status).toBe(200)
    expect((await response.json()).user.role).toBe('admin')
  })
})
