import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { S3Client } from '@aws-sdk/client-s3'
import { type AddressInfo } from 'node:net'
import { createApiServer } from '../../src/api/server.js'
import { initializeDatabase } from '../../src/db/index.js'
import { SyncOrchestrator } from '../../src/sync/index.js'
import { S3SyncBackend } from '../../src/sync/s3.js'
import { contentDigest } from '../../src/sync/manifest.js'

describe('cross-device activity drilldown', () => {
  const databases: Database.Database[] = []
  function device() {
    const db = new Database(':memory:')
    databases.push(db)
    initializeDatabase(db)
    return db
  }
  afterEach(() => {
    vi.restoreAllMocks()
    for (const db of databases.splice(0)) db.close()
  })

  it('backfills calls after usage publication and pages through project → session and tool → event', async () => {
    const objects = new Map<string, string>()
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: any) => {
      const { Key, Body } = command.input
      switch (command.constructor.name) {
        case 'ListObjectsV2Command': return { IsTruncated: false, Contents: [...objects].map(([Key, body]) => ({ Key, ETag: contentDigest(body) })) }
        case 'PutObjectCommand': objects.set(Key, Body); return {}
        case 'GetObjectCommand': {
          const body = objects.get(Key)
          if (body === undefined) throw Object.assign(new Error('Missing object'), { name: 'NoSuchKey' })
          return { Body: { transformToString: async () => body } }
        }
        default: throw new Error('Unexpected object operation')
      }
    })
    const backend = new S3SyncBackend({ bucket: 'test', prefix: 'usage/', accessKeyId: '', secretAccessKey: '' })
    const sync = (db: Database.Database, owner: string) => new SyncOrchestrator(db, backend, {
      deviceInstanceId: owner, target: 's3:test', consentVerified: true,
    }).sync()
    const sender = device(), orphanSender = device(), receiver = device()
    const now = Date.now()
    for (let index = 0; index < 33; index++) {
      sender.prepare(`INSERT INTO records (id, ts, ingested_at, updated_at, line_offset, tool, model, provider, input_tokens, cost,
        session_id, source_file, cwd, device, device_instance_id) VALUES (?, ?, ?, ?, ?, 'claude-code', 'model', 'provider', 2, 1,
        'session/one', ?, '/home/test/Projects/example', 'source', 'source')`)
        .run(`local-${index}`, now, now, now, index, index % 2 === 0 ? 'first.jsonl' : 'second.jsonl')
    }
    expect(await sync(sender, 'source')).toMatchObject({ status: 'ok', uploadedCount: 33 })
    const call = `INSERT INTO tool_calls (id, record_id, tool, name, ts, call_index) VALUES (?, ?, 'claude-code', 'Read', ?, ?)`
    sender.prepare(call).run('same-id', 'local-0', now, 0)
    sender.prepare(call).run('another-id', 'local-0', now, 1)
    orphanSender.prepare(call).run('same-id', null, now, 0)
    orphanSender.prepare(call).run('old', null, Date.UTC(2020, 0, 1), 0)
    expect(await sync(sender, 'source')).toMatchObject({ status: 'ok', uploadedCount: 0, writtenFiles: 1 })
    expect(await sync(orphanSender, 'other')).toMatchObject({ status: 'ok' })
    expect(await sync(receiver, 'receiver')).toMatchObject({ status: 'ok', mergedCount: 33 })
    expect(await sync(receiver, 'receiver')).toMatchObject({ status: 'ok', mergedCount: 0, writtenFiles: 0 })
    expect(objects.has('usage/receiver/tool-calls.v1.json')).toBe(false)
    const server = createApiServer(receiver, { currentDeviceInstanceId: 'receiver' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const get = async (route: string) => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/${route}`)
      expect(response.status).toBe(200)
      return response.json()
    }
    try {
      const { sessions, total } = await get('sessions?range=day')
      expect(total).toBe(1)
      expect(sessions[0]).toMatchObject({ deviceInstanceId: 'source', inputTokens: 66, toolCallCount: 2 })
      expect((await get('sessions?range=day&device=receiver')).total).toBe(0)
      expect((await get('projects?range=day&device=source')).projects).toMatchObject([{ name: 'example', sessions: 1, tokens: 66, cost: 33 }])
      const project = await get('projects/sessions?range=day&name=example')
      expect(project).toMatchObject({ total: 1, sessions: [{ sessionId: sessions[0].sessionId, deviceInstanceId: 'source' }] })
      const detail = await get(`sessions/${encodeURIComponent(project.sessions[0].sessionId)}?device=source`)
      expect(detail.records).toHaveLength(33)
      expect(detail.records.flatMap((record: any) => record.toolCalls)).toHaveLength(2)
      expect((await get('tool-calls?range=day')).toolCalls).toMatchObject([{ name: 'Read', count: 3 }])
      const first = await get('tool-calls/events?name=Read&device=source&range=day&pageSize=1')
      const second = await get('tool-calls/events?name=Read&device=source&range=day&pageSize=1&page=2')
      expect(first.total).toBe(2)
      expect(first.events[0].id).not.toBe(second.events[0].id)
      expect(first.events[0].sessionId).toBe(project.sessions[0].sessionId)
      expect((await get('tool-calls/events?name=Read&device=other&range=day')).events).toMatchObject([{ sessionId: null, deviceInstanceId: 'other' }])
      expect((await get('tool-calls/events?name=Read&device=other&range=all')).total).toBe(2)
      expect((await get('tool-calls?device=receiver&range=all')).toolCalls).toEqual([])
      objects.set('usage/source/tool-calls.v1.json', '{')
      expect(await sync(receiver, 'receiver')).toMatchObject({ status: 'failed' })
      expect((await get('tool-calls/events?name=Read&device=source&range=all')).total).toBe(2)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
