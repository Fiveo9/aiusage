import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import http from 'node:http'
import Database from 'better-sqlite3'

const fixture = vi.hoisted(() => ({ value: 'fixture-' + String(37) }))

vi.mock('../../src/config.js', async (original) => ({
  ...await original<typeof import('../../src/config.js')>(),
  loadConfig: () => null,
}))
vi.mock('../../src/auth.js', async (original) => ({
  ...await original<typeof import('../../src/auth.js')>(),
  getDashboardPassword: () => fixture.value,
}))
import { initializeDatabase } from '../../src/db/index.js'
import { createApiServer } from '../../src/api/server.js'
import { buildAuthCookie } from '../../src/auth.js'

let server: http.Server
let db: Database.Database
let port: number
beforeEach(async () => {
  db = new Database(':memory:')
  initializeDatabase(db)
  server = createApiServer(db)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
})

function call(path: string, chunks: string[] = [], headers: Record<string, string> = {}, method = chunks.length ? 'POST' : 'GET') {
  return new Promise<{ status: number; cookie?: string; body: string; retryAfter?: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path,
      method, headers }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, cookie: res.headers['set-cookie']?.[0], body, retryAfter: res.headers['retry-after'] }))
    })
    req.on('error', reject)
    for (const chunk of chunks) req.write(chunk)
    req.end()
  })
}

it('returns 413 on declared oversize at the actual public login route', async () => {
  const result = await call('/api/auth/login', ['{}'], { 'Content-Length': '20000' })
  expect(result.status).toBe(413)
  expect(result.cookie === undefined).toBe(true)
})

it('returns 413 for chunked input over 16 KiB', async () => {
  const result = await call('/api/auth/login', ['{"password":"', 'x'.repeat(17000), '"}'])
  expect(result.status).toBe(413)
})

it('still reports malformed JSON as 400', async () => {
  expect((await call('/api/auth/login', ['{'])).status).toBe(400)
})

it('accepts a newly issued session and rejects an eight-day-old session', async () => {
  const login = await call('/api/auth/login', [JSON.stringify({ password: fixture.value })])
  expect(login.status).toBe(200)
  expect(Boolean(login.cookie)).toBe(true)
  const current = await call('/api/auth/status', [], { Cookie: login.cookie!.split(';')[0] })
  expect(JSON.parse(current.body).authenticated).toBe(true)
  const expired = buildAuthCookie(fixture.value, false, Date.now() - 8 * 86400000).split(';')[0]
  const oldStatus = await call('/api/auth/status', [], { Cookie: expired })
  expect(JSON.parse(oldStatus.body).authenticated).toBe(false)
  expect((await call('/api/config', [], { Cookie: expired })).status).toBe(401)
})

it.each(['/api/pricing', '/api/config'])('rejects non-object JSON at %s', async path => {
  const cookie = buildAuthCookie(fixture.value).split(';')[0]
  expect((await call(path, ['null'], { Cookie: cookie }, 'PUT')).status).toBe(400)
})

it.each(['/api/pricing', '/api/config'])('rejects oversized UTF-8 bodies at %s', async path => {
  const cookie = buildAuthCookie(fixture.value).split(';')[0]
  const payload = JSON.stringify({ ignored: 'x'.repeat(1024 * 1024) })
  expect((await call(path, [payload], { Cookie: cookie }, 'PUT')).status).toBe(413)
})

it('uses bytes and returns 413 at GitHub action endpoints', async () => {
  const cookie = buildAuthCookie(fixture.value).split(';')[0]
  expect((await call('/api/github/unknown', [JSON.stringify({ ignored: '中'.repeat(2000) })], { Cookie: cookie })).status).toBe(413)
})

it('rejects a malformed password type at login', async () => {
  expect((await call('/api/auth/login', [JSON.stringify({ password: ['invalid'] })])).status).toBe(400)
})

it('limits repeated login attempts and returns Retry-After', async () => {
  for (let i = 0; i < 10; i++) expect((await call('/api/auth/login', [JSON.stringify({ password: 'synthetic-wrong' })])).status).toBe(401)
  const result = await call('/api/auth/login', [JSON.stringify({ password: 'synthetic-wrong' })])
  expect(result.status).toBe(429)
  expect(Number(result.retryAfter)).toBeGreaterThan(0)
})

it('prechecks oversized Kelivo multipart upload before reading its declared body', async () => {
  const cookie = buildAuthCookie(fixture.value).split(';')[0]
  const result = await call('/api/import/kelivo', ['small'], { Cookie: cookie,
    'Content-Type': 'multipart/form-data; boundary=synthetic', 'Content-Length': '100000000' })
  expect(result.status).toBe(413)
})
