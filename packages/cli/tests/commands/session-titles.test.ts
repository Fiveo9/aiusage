import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMigrations } from '../../src/db/migrations/index.js'
import { migrateV19 } from '../../src/db/migrations/v19.js'
import { insertRecord, getRecordById } from '../../src/db/records.js'
import { getSyncedRecordById, insertSyncedRecord, mergeSyncedRecordsIntoRecords } from '../../src/db/synced-records.js'
import { getSessionTitle } from '../../src/db/session-titles.js'
import { backfillSessionTitles, titleFromMetadata } from '../../src/commands/session-titles.js'
import { mapStatsRecordToSyncRecord } from '../../src/sync/mapper.js'
import { toCloudRecord, fromCloudRecord } from '../../src/sync/cloud-dto.js'
import { parseSyncRecordLine } from '../../src/sync/manifest.js'
import { createApiServer } from '../../src/api/server.js'
import type { StatsRecord } from '@aiusage/core'

vi.mock('../../src/config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/config.js')>(), loadConfig: () => null,
}))
vi.mock('../../src/auth.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/auth.js')>(), getDashboardPassword: () => undefined,
}))

const fixtureRoot = fileURLToPath(new URL('../../../../backups/session-title-checks-20261120', import.meta.url))
let db: Database.Database
let fixtureDir: string
beforeEach(() => {
  mkdirSync(fixtureRoot, { recursive: true })
  fixtureDir = mkdtempSync(join(fixtureRoot, 'case-'))
  db = new Database(':memory:')
  runMigrations(db)
})
afterEach(() => db.close())

