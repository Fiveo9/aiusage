import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { StatsRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { getUnsyncedRecords, insertRecord } from '../../src/db/records.js'
import { SyncOrchestrator } from '../../src/sync/index.js'
import { mapStatsRecordToSyncRecord } from '../../src/sync/mapper.js'
import { serializeSnapshot } from '../../src/sync/manifest.js'
import { FakeSyncBackend } from './helpers/fake-backend.js'

const TARGET = 'synthetic-target'
function record(id = 'local', owner = 'own', inputTokens = 1): StatsRecord {
  return { id, ts: 1000, ingestedAt: 1000, updatedAt: 1000, lineOffset: 0, tool: 'claude-code', model: 'synthetic', provider: 'synthetic',
    inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, cost: 0, costSource: 'unknown',
    sessionId: 's', sourceFile: 'synthetic.jsonl', device: 'Synthetic', deviceInstanceId: owner }
}
describe('review file sync consistency boundaries', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })
  afterEach(() => { db.close(); vi.restoreAllMocks() })
  const sync = (backend: FakeSyncBackend) => new SyncOrchestrator(db, backend, { target: TARGET, deviceInstanceId: 'own', consentVerified: true }).sync()
  it('does not acknowledge or clear retirements when flush fails', async () => {
    insertRecord(db, record())
    db.prepare('INSERT INTO sync_retired_wire_ids VALUES (?, ?)').run(TARGET, 'retired-before')
    const backend = new FakeSyncBackend()
    backend.flush = async () => { throw new Error('synthetic flush failure') }
    expect((await sync(backend)).status).toBe('failed')
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_record_state').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT wire_id FROM sync_retired_wire_ids').all()).toEqual([{ wire_id: 'retired-before' }])
  })
  it('acknowledges only the version read for the upload, not an edit during I/O', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    insertRecord(db, record())
    const backend = new FakeSyncBackend()
    const write = backend.writeFile.bind(backend)
    let edited = false
    backend.writeFile = async (path, content) => {
      await write(path, content)
      if (!edited && path.endsWith('.ndjson')) {
        edited = true
        insertRecord(db, record('local', 'own', 2))
        clock.mockReturnValue(3000)
      }
    }
    expect((await sync(backend)).status).toBe('ok')
    expect(getUnsyncedRecords(db, TARGET, 'own').map(row => row.inputTokens)).toEqual([2])
  })
  it('keeps retirements created after the uploaded snapshot was read', async () => {
    insertRecord(db, record())
    db.prepare('INSERT INTO sync_retired_wire_ids VALUES (?, ?)').run(TARGET, 'before')
    const backend = new FakeSyncBackend()
    const write = backend.writeFile.bind(backend)
    let queued = false
    backend.writeFile = async (path, content) => {
      await write(path, content)
      if (!queued) { queued = true; db.prepare('INSERT INTO sync_retired_wire_ids VALUES (?, ?)').run(TARGET, 'later') }
    }
    expect((await sync(backend)).status).toBe('ok')
    expect(db.prepare('SELECT wire_id FROM sync_retired_wire_ids').all()).toEqual([{ wire_id: 'later' }])
  })
  it('accepts a completed no-op flush result rather than treating false as a failure', async () => {
    insertRecord(db, record())
    const backend = new FakeSyncBackend()
    backend.flush = async () => false
    expect((await sync(backend)).status).toBe('ok')
    expect(getUnsyncedRecords(db, TARGET, 'own')).toEqual([])
  })
  it('does not acknowledge the local row that lost a wire-id collision', async () => {
    insertRecord(db, { ...record('older'), tool: 'codex', updatedAt: 1000 })
    insertRecord(db, { ...record('newer'), tool: 'codex', updatedAt: 2000 })
    const result = await sync(new FakeSyncBackend())
    expect(result.status).toBe('ok')
    expect(result.collisionCount).toBe(1)
    expect(result.uploadedCount).toBe(1)
    expect(getUnsyncedRecords(db, TARGET, 'own').map(row => row.id)).toEqual(['older'])
  })
  it('isolates a malformed peer record and still imports a healthy namespace', async () => {
    const backend = new FakeSyncBackend()
    const bad = { ...mapStatsRecordToSyncRecord(record('bad-record', 'bad')) } as Record<string, unknown>
    delete bad.provider
    backend.files.set('bad/1970/01/01.ndjson', JSON.stringify(bad) + '\n')
    backend.files.set('good/1970/01/01.ndjson', serializeSnapshot([mapStatsRecordToSyncRecord(record('good-record', 'good'))]))
    const result = await sync(backend)
    expect(result.status).toBe('ok')
    expect(result.pulledCount).toBe(1)
    expect(db.prepare("SELECT device_instance_id FROM synced_records WHERE device_instance_id = 'good'").get()).toEqual({ device_instance_id: 'good' })
  })
})
