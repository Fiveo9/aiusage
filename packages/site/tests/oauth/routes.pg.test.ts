import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
const accounts = vi.hoisted(() => ({
  owner: { id: 'owner', username: 'owner', email: 'owner@example.test', display_name: 'Owner', avatar_url: null, role: 'user', status: 'active' },
  oauth: { id: 'oauth-owner', username: 'oauth', email: 'oauth@example.test', display_name: 'OAuth', avatar_url: null, role: 'user', status: 'active' },
}))
vi.mock('../../src/lib/server/db/pool.js', async () => ({ sql: (await import('../helpers/pglite-sql.js')).sql }))
vi.mock('$env/dynamic/private', () => ({ env: {
  SITE_URL: 'https://service.invalid', GITHUB_CLIENT_ID: 'synthetic-client', GITHUB_CLIENT_SECRET: 'synthetic-value',
  LINUX_DO_CLIENT_ID: 'synthetic-client', LINUX_DO_CLIENT_SECRET: 'synthetic-value',
  LINUX_DO_AUTHORIZATION_URL: 'https://provider.invalid/authorize', LINUX_DO_TOKEN_URL: 'https://provider.invalid/token',
} }))
vi.mock('../../src/lib/server/auth/session.js', async original => ({
  ...await original<typeof import('../../src/lib/server/auth/session.js')>(),
  getSessionUser: vi.fn(async sid => sid === 'session-1' ? accounts.owner : null),
  createSession: vi.fn(async () => 'synthetic-session'), setSessionCookie: vi.fn(async () => {}),
}))
vi.mock('../../src/lib/server/oauth/providers.js', async original => ({
  ...await original<typeof import('../../src/lib/server/oauth/providers.js')>(),
  fetchGitHubProfile: vi.fn(async () => ({ provider: 'github', providerUserId: 'synthetic-provider' })),
  fetchLinuxDoProfile: vi.fn(async () => ({ provider: 'linux_do', providerUserId: 'synthetic-provider' })),
  findOrCreateOAuthUser: vi.fn(async () => accounts.oauth), bindOAuthIdentity: vi.fn(async () => ({})),
}))
import { GET as githubStart } from '../../src/routes/api/oauth/github/start/+server.js'
import { GET as githubCallback } from '../../src/routes/api/oauth/github/callback/+server.js'
import { GET as linuxStart } from '../../src/routes/api/oauth/linux-do/start/+server.js'
import { GET as linuxCallback } from '../../src/routes/api/oauth/linux-do/callback/+server.js'
import { bindOAuthIdentity, findOrCreateOAuthUser } from '../../src/lib/server/oauth/providers.js'
import { createSession, getSessionUser } from '../../src/lib/server/auth/session.js'
import { oauthStateCookie } from '../../src/lib/server/oauth/state-store.js'
import { migrateTestDatabase, query, truncate } from '../helpers/pglite-sql.js'

beforeAll(() => migrateTestDatabase(), 15_000)
beforeEach(async () => {
  await truncate('users', 'oauth_states')
  await query("INSERT INTO users (id, username, email, display_name) VALUES ('owner', 'owner', 'owner@example.test', 'Owner')")
  vi.clearAllMocks()
  vi.mocked(getSessionUser).mockImplementation(async sid => sid === 'session-1' ? accounts.owner : null)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'synthetic-value' }), {
    headers: { 'content-type': 'application/json' },
  })))
})
afterEach(() => vi.unstubAllGlobals())

function browser(session?: string) {
  const values = new Map<string, string>(session ? [['ai_session', session]] : [])
  return { values, get: (name: string) => values.get(name),
    set: vi.fn((name: string, value: string, _options: unknown) => { values.set(name, value) }),
    delete: vi.fn((name: string) => { values.delete(name) }),
  }
}
const providers = [
  { name: 'github' as const, path: 'github', start: githubStart, callback: githubCallback },
  { name: 'linux_do' as const, path: 'linux-do', start: linuxStart, callback: linuxCallback },
]
for (const provider of providers) describe(`${provider.name} browser and session binding`, () => {
  async function start(cookies: ReturnType<typeof browser>, mode = '') {
    const response = await provider.start({ cookies, url: new URL(`https://service.invalid/api/oauth/${provider.path}/start${mode}`) } as any) as Response
    return { response, state: response.headers.get('location') ? new URL(response.headers.get('location')!).searchParams.get('state')! : '' }
  }
  function callback(cookies: ReturnType<typeof browser>, state: string) {
    return provider.callback({ cookies, url: new URL(`https://service.invalid/api/oauth/${provider.path}/callback?code=synthetic-code&state=${state}`) } as any)
  }

  it('requires a valid session for explicit binding and rejects unknown modes', async () => {
    expect((await start(browser(), '?mode=bind')).response.status).toBe(403)
    expect((await start(browser('expired'), '?mode=bind')).response.status).toBe(403)
    expect((await start(browser(), '?mode=unknown')).response.status).toBe(400)
  })

  it('rejects a callback from a browser missing the issuing cookie', async () => {
    const { state } = await start(browser('session-1'), '?mode=bind')
    const response = await callback(browser('session-1'), state) as Response
    expect(response.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
    expect(bindOAuthIdentity).not.toHaveBeenCalled()
  })

  it('rejects a changed session even with the original browser cookie', async () => {
    const cookies = browser('session-1')
    const { state } = await start(cookies, '?mode=bind')
    cookies.values.set('ai_session', 'session-2')
    expect((await callback(cookies, state) as Response).status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects an expired binding session before exchanging the authorization code', async () => {
    const cookies = browser('session-1')
    const { state } = await start(cookies, '?mode=bind')
    vi.mocked(getSessionUser).mockResolvedValueOnce(null)
    expect((await callback(cookies, state) as Response).status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('binds only an explicit browser-bound flow and rejects replay', async () => {
    const cookies = browser('session-1')
    const { state } = await start(cookies, '?mode=bind')
    expect(cookies.set).toHaveBeenCalledWith(oauthStateCookie(provider.name), expect.any(String),
      expect.objectContaining({ path: '/', httpOnly: true, sameSite: 'lax', secure: true, maxAge: 600 }))
    await expect(callback(cookies, state)).rejects.toMatchObject({ status: 302 })
    expect(bindOAuthIdentity).toHaveBeenCalledTimes(1)
    expect(findOrCreateOAuthUser).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
    expect((await callback(cookies, state) as Response).status).toBe(400)
    expect(bindOAuthIdentity).toHaveBeenCalledTimes(1)
  })

  it('does not turn a login flow into binding just because a session cookie exists', async () => {
    const cookies = browser('session-1')
    const { state } = await start(cookies)
    await expect(callback(cookies, state)).rejects.toMatchObject({ status: 302 })
    expect(bindOAuthIdentity).not.toHaveBeenCalled()
    expect(findOrCreateOAuthUser).toHaveBeenCalledTimes(1)
    expect(createSession).toHaveBeenCalledWith('oauth-owner')
  })
})
