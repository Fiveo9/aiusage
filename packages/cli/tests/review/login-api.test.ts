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

function call(path: string, chunks: string[] = [], headers: Record<string, string> = {}) {
  return new Promise<{ status: number; cookie?: string; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path,
      method: chunks.length ? 'POST' : 'GET', headers }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, cookie: res.headers['set-cookie']?.[0], body }))
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
