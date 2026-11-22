import { describe, expect, it, vi } from 'vitest'
vi.mock('$lib/server/config.js', () => ({ CFG: { PASSWORD_MIN_LENGTH: 'password.min_length' }, getConfigValue: async () => 8 }))
import { validatePassword } from '../../src/lib/server/auth/password.js'

describe('password input boundaries', () => {
  it.each([Array(8).fill('x'), { value: 'synthetic' }])('rejects non-string passwords', async password => {
    expect(await validatePassword(password as any)).toMatchObject({ code: 'password_type' })
  })
  it.each(['x'.repeat(73), '中'.repeat(25)])('rejects passwords beyond bcrypt byte capacity', async password => {
    expect(await validatePassword(password)).toMatchObject({ code: 'password_too_long' })
  })
  it('accepts the exact 72-byte boundary', async () => {
    expect(await validatePassword('x'.repeat(72))).toBeNull()
  })
})
