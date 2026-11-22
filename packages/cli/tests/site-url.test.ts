import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const files = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => 'SITE_URL=https://injected.invalid\nAIUSAGE_F04_SYNTHETIC_SENTINEL=injected\n'),
}))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), ...files }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  vi.stubEnv('SITE_URL', undefined)
  vi.stubEnv('AIUSAGE_SITE_URL', undefined)
  vi.stubEnv('AIUSAGE_F04_SYNTHETIC_SENTINEL', undefined)
})
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

describe('explicit site URL configuration', () => {
  it('does not read a CWD environment file or populate unrelated environment variables', async () => {
    const { getSiteUrl } = await import('../src/site-url.js')
    expect(getSiteUrl()).toBe('https://aiusage.jtanx.com')
    expect(files.readFileSync).not.toHaveBeenCalled()
    expect(process.env.AIUSAGE_F04_SYNTHETIC_SENTINEL).toBeUndefined()
  })

  it('uses the explicitly supplied SITE_URL without loading files', async () => {
    vi.stubEnv('SITE_URL', 'https://explicit.invalid')
    const { getSiteUrl } = await import('../src/site-url.js')
    expect(getSiteUrl()).toBe('https://explicit.invalid')
    expect(files.readFileSync).not.toHaveBeenCalled()
  })

  it('prefers the application-specific environment variable', async () => {
    vi.stubEnv('SITE_URL', 'https://other-app.invalid')
    vi.stubEnv('AIUSAGE_SITE_URL', 'https://aiusage.invalid')
    const { getSiteUrl } = await import('../src/site-url.js')
    expect(getSiteUrl()).toBe('https://aiusage.invalid')
  })
})