function record(overrides: Partial<StatsRecord> = {}): StatsRecord {
  return {
    id: 'r1', ts: 1700000000000, ingestedAt: 10, updatedAt: 10, lineOffset: 0,
    tool: 'codex', model: 'gpt-6-astra', provider: 'openai', inputTokens: 100, outputTokens: 20,
    cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, cost: 1, costSource: 'pricing',
    sessionId: 'session-1', sourceFile: join(fixtureDir, 'source.jsonl'), device: 'desktop',
    deviceInstanceId: 'device-a', origin: 'local', ...overrides,
  }
}
function file(name: string, content: string): string {
  const path = join(fixtureDir, name)
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

describe('stored session titles', () => {
  it.each([10, 9000])('fills a legacy merged title when its usage version is %s without rewriting usage', version => {
    const sync = mapStatsRecordToSyncRecord(record({ sessionTitle: '已同步的真实标题' }))
    insertSyncedRecord(db, sync)
    mergeSyncedRecordsIntoRecords(db, 'receiver')
    db.prepare("UPDATE records SET session_title = '', updated_at = ?, cost = 9 WHERE id = ?").run(version, sync.id)
    mergeSyncedRecordsIntoRecords(db, 'receiver')
    expect(getSessionTitle(db, sync.sessionKey, 'device-a')).toBe('已同步的真实标题')
    expect(getRecordById(db, sync.id)).toMatchObject({ sessionTitle: '已同步的真实标题', inputTokens: 100, cost: 9, updatedAt: version })
  })

  it('does not repair local/own records from remote metadata or erase titles from an empty payload', () => {
    const sync = mapStatsRecordToSyncRecord(record({ sessionTitle: '远端标题' }))
    insertSyncedRecord(db, sync)
    insertRecord(db, record({ id: sync.id, sessionTitle: '本机标题', origin: 'local' }))
    mergeSyncedRecordsIntoRecords(db, 'receiver')
    expect(getRecordById(db, sync.id)?.sessionTitle).toBe('本机标题')
    db.prepare("UPDATE records SET origin = 'synced', session_title = '本设备副本' WHERE id = ?").run(sync.id)
    mergeSyncedRecordsIntoRecords(db, 'device-a')
    expect(getRecordById(db, sync.id)?.sessionTitle).toBe('本设备副本')
    db.prepare("UPDATE synced_records SET session_title = '' WHERE id = ?").run(sync.id)
    mergeSyncedRecordsIntoRecords(db, 'receiver')
    expect(getRecordById(db, sync.id)?.sessionTitle).toBe('本设备副本')
  })

  it('creates the schema and remains idempotent', () => {
    insertRecord(db, record())
    runMigrations(db)
    expect(getRecordById(db, 'r1')).toMatchObject({ inputTokens: 100, cost: 1, sessionTitle: undefined })
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({ version: 20 })
  })

  it('adds titles to pre-title tables without changing existing records', () => {
    const old = new Database(':memory:')
    try {
      old.exec(`CREATE TABLE records (id TEXT, device_instance_id TEXT, session_id TEXT, tool TEXT, updated_at INTEGER, input_tokens INTEGER);
        CREATE TABLE synced_records (id TEXT, device_instance_id TEXT, session_key TEXT, tool TEXT, updated_at INTEGER);
        CREATE TABLE schema_version (version INTEGER);
        INSERT INTO records VALUES ('old', 'device-a', 's', 'codex', 10, 123);
        INSERT INTO synced_records VALUES ('remote', 'device-b', 'key', 'codex', 10);`)
      old.transaction(() => migrateV19(old))()
      expect(old.prepare('SELECT input_tokens, session_title FROM records').get()).toEqual({ input_tokens: 123, session_title: '' })
      expect(old.prepare('SELECT session_title FROM synced_records').get()).toEqual({ session_title: '' })
      expect(old.prepare('SELECT * FROM activity_session_titles').all()).toEqual([])
    } finally { old.close() }
  })

  it('keeps a known title on ordinary reparses and versions actual renames', () => {
    insertRecord(db, record({ sessionTitle: '原始标题', syncedAt: 100 }))
    insertRecord(db, record({ updatedAt: 20 }))
    expect(getRecordById(db, 'r1')).toMatchObject({ sessionTitle: '原始标题', updatedAt: 10 })
    insertRecord(db, record({ sessionTitle: '新标题', updatedAt: 30 }))
    expect(getRecordById(db, 'r1')).toMatchObject({ sessionTitle: '新标题', updatedAt: 101 })
  })

  it('carries titles through file/cloud wire formats, pulled rows and merged rows', () => {
    const sync = mapStatsRecordToSyncRecord(record({ sessionTitle: '真实标题 / 😀' }))
    expect(parseSyncRecordLine(JSON.stringify(sync))?.sessionTitle).toBe('真实标题 / 😀')
    expect(fromCloudRecord(toCloudRecord(sync))?.sessionTitle).toBe('真实标题 / 😀')
    insertSyncedRecord(db, sync)
    mergeSyncedRecordsIntoRecords(db, 'receiver')
    expect(getRecordById(db, sync.id)?.sessionTitle).toBe('真实标题 / 😀')
    insertSyncedRecord(db, { ...sync, sessionTitle: undefined, updatedAt: 20 })
    mergeSyncedRecordsIntoRecords(db, 'receiver')
    expect(getSyncedRecordById(db, sync.id)?.sessionTitle).toBe('真实标题 / 😀')
    expect(getRecordById(db, sync.id)?.sessionTitle).toBe('真实标题 / 😀')
    insertSyncedRecord(db, { ...sync, sessionTitle: '重命名', updatedAt: 30 })
    mergeSyncedRecordsIntoRecords(db, 'receiver')
    expect(getSessionTitle(db, sync.sessionKey, 'device-a')).toBe('重命名')
  })
})

describe('source metadata backfill', () => {
  it('reads Codex indexes for old timestamp-prefixed IDs, detects renames and leaves other devices alone', async () => {
    const id = '019abcde-1234-5678-90ab-1234567890ab'
    const source = file(`codex/sessions/2026/11/20/rollout-${id}.jsonl`, '')
    const index = file('codex/session_index.jsonl', JSON.stringify({ id, thread_name: '真实标题' }) + '\n')
    insertRecord(db, record({ sourceFile: source, sessionId: `2026-11-20T01-02-03-${id}`, syncedAt: 9999999999999 }))
    insertRecord(db, record({ id: 'remote', sourceFile: source, sessionId: id, deviceInstanceId: 'remote', origin: 'synced' }))
    expect(await backfillSessionTitles(db, 'device-a')).toBe(1)
    expect(getRecordById(db, 'r1')).toMatchObject({ sessionTitle: '真实标题', updatedAt: 10000000000000 })
    expect(getRecordById(db, 'remote')?.sessionTitle).toBeUndefined()
    expect(await backfillSessionTitles(db, 'device-a')).toBe(0)
    appendFileSync(index, JSON.stringify({ id, thread_name: '重命名后的会话' }) + '\n')
    expect(await backfillSessionTitles(db, 'device-a')).toBe(1)
    expect(getRecordById(db, 'r1')?.sessionTitle).toBe('重命名后的会话')
  })

  it('prefers Claude custom titles to the saved index summary and never uses prompt text', async () => {
    const source = file('claude/projects/demo/session-1.jsonl', [
      { type: 'user', sessionId: 'session-1', message: { content: 'Not a title' } },
      { type: 'summary', sessionId: 'session-1', summary: 'Not a title either' },
      { type: 'custom-title', sessionId: 'session-1', customTitle: '明确自定义标题' },
    ].map(row => JSON.stringify(row)).join('\n'))
    file('claude/projects/demo/sessions-index.json', JSON.stringify({ entries: [{ sessionId: 'session-1', summary: '索引标题' }] }))
    insertRecord(db, record({ sourceFile: source, tool: 'claude-code' }))
    await backfillSessionTitles(db, 'device-a')
    expect(getRecordById(db, 'r1')?.sessionTitle).toBe('明确自定义标题')
    expect(titleFromMetadata('claude-code', { type: 'user', sessionId: 's', message: 'hello' })).toBeUndefined()
    expect(titleFromMetadata('codex', { type: 'response_item', title: 'not metadata' })).toBeUndefined()
  })

  it.each(['opencode', 'kilocode', 'hermes'] as const)('reads %s database titles even when no new usage is imported', async tool => {
    const path = join(fixtureDir, 'source.db')
    const source = new Database(path)
    const table = tool === 'hermes' ? 'sessions' : 'session'
    source.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, title TEXT)`)
    source.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run('session-1', '原生标题 / 保留标点')
    source.close()
    insertRecord(db, record({ tool, sourceFile: tool === 'hermes' ? `${path}:session:session-1:旧路径标题` : path }))
    await backfillSessionTitles(db, 'device-a')
    expect(getRecordById(db, 'r1')?.sessionTitle).toBe('原生标题 / 保留标点')
  })

  it('uses cached title metadata for newly imported records and tolerates missing sources', async () => {
    const source = file('codex/sessions/rollout-session-1.jsonl', '')
    file('codex/session_index.jsonl', JSON.stringify({ id: 'session-1', thread_name: '已缓存标题' }))
    insertRecord(db, record({ sourceFile: source }))
    await backfillSessionTitles(db, 'device-a')
    insertRecord(db, record({ id: 'r2', sourceFile: source }))
    expect(await backfillSessionTitles(db, 'device-a')).toBe(1)
    expect(getRecordById(db, 'r2')?.sessionTitle).toBe('已缓存标题')
    insertRecord(db, record({ id: 'missing', sourceFile: join(fixtureDir, 'missing/sessions/no.jsonl') }))
    expect(await backfillSessionTitles(db, 'device-a')).toBe(0)
    expect(getRecordById(db, 'missing')?.sessionTitle).toBeUndefined()
  })
})

describe('session API titles', () => {
  it('returns titles for lists, details and project sessions without mixing devices or changing totals', async () => {
    insertRecord(db, record({ sessionTitle: '本机标题', cwd: '/workspace/demo' }))
    insertRecord(db, record({ id: 'remote', sessionTitle: '远端标题', deviceInstanceId: 'remote', origin: 'synced' }))
    const server = createApiServer(db, { currentDeviceInstanceId: 'device-a' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as { port: number }
      const fetchJson = async (path: string) => {
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`)
        expect(response.status).toBe(200)
        return response.json()
      }
      const list = await fetchJson('/api/sessions?range=all')
      expect(list.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ deviceInstanceId: 'device-a', sessionTitle: '本机标题', inputTokens: 100, cost: 1 }),
        expect.objectContaining({ deviceInstanceId: 'remote', sessionTitle: '远端标题' }),
      ]))
      const detail = await fetchJson('/api/sessions/session-1?device=remote')
      expect(detail.session.sessionTitle).toBe('远端标题')
      const projects = await fetchJson('/api/projects/sessions?name=demo&range=all&device=device-a')
      expect(projects.sessions[0].sessionTitle).toBe('本机标题')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
