import { beforeEach, afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ migrate: vi.fn(), cron: vi.fn(), user: vi.fn() }))
vi.mock('$lib/server/db/schema.js', () => ({ runMigrations: mocks.migrate }))
vi.mock('$lib/server/db/cleanup.js', () => ({ startCleanupCron: mocks.cron }))
vi.mock('$lib/server/auth/session.js', () => ({ getUserFromEvent: mocks.user }))
vi.mock('$lib/server/auth/csrf.js', () => ({
  generateCsrfToken: () => 'synthetic', validateCsrfToken: () => true, setCsrfCookie: () => {},
}))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.user.mockResolvedValue(null)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

function request(path = '/api/test') {
  const url = new URL(path, 'http://localhost')
  return { event: { url, request: new Request(url), locals: {} }, resolve: vi.fn(async () => new Response('ok')) }
}

it('shares initialization across concurrent requests and starts cleanup once', async () => {
  let finish!: () => void
  mocks.migrate.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  const { handle } = await import('../src/hooks.server.js')
  const first = request(), second = request()
  const a = handle(first as any), b = handle(second as any)
  expect(mocks.migrate).toHaveBeenCalledTimes(1)
  expect(mocks.user).not.toHaveBeenCalled()
  finish()
  expect((await a).status).toBe(200)
  expect((await b).status).toBe(200)
  await handle(request() as any)
  expect(mocks.migrate).toHaveBeenCalledTimes(1)
  expect(mocks.cron).toHaveBeenCalledTimes(1)
})

it('fails closed with 503, preserves sync CORS, and retries on a later request', async () => {
  mocks.migrate.mockRejectedValueOnce(new Error('synthetic failure')).mockResolvedValue(undefined)
  const { handle } = await import('../src/hooks.server.js')
  const failed = request('/api/cli/sync/status')
  const response = await handle(failed as any)
  expect(response.status).toBe(503)
  expect(response.headers.get('Retry-After')).toBe('5')
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  expect(failed.resolve).not.toHaveBeenCalled()
  expect(mocks.user).not.toHaveBeenCalled()
  expect(mocks.cron).not.toHaveBeenCalled()
  expect((await handle(request() as any)).status).toBe(200)
  expect(mocks.migrate).toHaveBeenCalledTimes(2)
  expect(mocks.cron).toHaveBeenCalledTimes(1)
})

it('leaves sync preflight available without initializing the database', async () => {
  const { handle } = await import('../src/hooks.server.js')
  const input = request('/api/cli/sync/status')
  input.event.request = new Request(input.event.url, { method: 'OPTIONS' })
  expect((await handle(input as any)).status).toBe(204)
  expect(mocks.migrate).not.toHaveBeenCalled()
})
