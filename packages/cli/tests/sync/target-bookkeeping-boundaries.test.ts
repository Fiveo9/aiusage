import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { StatsRecord, SyncRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'
import { insertSyncedRecord } from '../../src/db/synced-records.js'
import { countSyncTargetBookkeeping, forgetSyncTargetBookkeeping } from '../../src/db/sync-claims.js'
import { applyLocalRepair, forgetSyncTarget, planLocalRepair, repairSyncContamination } from '../../src/sync/repair.js'
import { normalizeS3Prefix, getSyncTarget } from '../../src/sync/target.js'
import { buildConsentConfig } from '../../src/config.js'
import { serializeSnapshot } from '../../src/sync/manifest.js'
import { FakeSyncBackend } from './helpers/fake-backend.js'

const aws = vi.hoisted(() => ({ send: vi.fn(), create: vi.fn() }))
vi.mock('@aws-sdk/client-s3', () => {
  class Command { constructor(public input: unknown) {} }
  return { S3Client: class { constructor(config: unknown) { aws.create(config) }; send = aws.send },
    GetObjectCommand: Command, PutObjectCommand: Command, HeadObjectCommand: Command, ListObjectsV2Command: Command,
    DeleteObjectCommand: Command, DeleteObjectsCommand: Command }
})
const { S3SyncBackend } = await import('../../src/sync/s3.js')
const root = mkdtempSync(join(tmpdir(), 'aiusage-target-boundaries-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const local = (id: string, owner = 'own'): StatsRecord => ({ id, ts: 1000, ingestedAt: 1000, updatedAt: 1000, lineOffset: 0,
  tool: 'codex', model: 'synthetic', provider: 'synthetic', inputTokens: 1, outputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, thinkingTokens: 0, cost: 0, costSource: 'unknown', sessionId: id, sourceFile: `${id}.jsonl`, device: owner, deviceInstanceId: owner })
const remote = (id: string): SyncRecord => ({ ...local(id, 'good'), sessionKey: id })
const s3 = () => new S3SyncBackend({ bucket: 'synthetic', prefix: 'aiusage/', accessKeyId: 'synthetic-only', secretAccessKey: 'synthetic-only' })

describe('review target and repair bookkeeping', () => {
  let db: Database.Database
  beforeEach(() => { db = new Database(':memory:'); initializeDatabase(db); vi.clearAllMocks(); vi.stubEnv('AIUSAGE_S3_PROXY', '') })
  afterEach(() => { db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it.each([['', ''], ['///', ''], ['///team///', 'team/'], [undefined, 'aiusage/']])('canonicalizes S3 prefix %j', (value, expected) => {
    expect(normalizeS3Prefix(value)).toBe(expected)
  })
  it('uses one canonical S3 location for consent, target identity and backend', () => {
    const raw = { sync: { backend: 's3' as const, bucket: 'synthetic', prefix: '/team///', endpoint: ' https://S3.Amazonaws.com:443/ ' } }
    const canonical = { sync: { backend: 's3' as const, bucket: 'synthetic', prefix: 'team/' } }
    expect(getSyncTarget(raw.sync)).toBe(getSyncTarget(canonical.sync))
    expect(buildConsentConfig(raw)).toEqual(buildConsentConfig(canonical))
    const backend = new S3SyncBackend({ ...raw.sync, accessKeyId: 'synthetic-only', secretAccessKey: 'synthetic-only' })
    expect(backend.getObjectKey('owner/day.ndjson')).toBe('team/owner/day.ndjson')
    expect(aws.create.mock.calls[0][0].endpoint).toBeUndefined()
  })
  it.each(['../outside.ndjson', 'owner\\outside.ndjson', 'owner/\u0000outside.ndjson', 'C:/outside.ndjson'])('rejects unsafe S3 wire path %j before requests', async path => {
    await expect(s3().readFile(path)).rejects.toThrow()
    expect(aws.send).not.toHaveBeenCalled()
  })
  it('does not turn an unsafe S3 data listing into an authoritative absence', async () => {
    aws.send.mockResolvedValueOnce({ IsTruncated: false, Contents: [{ Key: 'aiusage/owner\\bad/day.ndjson' }] })
    await expect(s3().listFiles()).rejects.toThrow()
  })
  it('counts and forgets a target held only by tool-call snapshots', () => {
    db.exec("INSERT INTO synced_tool_calls VALUES ('synthetic', 'peer', 'call', NULL, 'codex', 'Read', 1000, 0)")
    expect(countSyncTargetBookkeeping(db, 'synthetic')).toMatchObject({ toolCallRows: 1 })
    const report = forgetSyncTarget(db, { aiusageDir: root, target: 'synthetic', currentTarget: 'other', apply: true })
    expect(report.bookkeeping).toMatchObject({ toolCallRows: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM synced_tool_calls').get()).toEqual({ n: 0 })
    expect(forgetSyncTargetBookkeeping(db, 'synthetic')).toMatchObject({ toolCallRows: 0 })
  })
  it('reports actual stale state rows across multiple targets without counting rows that have no state', () => {
    for (const row of [local('local'), local('reflag', 'good'), local('no-state', 'good'), local('synced', 'good')]) insertRecord(db, row)
    db.exec("UPDATE records SET origin = 'synced' WHERE id = 'synced'; INSERT INTO sync_record_state VALUES ('local', 'a', 1), ('reflag', 'a', 1), ('reflag', 'b', 1), ('reflag', 'c', 1), ('synced', 'a', 1)")
    const plan = planLocalRepair(db, 'own')
    expect(plan.staleSyncStateCount).toBe(4)
    applyLocalRepair(db, plan)
    expect(db.prepare('SELECT record_id FROM sync_record_state').all()).toEqual([{ record_id: 'local' }])
  })
  it.each([false, true])('does not verify a record from a foreign namespace (malformed peer: %j)', async malformed => {
    insertSyncedRecord(db, remote('missing'))
    db.exec("UPDATE synced_records SET unclaimed_since = 0")
    const backend = new FakeSyncBackend()
    backend.files.set('good/manifest.json', '{"version":1,"files":{}}')
    backend.files.set('bad/1970/01/01.ndjson', serializeSnapshot([remote('missing')]) + (malformed ? '{bad}\n' : ''))
    const report = await repairSyncContamination(db, { deviceInstanceId: 'own', backend })
    expect(report.local.orphanedSyncedIds).toEqual(['missing'])
  })
  it('keeps a record actually present in its verified owner namespace', async () => {
    insertSyncedRecord(db, remote('present'))
    db.exec('UPDATE synced_records SET unclaimed_since = 0')
    const backend = new FakeSyncBackend()
    backend.files.set('good/1970/01/01.ndjson', serializeSnapshot([remote('present')]))
    expect((await repairSyncContamination(db, { deviceInstanceId: 'own', backend })).local.orphanedSyncedIds).toEqual([])
  })
  it('preserves unknown presence when a missing peer manifest cannot be read', async () => {
    insertSyncedRecord(db, remote('unknown'))
    db.exec('UPDATE synced_records SET unclaimed_since = 0')
    const backend = new FakeSyncBackend()
    backend.readFile = async () => { throw new Error('synthetic read failure') }
    const report = await repairSyncContamination(db, { deviceInstanceId: 'own', backend })
    expect(report.local.orphanedSyncedIds).toEqual([])
  })
})
