import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { SyncRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { parseManifest, parseSyncRecordLine } from '../../src/sync/manifest.js'
import { listedOwners, planNamespaceRead, readNamespaceSnapshot } from '../../src/sync/snapshot.js'
import { cloudRecordProblem, fromCloudRecord, toCloudRecord } from '../../src/sync/cloud-dto.js'
import { syncToolCallSnapshots } from '../../src/sync/tool-call-snapshot.js'
import { FakeSyncBackend } from './helpers/fake-backend.js'

const record: SyncRecord = { id: 'synthetic', ts: 1000, updatedAt: 1000, tool: 'claude-code', model: 'synthetic', provider: 'synthetic',
  inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0,
  cost: 0, costSource: 'unknown', sessionKey: 's', device: 'Synthetic', deviceInstanceId: 'owner' }
afterEach(() => vi.restoreAllMocks())

describe('review sync input boundaries', () => {
  it.each(['owner\\part', 'owner\u0000part', 'owner/part', '..'])('rejects unsafe deviceInstanceId %s on both cloud directions', deviceInstanceId => {
    const wire = toCloudRecord({ ...record, deviceInstanceId })
    expect(cloudRecordProblem(wire)).toBe('invalid_value')
    expect(fromCloudRecord(wire)).toBeNull()
  })
  it('retains the existing nullable cloud cost/device fallback and valid zero timestamp', () => {
    const wire = { ...toCloudRecord(record), ts: 0, cost: null, costSource: null, deviceName: null, device: 'Legacy' }
    expect(fromCloudRecord(wire)).toMatchObject({ ts: 0, cost: 0, costSource: 'unknown', device: 'Legacy' })
  })
  it.each(['2026\\01\\01.ndjson', '2026/\u0000bad.ndjson', 'C:/escape.ndjson', '../escape.ndjson'])('rejects unsafe manifest relative path %s', path => {
    expect(parseManifest(JSON.stringify({ version: 1, files: { [path]: { digest: '0'.repeat(32), records: 0 } } }))).toBeNull()
  })
  it('never reads an unsafe owner manifest path', async () => {
    const backend = new FakeSyncBackend()
    const read = vi.spyOn(backend, 'readFile')
    const plan = await planNamespaceRead(backend, '..', [])
    expect(plan.reliable).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })
  it('keeps an unsafe listed namespace unreliable instead of treating it as absent', async () => {
    const backend = new FakeSyncBackend()
    const read = vi.spyOn(backend, 'readFile')
    const paths = ['owner/../escape.ndjson']
    expect(listedOwners(paths)).toEqual(['owner'])
    const snapshot = await readNamespaceSnapshot(backend, 'owner', paths)
    expect(snapshot.reliable).toBe(false)
    expect(snapshot.files.size).toBe(0)
    expect(read.mock.calls.map(call => call[0])).toEqual(['owner/manifest.json'])
  })
  it.each([
    { ...record, ts: 'not-a-time' },
    { ...record, updatedAt: 1e100 },
    { ...record, provider: 7 },
    { ...record, inputTokens: null },
  ])('does not pass malformed mandatory fields through to SQLite: %j', value => {
    expect(parseSyncRecordLine(JSON.stringify(value))).toBeNull()
  })
  it('accepts a valid legacy ISO timestamp and zero counters', () => {
    expect(parseSyncRecordLine(JSON.stringify({ ...record, ts: '1970-01-01T00:00:01.000Z', inputTokens: 0 }))).toMatchObject({ ts: 1000, inputTokens: 0 })
  })
  it('reports a peer read failure as unreliable without pretending the file is missing', async () => {
    const backend = new FakeSyncBackend()
    const path = 'owner/1970/01/01.ndjson'
    backend.files.set(path, JSON.stringify(record) + '\n')
    const read = backend.readFile.bind(backend)
    backend.readFile = async candidate => candidate === path ? Promise.reject(new Error('synthetic peer read failure')) : read(candidate)
    const snapshot = await readNamespaceSnapshot(backend, 'owner', [path])
    expect(snapshot.reliable).toBe(false)
    expect(snapshot.missing).toEqual([])
    expect(snapshot.problems.length).toBeGreaterThan(0)
  })
  it('isolates a malformed tool-call peer and preserves its previous rows while accepting a healthy peer', async () => {
    const db = new Database(':memory:')
    try {
      initializeDatabase(db)
      db.exec("INSERT INTO synced_tool_calls VALUES ('synthetic', 'bad', 'previous', NULL, 'codex', 'Read', 1000, 0)")
      const backend = new FakeSyncBackend()
      backend.files.set('bad/tool-calls.v1.json', '{"version":1,"owner":"bad","calls":null}')
      backend.files.set('good/tool-calls.v1.json', JSON.stringify({ version: 1, owner: 'good', calls: [{ id: 'healthy', recordId: null, tool: 'codex', name: 'Read', ts: 1000, callIndex: 0 }] }))
      await syncToolCallSnapshots(db, backend, 'synthetic', 'own', [...backend.files.keys()], undefined, new Map())
      expect(db.prepare('SELECT owner, id FROM synced_tool_calls ORDER BY owner').all()).toEqual([{ owner: 'bad', id: 'previous' }, { owner: 'good', id: 'healthy' }])
    } finally { db.close() }
  })
})
