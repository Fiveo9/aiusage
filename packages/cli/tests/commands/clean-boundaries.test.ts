import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { generateRecordId, type StatsRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'
import { cleanAll, cleanOldData, propagateClean } from '../../src/commands/clean.js'
import { mapStatsRecordToSyncRecord } from '../../src/sync/mapper.js'
import { serializeSnapshot } from '../../src/sync/manifest.js'
import { FakeSyncBackend } from '../sync/helpers/fake-backend.js'

const state = vi.hoisted(() => ({ backend: null as FakeSyncBackend | null }))
vi.mock('../../src/config.js', async () => ({
  ...await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js'),
  loadConfig: () => ({ sync: { backend: 's3', bucket: 'synthetic-only' } }),
}))
vi.mock('../../src/commands/sync.js', () => ({ createBackend: () => state.backend }))

const NOW = Date.UTC(2026, 0, 3)
const DAY = 86_400_000
function record(id: string, ts: number): StatsRecord {
  return { id, ts, ingestedAt: ts, updatedAt: ts, lineOffset: 0, tool: 'claude-code', model: 'synthetic', provider: 'synthetic',
    inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0,
    cost: 0, costSource: 'unknown', sessionId: id, sourceFile: 'synthetic.jsonl', device: 'Synthetic', deviceInstanceId: 'owner' }
}

describe('review clean completeness', () => {
  let db: Database.Database
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    db = new Database(':memory:')
    initializeDatabase(db)
    state.backend = new FakeSyncBackend()
  })
  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })
  const count = (db: Database.Database, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  function seed(): void {
    insertRecord(db, record('local-old', NOW - 3 * DAY))
    insertRecord(db, record('local-new', NOW))
    const insert = db.prepare(`INSERT INTO synced_records (id, ts, tool, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens,
      updated_at, session_key, source_file, cwd, device, device_instance_id, platform)
      VALUES (?, ?, 'claude-code', 'synthetic', 'synthetic', 1, 0, 0, 0, 0, ?, ?, 'synthetic.jsonl', '', 'Synthetic', 'owner', '')`)
    insert.run('remote-old', NOW - 3 * DAY, NOW, 'remote-old')
    insert.run('remote-new', NOW, NOW, 'remote-new')
    const call = db.prepare("INSERT INTO synced_tool_calls VALUES ('synthetic', 'owner', ?, ?, 'claude-code', 'Read', ?, 0)")
    call.run('old-orphan', null, NOW - 3 * DAY)
    call.run('new-orphan', null, NOW)
    call.run('old-parent', 'remote-old', NOW)
    call.run('retained-parent', 'remote-new', NOW - 3 * DAY)
    call.run('dangling', 'missing-parent', NOW)
    db.exec("INSERT INTO pending_cost_recalc VALUES ('local-old'), ('local-new'); INSERT INTO session_title_sources VALUES ('synthetic.jsonl', 'signature', '{}');")
  }
  it('cleans expired/suspended auxiliary rows without losing retained records or their calls', () => {
    seed()
    cleanOldData(db, 1)
    expect(db.prepare('SELECT id FROM records').all()).toEqual([{ id: 'local-new' }])
    expect(db.prepare('SELECT id FROM synced_records').all()).toEqual([{ id: 'remote-new' }])
    expect(db.prepare('SELECT id FROM synced_tool_calls ORDER BY id').all()).toEqual([{ id: 'new-orphan' }, { id: 'retained-parent' }])
    expect(db.prepare('SELECT record_id FROM pending_cost_recalc').all()).toEqual([{ record_id: 'local-new' }])
    expect(count(db, 'session_title_sources')).toBe(0)
  })
  it('cleanAll clears all three auxiliary tables', () => {
    seed()
    cleanAll(db)
    for (const table of ['records', 'synced_records', 'synced_tool_calls', 'session_title_sources', 'pending_cost_recalc']) expect(count(db, table)).toBe(0)
  })
  it.each(['old', 'all'])('rolls every SQL cleanup back on a later auxiliary-table failure (%s)', mode => {
    seed()
    db.exec("CREATE TRIGGER synthetic_cleanup_failure BEFORE DELETE ON synced_tool_calls BEGIN SELECT RAISE(ABORT, 'synthetic cleanup failure'); END;")
    expect(() => mode === 'old' ? cleanOldData(db, 1) : cleanAll(db)).toThrow('synthetic cleanup failure')
    expect(count(db, 'records')).toBe(2)
    expect(count(db, 'synced_records')).toBe(2)
    expect(count(db, 'synced_tool_calls')).toBe(5)
    expect(count(db, 'pending_cost_recalc')).toBe(2)
    expect(count(db, 'session_title_sources')).toBe(1)
  })
  it('propagates beforeDays=0 to the synthetic file backend and flushes it', async () => {
    const path = 'owner/2026/01/01.ndjson'
    const row = { ...record(generateRecordId('owner', 'synthetic', 0), NOW - 2 * DAY) }
    state.backend!.files.set(path, serializeSnapshot([mapStatsRecordToSyncRecord(row)]))
    const result = await propagateClean({ all: false, beforeDays: 0 })
    expect(result.backends).toHaveLength(1)
    expect(result.backends[0].status).toBe('ok')
    expect(state.backend!.files.has(path)).toBe(false)
    expect(state.backend!.flushCount).toBe(1)
  })
})
