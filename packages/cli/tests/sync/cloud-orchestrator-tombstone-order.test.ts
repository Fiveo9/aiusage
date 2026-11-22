import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { SyncRecord } from '@aiusage/core'
vi.mock('../../src/sync/cloud.js', () => ({ CloudSyncError: class extends Error {}, cloudPull: vi.fn(), cloudPush: vi.fn(async () => ({ inserted: 0, updated: 0, skipped: 0, syncGeneration: 1 })) }))
import { cloudPull } from '../../src/sync/cloud.js'
import { CloudSyncOrchestrator } from '../../src/sync/cloud-orchestrator.js'
import { initializeDatabase } from '../../src/db/index.js'
let db: Database.Database
const record: SyncRecord = { id: 'one', ts: 1000, tool: 'claude-code', model: 'synthetic-model', provider: '', inputTokens: 1, outputTokens: 1,
  cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, cost: 0, costSource: 'unknown', sessionKey: 'synthetic', device: 'Peer', deviceInstanceId: 'peer', updatedAt: 20 }
beforeEach(() => { db = new Database(':memory:'); initializeDatabase(db); vi.mocked(cloudPull).mockReset() })
afterEach(() => db.close())
describe('cross-page tombstone ordering', () => {
  it.each([15, '15'])('keeps a newer live record when an older tombstone is on another page (%s)', async updated_at => {
    vi.mocked(cloudPull).mockResolvedValueOnce({ records: [], tombstones: [{ id: 'one', device_instance_id: 'peer', updated_at }], nextCursor: '1', hasMore: true, syncGeneration: 1 })
      .mockResolvedValueOnce({ records: [record], tombstones: [], hasMore: false, syncGeneration: 1 })
    expect((await new CloudSyncOrchestrator(db, { deviceInstanceId: 'me' }).sync()).status).toBe('ok')
    expect(db.prepare('SELECT id FROM synced_records').all()).toEqual([{ id: 'one' }])
  })
  it.each([20, 25])('still applies a same-or-newer tombstone (%s)', async updated_at => {
    vi.mocked(cloudPull).mockResolvedValue({ records: [record], tombstones: [{ id: 'one', device_instance_id: 'peer', updated_at }], hasMore: false, syncGeneration: 1 })
    expect((await new CloudSyncOrchestrator(db, { deviceInstanceId: 'me' }).sync()).status).toBe('ok')
    expect(db.prepare('SELECT id FROM synced_records').all()).toEqual([])
  })
})
