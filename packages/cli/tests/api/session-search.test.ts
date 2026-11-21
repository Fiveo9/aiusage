import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Server } from 'node:http'
import { runMigrations } from '../../src/db/migrations/index.js'
import { insertRecord } from '../../src/db/records.js'
import { insertSyncedRecord } from '../../src/db/synced-records.js'
import { createApiServer } from '../../src/api/server.js'
import type { StatsRecord } from '@aiusage/core'

vi.mock('../../src/config.js', async original => ({ ...await original<typeof import('../../src/config.js')>(), loadConfig: () => null }))
vi.mock('../../src/auth.js', async original => ({ ...await original<typeof import('../../src/auth.js')>(), getDashboardPassword: () => undefined }))

let db: Database.Database
let server: Server
let base: string
const time = Date.UTC(2026, 10, 10, 12)
function add(id: string, fields: Partial<StatsRecord> = {}) {
  insertRecord(db, { id, ts: time, ingestedAt: 1, updatedAt: 1, lineOffset: 0,
    tool: 'codex', model: 'model', provider: 'openai', inputTokens: 10, outputTokens: 2,
    cacheReadTokens: 3, cacheWriteTokens: 4, thinkingTokens: 2, cost: 1, costSource: 'pricing',
    sessionId: id, sourceFile: '/synthetic/log', device: 'local', deviceInstanceId: 'a', origin: 'local', ...fields })
}
async function get(query: string) {
  const response = await fetch(`${base}/api/sessions?${query}`)
  return { status: response.status, ...await response.json() }
}
beforeEach(async () => {
  db = new Database(':memory:'); runMigrations(db)
  server = createApiServer(db, { currentDeviceInstanceId: 'a' })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close() })

describe('session search and ordering', () => {
  it('searches before pagination and keeps complete session totals', async () => {
    for (let i = 0; i < 55; i++) add(`filler-${i}`, { ts: time + i })
    add('match-a', { sessionTitle: '修复 API', cost: 2 })
    add('match-a-more', { sessionId: 'match-a', cost: 3 })
    add('match-b', { sessionTitle: 'API review', cost: 4 })
    const first = await get('range=all&q=api&sort=cost&pageSize=1')
    expect(first).toMatchObject({ status: 200, total: 2, sessions: [expect.objectContaining({ sessionId: 'match-a', cost: 5, inputTokens: 20 })] })
    expect((await get('range=all&q=api&sort=cost&pageSize=1&page=2')).sessions[0].sessionId).toBe('match-b')
    expect((await get('range=all&q=api&page=3&pageSize=1')).sessions).toEqual([])
  })

  it('matches only the latest displayed title even outside the date window', async () => {
    add('r1', { sessionId: 'same', sessionTitle: '旧标题' })
    add('r2', { sessionId: 'same', sessionTitle: '新标题', ts: Date.UTC(2026, 9, 1), updatedAt: 20 })
    const range = 'from=2026-11-10&to=2026-11-10'
    expect((await get(`${range}&q=${encodeURIComponent('旧标题')}`)).total).toBe(0)
    expect((await get(`${range}&q=${encodeURIComponent('新标题')}`)).sessions[0]).toMatchObject({ inputTokens: 10, sessionTitle: '新标题' })
  })

  it('treats SQL wildcard characters literally and finds unnamed sessions by ID', async () => {
    add('untitled-ABC')
    add('named', { sessionTitle: "100%_done's 😀" })
    expect((await get('range=all&q=%25_')).sessions.map((row: any) => row.sessionId)).toEqual(['named'])
    expect((await get('range=all&q=abc')).sessions[0].sessionId).toBe('untitled-ABC')
    expect((await get(`range=all&q=${encodeURIComponent("' OR 1=1 --")}`)).total).toBe(0)
  })

  it('does not mix titles or usage across devices and tools, including unmerged synced rows', async () => {
    add('local', { sessionId: 'same', sessionTitle: 'Local' })
    add('remote', { sessionId: 'same', sessionTitle: 'Remote', origin: 'synced', deviceInstanceId: 'b' })
    add('claude', { sessionId: 'same', sessionTitle: 'Claude', tool: 'claude-code', updatedAt: 30 })
    insertSyncedRecord(db, { id: 'unmerged', ts: time, updatedAt: 1, tool: 'codex', model: 'model', provider: 'openai', inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, cost: 0, costSource: 'unknown', sessionKey: 'remote-only', sessionTitle: 'Remote only', device: 'third', deviceInstanceId: 'c' })
    expect((await get('range=all&q=remote&device=a')).total).toBe(0)
    expect((await get('range=all&q=remote')).total).toBe(2)
    expect((await get('range=all&q=local&tool=codex')).sessions[0].inputTokens).toBe(10)
    expect((await get('range=all&q=local&tool=claude-code')).total).toBe(0)
  })

  it('sorts by last activity, aggregated cost or token composition with deterministic ties', async () => {
    add('a', { inputTokens: 20, cost: 3 })
    add('b', { inputTokens: 40, cost: 3, ts: time + 100 })
    add('c', { inputTokens: 1, cost: 1, ts: time - 100 })
    add('c-last', { sessionId: 'c', inputTokens: 1, cost: 0, ts: time + 200 })
    const ids = async (sort: string) => (await get(`range=all&sort=${sort}`)).sessions.map((row: any) => row.sessionId)
    expect(await ids('newest')).toEqual(['c', 'b', 'a'])
    expect(await ids('cost')).toEqual(['a', 'b', 'c'])
    expect(await ids('tokens')).toEqual(['b', 'a', 'c'])
    expect((await get('range=all&sort=tokens')).sessions[0].totalTokens).toBe(51)
    add('reasoning', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 100 })
    expect((await get('range=all&sort=tokens')).sessions[0]).toMatchObject({ sessionId: 'reasoning', totalTokens: 100 })
  })

  it.each(['sort=invalid', `q=${'x'.repeat(201)}`, 'q=%00', 'page=0'])('rejects invalid input %s', async query => {
    expect(await get(`range=all&${query}`)).toMatchObject({ status: 400, error: { code: 'INVALID_PARAM' } })
  })
})
