import { beforeEach, describe, expect, it, vi } from 'vitest'
const config = vi.hoisted(() => ({ SITE_URL: 'https://service.invalid' }))
vi.mock('$env/dynamic/private', () => ({ env: config }))
vi.mock('../../src/lib/server/db/schema.js', () => ({ runMigrations: vi.fn(async () => {}) }))
vi.mock('../../src/lib/server/db/cleanup.js', () => ({ startCleanupCron: vi.fn() }))
vi.mock('../../src/lib/server/auth/session.js', () => ({
  getUserFromEvent: vi.fn(async () => null),
  getSessionDurationMs: vi.fn(async () => 7 * 24 * 60 * 60 * 1000),
}))
import { handle } from '../../src/hooks.server.js'
import { setCsrfCookie, validateCsrfToken } from '../../src/lib/server/auth/csrf.js'

const token = 'a'.repeat(64)
beforeEach(() => { config.SITE_URL = 'https://service.invalid' })

function request(path = '/settings', headers: Record<string, string> = {}, method = 'GET') {
  const url = new URL(`https://service.invalid${path}`)
  return { url, request: new Request(url, { method, headers }), locals: {}, isDataRequest: false } as any
}
function page(event: ReturnType<typeof request>, type = 'text/html', responseHeaders = {}) {
  return handle({ event, resolve: async () => new Response('synthetic response', {
    headers: { 'content-type': type, ...responseHeaders },
  }) } as any)
}

describe('CSRF cookie lifecycle', () => {
  it('appends the CSRF cookie without overwriting an existing session cookie', async () => {
    const response = new Response(null, { headers: { 'Set-Cookie': 'ai_session=synthetic-session; Path=/; HttpOnly' } })
    await setCsrfCookie(response, token)
    expect(response.headers.getSetCookie()).toHaveLength(2)
    expect(response.headers.getSetCookie()[0]).toContain('ai_session=synthetic-session')
    const csrf = response.headers.getSetCookie().find(cookie => cookie.startsWith('csrf_token='))!
    expect(csrf).toContain('Max-Age=604800')
    expect(csrf).toContain('; Secure')
    expect(csrf).not.toContain('HttpOnly')
  })

  it.each([['http://service.invalid', false], ['https://service.invalid', true]] as const)
    ('aligns session lifetime and transport security for %s', async (siteUrl, secure) => {
      config.SITE_URL = siteUrl
      const response = new Response(null)
      await setCsrfCookie(response, token)
      expect(response.headers.get('set-cookie')).toContain('Max-Age=604800')
      expect(response.headers.get('set-cookie')!.includes('; Secure')).toBe(secure)
    })

  it('does not rotate a valid cookie on a subsequent page navigation', async () => {
    const response = await page(request('/settings', { cookie: `csrf_token=${token}` }))
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it.each([
    ['/_app/immutable/app.js', 'application/javascript'], ['/favicon.ico', 'image/x-icon'],
    ['/settings/__data.json', 'application/json'],
  ])('does not issue a CSRF cookie for resource %s', async (path, type) => {
    expect((await page(request(path), type)).headers.get('set-cookie')).toBeNull()
  })

  it('does not issue a cookie during a speculative HTML prefetch', async () => {
    const response = await page(request('/settings', { purpose: 'prefetch' }))
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('does not issue a cookie during a SvelteKit data preload', async () => {
    const event = request('/settings')
    event.isDataRequest = true
    expect((await page(event)).headers.get('set-cookie')).toBeNull()
  })

  it('issues a new token only for a page with a missing or malformed cookie', async () => {
    for (const cookie of ['', 'csrf_token=malformed']) {
      const response = await page(request('/login', { cookie }))
      expect(response.headers.get('set-cookie')).toMatch(/csrf_token=[a-f0-9]{64};/)
    }
  })

  it('rejects malformed token pairs even when their text is equal', () => {
    expect(validateCsrfToken(new Request('https://service.invalid/api/auth/login', { method: 'POST',
      headers: { cookie: 'csrf_token=chosen-invalid-token', 'x-csrf-token': 'chosen-invalid-token' },
    }))).toBe(false)
  })
})
