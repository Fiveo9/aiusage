import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestEvent } from '@sveltejs/kit'
import { queries, resetFakeSql, respondWith, type RecordedQuery } from '../mocks/sql.js'

vi.mock('../../src/lib/server/db/pool.js', async () => ({ sql: (await import('../mocks/sql.js')).fakeSql }))
vi.mock('../../src/lib/server/db/schema.js', () => ({ runMigrations: async () => {} }))
vi.mock('../../src/lib/server/db/cleanup.js', () => ({ startCleanupCron: () => {} }))

import { handle } from '../../src/hooks.server.js'
import { getRequestUser, requireAdmin, requireUser, type SessionUser } from '../../src/lib/server/auth/session.js'

const isSessionLookup = (q: RecordedQuery) => q.text.includes('FROM sessions s JOIN users u')

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return { id: 'user_1', username: 'ada', email: 'ada@example.com', display_name: 'Ada', avatar_url: null, role: 'user', status: 'active', ...overrides }
}

/** The sessions table: sid -> user. A sid that is absent is expired or unknown. */
function sessions(table: Record<string, SessionUser>) {
  respondWith((q) => {
    if (isSessionLookup(q)) {
      const found = table[q.values[0] as string]
      return found ? [found] : []
    }
    return undefined
  })
}

function event(sid?: string, path = '/api/me'): RequestEvent {
  return {
    url: new URL(`http://localhost${path}`),
    request: new Request(`http://localhost${path}`),
    cookies: { get: (name: string) => (name === 'ai_session' ? sid : undefined) },
    locals: {},
  } as unknown as RequestEvent
}

/** Runs `guard` the way an endpoint does: inside the request, after the hook. */
async function throughHook<T>(ev: RequestEvent, guard: (ev: RequestEvent) => Promise<T>): Promise<{ value?: T; thrown?: unknown }> {
  const outcome: { value?: T; thrown?: unknown } = {}
  await handle({
    event: ev,
    resolve: async (resolved: RequestEvent) => {
      try {
        outcome.value = await guard(resolved)
      } catch (err) {
        outcome.thrown = err
      }
      return new Response('ok')
    },
  } as unknown as Parameters<typeof handle>[0])
  return outcome
}

beforeEach(() => {
  resetFakeSql()
  vi.restoreAllMocks()
})

describe('requireUser after the request hook', () => {
  it('loads the session once per request', async () => {
    sessions({ sid_ok: user() })

    const outcome = await throughHook(event('sid_ok'), requireUser)

    expect(outcome.value).toEqual(user())
    expect(queries.filter(isSessionLookup)).toHaveLength(1)
  })

  it('loads the session once per request for requireAdmin and for repeated guards', async () => {
    sessions({ sid_admin: user({ role: 'admin' }) })

    const outcome = await throughHook(event('sid_admin'), async (ev) => {
      await requireUser(ev)
      await getRequestUser(ev)
      return requireAdmin(ev)
    })

    expect(outcome.value).toEqual(user({ role: 'admin' }))
    expect(queries.filter(isSessionLookup)).toHaveLength(1)
  })

  it('answers 401 unauthorized without a session cookie', async () => {
    sessions({ sid_ok: user() })

    const outcome = await throughHook(event(undefined), requireUser)

    expect(outcome.thrown).toMatchObject({ status: 401, body: { message: 'unauthorized' } })
    expect(queries.filter(isSessionLookup)).toHaveLength(0)
  })

  it('answers 401 unauthorized for an expired or unknown session', async () => {
    sessions({ sid_ok: user() })

    const outcome = await throughHook(event('sid_expired'), requireUser)

    expect(outcome.thrown).toMatchObject({ status: 401, body: { message: 'unauthorized' } })
    expect(queries.filter(isSessionLookup)).toHaveLength(1)
  })

  it('checks the expiry in the session query', async () => {
    sessions({ sid_ok: user() })

    await throughHook(event('sid_ok'), requireUser)

    const lookup = queries.find(isSessionLookup)!
    expect(lookup.text).toContain('WHERE s.sid = ? AND s.expires_at > NOW()')
    expect(lookup.values).toEqual(['sid_ok'])
  })

  it('answers 403 user_banned for a banned user, also through requireAdmin', async () => {
    sessions({ sid_banned: user({ status: 'banned', role: 'admin' }) })

    const asUser = await throughHook(event('sid_banned'), requireUser)
    const asAdmin = await throughHook(event('sid_banned'), requireAdmin)

    expect(asUser.thrown).toMatchObject({ status: 403, body: { message: 'user_banned' } })
    expect(asAdmin.thrown).toMatchObject({ status: 403, body: { message: 'user_banned' } })
  })

  it('answers 403 forbidden when requireAdmin meets a user who is not an admin', async () => {
    sessions({ sid_ok: user() })

    const outcome = await throughHook(event('sid_ok'), requireAdmin)

    expect(outcome.thrown).toMatchObject({ status: 403, body: { message: 'forbidden' } })
  })

  it('answers 401 unauthorized when the session query fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    respondWith((q) => {
      if (isSessionLookup(q)) throw new Error('connection refused')
      return undefined
    })

    const outcome = await throughHook(event('sid_ok'), requireUser)

    expect(outcome.thrown).toMatchObject({ status: 401, body: { message: 'unauthorized' } })
  })

  it('does not carry a user from one request to the next', async () => {
    sessions({ sid_ok: user() })
    await throughHook(event('sid_ok'), requireUser)

    const outcome = await throughHook(event(undefined), requireUser)

    expect(outcome.thrown).toMatchObject({ status: 401, body: { message: 'unauthorized' } })
  })
})

describe('requireUser on an event the hook has not seen', () => {
  it('loads the session itself', async () => {
    sessions({ sid_ok: user() })

    expect(await requireUser(event('sid_ok'))).toEqual(user())
    expect(queries.filter(isSessionLookup)).toHaveLength(1)
  })

  it('answers 401 unauthorized without a session', async () => {
    sessions({})

    await expect(requireUser(event('sid_gone'))).rejects.toMatchObject({ status: 401, body: { message: 'unauthorized' } })
    await expect(requireUser(event(undefined))).rejects.toMatchObject({ status: 401, body: { message: 'unauthorized' } })
  })
})
