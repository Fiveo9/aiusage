import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Server } from 'node:http'
import { runMigrations } from '../../src/db/migrations/index.js'
import { insertRecord } from '../../src/db/records.js'
import { insertSyncedRecord, mergeSyncedRecordsIntoRecords } from '../../src/db/synced-records.js'
import { createApiServer } from '../../src/api/server.js'
import type { StatsRecord } from '@aiusage/core'

vi.mock('../../src/config.js', async original => ({ ...await original<typeof import('../../src/config.js')>(), loadConfig: () => null }))
vi.mock('../../src/auth.js', async original => ({ ...await original<typeof import('../../src/auth.js')>(), getDashboardPassword: () => undefined }))
let db: Database.Database
let server: Server
let base: string
const ts = Date.UTC(2026, 10, 10, 12)
function add(id: string, fields: Partial<StatsRecord> = {}) {
  insertRecord(db, { id, ts, ingestedAt: 1, updatedAt: 1, lineOffset: 0,
    tool: 'codex', model: 'provider/model', provider: 'openai', inputTokens: 10, outputTokens: 2,
    cacheReadTokens: 3, cacheWriteTokens: 4, thinkingTokens: 5, cost: 1, costSource: 'pricing',
    sessionId: id, sourceFile: '/synthetic/log', device: 'local', deviceInstanceId: 'a', origin: 'local', ...fields })
}
async function start(current?: string) {
  server = createApiServer(db, current ? { currentDeviceInstanceId: current } : undefined)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
async function get(query = 'range=all') {
  const response = await fetch(`${base}/api/cost?${query}`)
  expect(response.status).toBe(200)
  return response.json()
}
beforeEach(async () => { db = new Database(':memory:'); runMigrations(db); await start('a') })
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close() })

describe('cost provenance', () => {
  it('separates logged, priced zero and unknown costs without changing stored totals', async () => {
    add('logged', {cost: 3, costSource: 'log'})
    add('priced', {cost: 2})
    add('free', {cost: 0})
    add('unknown', {cost: 0, costSource: 'unknown', model:'p1/missing'})
    add('legacy-unknown', {cost: 0.5, costSource: 'unknown', model:'p2/missing'})
    const data = await get()
    expect(data.provenance).toEqual({
      totalRecords: 5, knownRecords: 3, coverage: 0.6,
      sources: {log:{records:1,cost:3},pricing:{records:2,cost:2},unknown:{records:2,cost:0.5}},
      unpricedModels:[{model:'p1/missing',records:1,tokens:24},{model:'p2/missing',records:1,tokens:24}],
    })
    expect(data.data.reduce((sum: number, day: any) => sum + day.cost, 0)).toBe(5.5)
    expect(Object.values(data.byModel).reduce((sum: number, value: any) => sum + value, 0)).toBe(5.5)
  })

  it('keeps all-device and device-specific totals aligned without counting merged copies twice', async () => {
    add('local')
    insertSyncedRecord(db, { id:'remote',ts,updatedAt:1,tool:'claude-code',model:'remote/model',provider:'anthropic',inputTokens:20,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,thinkingTokens:7,cost:0,costSource:'unknown',sessionKey:'remote',device:'other',deviceInstanceId:'b' })
    mergeSyncedRecordsIntoRecords(db, 'a')
    expect((await get()).provenance).toMatchObject({totalRecords:2,knownRecords:1,coverage:0.5})
    expect((await get('range=all&device=a')).provenance).toMatchObject({totalRecords:1,coverage:1,unpricedModels:[]})
    expect((await get('range=all&device=b')).provenance).toMatchObject({totalRecords:1,coverage:0,unpricedModels:[{model:'remote/model',records:1,tokens:27}]})
    expect((await get('range=all&device=b&tool=codex')).provenance.totalRecords).toBe(0)
  })

  it('applies date and tool filters to coverage and unpriced models', async () => {
    add('today', {costSource:'unknown',cost:0})
    add('old', {ts:Date.UTC(2026,9,1),costSource:'unknown',model:'old'})
    add('other', {tool:'claude-code',model:'other'})
    const data = await get('from=2026-11-10&to=2026-11-10&tool=codex')
    expect(data.provenance).toMatchObject({totalRecords:1,coverage:0,unpricedModels:[{model:'provider/model',records:1,tokens:24}]})
    expect(data.byTool).toEqual({codex:0})
  })

  it('uses null coverage for an empty set and known zero is fully covered', async () => {
    expect((await get()).provenance).toEqual({ totalRecords:0,knownRecords:0,coverage:null,
      sources:{log:{records:0,cost:0},pricing:{records:0,cost:0},unknown:{records:0,cost:0}},unpricedModels:[] })
    add('free', {cost:0})
    expect((await get()).provenance).toMatchObject({coverage:1,knownRecords:1,unpricedModels:[]})
  })

  it('supports the legacy record-only query when the current device is unavailable', async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await start()
    add('legacy', {costSource:'unknown',cost:0})
    expect((await get()).provenance).toMatchObject({totalRecords:1,coverage:0})
  })
})
