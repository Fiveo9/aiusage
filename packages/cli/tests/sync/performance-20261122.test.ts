import { beforeEach, describe, expect, it, vi } from 'vitest'
import { S3SyncBackend } from '../../src/sync/s3.js'
import { SyncOrchestrator, type SyncBackend } from '../../src/sync/index.js'
import { syncToolCallSnapshots } from '../../src/sync/tool-call-snapshot.js'
import { contentDigest } from '../../src/sync/manifest.js'
import { createDatabase } from '../../src/db/index.js'

const mocks = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }))
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: mocks.send, destroy: mocks.destroy })),
  GetObjectCommand: vi.fn(input => ({ type: 'get', ...input })), PutObjectCommand: vi.fn(input => ({ type: 'put', ...input })),
  HeadObjectCommand: vi.fn(input => ({ type: 'head', ...input })), ListObjectsV2Command: vi.fn(input => ({ type: 'list', ...input })),
  DeleteObjectCommand: vi.fn(input => ({ type: 'delete', ...input })), DeleteObjectsCommand: vi.fn(input => ({ type: 'delete-many', ...input })),
}))
beforeEach(() => { vi.clearAllMocks(); mocks.send.mockReset() })
const backend = () => new S3SyncBackend({ bucket: 'fixture', prefix: 'sync/', accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret' })

describe('F20 S3 resource and listing boundaries', () => {
  it('gets paths and content digests from one paginated listing', async () => {
    mocks.send.mockResolvedValueOnce({ IsTruncated: false, Contents: [
      { Key: 'sync/peer/1.ndjson', ETag: '"' + 'a'.repeat(32) + '"' }, { Key: 'sync/peer/tool-calls.v1.json', ETag: '"' + 'b'.repeat(32) + '"' },
      { Key: 'sync/peer/manifest.json', ETag: '"' + 'c'.repeat(32) + '"' },
    ] })
    const listing = await backend().listFilesWithDigests()
    expect(listing.paths).toEqual(['peer/1.ndjson', 'peer/manifest.json', 'peer/tool-calls.v1.json'])
    expect(listing.digests.get('peer/tool-calls.v1.json')).toBe('b'.repeat(32))
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })

  it('writes namespace manifests as JSON and closes the owned client exactly once', async () => {
    mocks.send.mockResolvedValue({})
    const source = backend()
    await source.writeFile('own/manifest.json', '{}')
    expect(mocks.send.mock.calls[0][0]).toMatchObject({ ContentType: 'application/json' })
    source.close()
    source.close()
    expect(mocks.destroy).toHaveBeenCalledTimes(1)
  })

  it('uses the combined listing in the orchestrator without a second list/digest call', async () => {
    const db = createDatabase(':memory:')
    const list = vi.fn(async () => ({ paths: [], digests: new Map<string, string>() }))
    const source: SyncBackend = { listFiles: vi.fn(async () => { throw new Error('Second listing forbidden') }),
      listFilesWithDigests: list, listFileDigests: vi.fn(async () => { throw new Error('Second digest listing forbidden') }),
      readFile: vi.fn(async () => null), writeFile: vi.fn(async () => {}) }
    try {
      expect((await new SyncOrchestrator(db, source, { deviceInstanceId: 'own-device', target: 'fixture', consentVerified: true }).sync()).status).toBe('ok')
      expect(list).toHaveBeenCalledTimes(1)
    } finally { db.close() }
  })
})

describe('F20 unchanged peer tool-call snapshots', () => {
  const peer = 'peer-device'
  const path = `${peer}/tool-calls.v1.json`
  const snapshot = (name: string) => JSON.stringify({ version: 1, owner: peer,
    calls: [{ id: 'call', recordId: null, tool: 'codex', name, ts: 1, callIndex: 0 }] })

  it('avoids unchanged downloads but reconstructs a cleared local mirror and reads changed content', async () => {
    const db = createDatabase(':memory:')
    let content = snapshot('Read')
    const read = vi.fn(async () => content)
    const source: SyncBackend = { readFile: read, listFiles: async () => [path], writeFile: async () => {} }
    const run = () => syncToolCallSnapshots(db, source, 'fixture', 'own-device', [path], new Map([[path, contentDigest(content)]]), new Map())
    try {
      await run()
      db.prepare('DELETE FROM synced_tool_calls').run()
      await run()
      expect(read).toHaveBeenCalledTimes(1)
      expect(db.prepare('SELECT name FROM synced_tool_calls').get()).toEqual({ name: 'Read' })
      content = snapshot('Write')
      await run()
      expect(read).toHaveBeenCalledTimes(2)
      expect(db.prepare('SELECT name FROM synced_tool_calls').get()).toEqual({ name: 'Write' })
    } finally { db.close() }
  })

  it('does not cache content under a stale listing ETag', async () => {
    const db = createDatabase(':memory:')
    const a = snapshot('Read'), b = snapshot('Write')
    const read = vi.fn().mockResolvedValueOnce(b).mockResolvedValue(a)
    const source: SyncBackend = { readFile: read, listFiles: async () => [path], writeFile: async () => {} }
    const run = () => syncToolCallSnapshots(db, source, 'fixture', 'own-device', [path], new Map([[path, contentDigest(a)]]), new Map())
    try {
      await run()
      await run()
      await run()
      expect(read).toHaveBeenCalledTimes(2)
      expect(db.prepare('SELECT name FROM synced_tool_calls').get()).toEqual({ name: 'Read' })
    } finally { db.close() }
  })
})
