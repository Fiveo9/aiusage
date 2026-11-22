import { describe, expect, it, vi } from 'vitest'
vi.mock('$env/dynamic/private', () => ({ env: { R2_PUBLIC_URL: 'https://cdn.invalid/base///' } }))
import { getSafeRedirect } from '../../src/lib/safe-redirect.js'
import { extractKeyFromUrl } from '../../src/lib/server/storage/r2.js'

describe('redirect and avatar URL boundaries', () => {
  it.each(['//evil.invalid', '/\\evil.invalid', '/\n/evil.invalid', 'https://evil.invalid', null])('rejects cross-origin redirect %j', value => {
    expect(getSafeRedirect(value)).toBe('/settings')
  })
  it('preserves a local route, query, and fragment', () => {
    expect(getSafeRedirect('/cli/authorize?code=synthetic#confirm')).toBe('/cli/authorize?code=synthetic#confirm')
  })
  it('normalizes the public URL and checks the owner prefix', () => {
    expect(extractKeyFromUrl('https://cdn.invalid/base/avatars/owner/new.webp', 'avatars/owner/')).toBe('avatars/owner/new.webp')
  })
  it.each(['https://cdn.invalid.evil/base/avatars/owner/new.webp', 'https://cdn.invalid/base/avatars/other/new.webp', 'https://cdn.invalid/base/avatars/owner/%2e%2e%2fother/new.webp', 'https://cdn.invalid/base/avatars/owner/%5cother.webp'])('rejects an unsafe avatar key %s', url => {
    expect(extractKeyFromUrl(url, 'avatars/owner/')).toBeNull()
  })
})
