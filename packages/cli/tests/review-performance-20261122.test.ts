import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, renameSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Writable } from 'node:stream'
import type Database from 'better-sqlite3'
import type { StatsRecord, SyncRecord } from '@aiusage/core'
import { JsonlFileReader, completeJsonlEntries } from '../src/jsonl.js'
import { WatermarkManager } from '../src/watermark.js'
import { insertRecord } from '../src/db/records.js'
import { insertToolCall } from '../src/db/tool-calls.js'
import { insertSyncedRecord } from '../src/db/synced-records.js'
import { exportData, exportDataChunks, writeExportData } from '../src/commands/export.js'
import { createDatabase } from '../src/db/index.js'
import { getPricingView, setUserPrice, setUserPricingAlias } from '../src/pricing-registry.js'

const temporaryRoot = realpathSync(tmpdir())
const fixture = mkdtempSync(join(temporaryRoot, 'aiusage-f19-'))
afterAll(() => {
  const target = resolve(temporaryRoot, `recycled-${basename(fixture)}`)
  if (dirname(realpathSync(fixture)) !== temporaryRoot || dirname(target) !== temporaryRoot) throw new Error('Unsafe fixture recycle path')
  renameSync(fixture, target)
})

describe('F19 byte streaming and atomic watermark batching', () => {
  it('matches the compatibility reader across UTF-8, CRLF and small chunks', () => {
    const bytes = Buffer.from('{"cwd":"C:/项目"}\r\n\n{"a":1}\n{"a":2}')
    const file = join(fixture, 'utf8.jsonl')
    writeFileSync(file, bytes)
    const reader = new JsonlFileReader(file, 0, 7)
    expect([...reader]).toEqual(completeJsonlEntries(bytes).entries)
    expect(reader.nextOffset).toBe(bytes.length)
  })

  it('reads only appended complete bytes and retries an incomplete tail', () => {
    const file = join(fixture, 'append.jsonl')
    const prefix = '{"a":1}\n'
    writeFileSync(file, `${prefix}{"中文":`)
    const first = new JsonlFileReader(file, Buffer.byteLength(prefix), 3)
    expect([...first]).toEqual([])
    expect(first.nextOffset).toBe(Buffer.byteLength(prefix))
    appendFileSync(file, '2}\n')
    const second = new JsonlFileReader(file, first.nextOffset, 3)
    expect([...second].filter(entry => entry.line.trim())).toEqual([{ line: '{"中文":2}', offset: Buffer.byteLength(prefix) }])
    expect(second.nextOffset).toBe(Buffer.byteLength(`${prefix}{"中文":2}\n`))
  })

  it('defers repeated saves until the outer batch ends, without changing default save behavior', () => {
    const path = join(fixture, 'watermark.json')
    const manager = new WatermarkManager(path)
    manager.beginBatch()
    manager.setEntry('codex', 'synthetic.jsonl', { offset: 10, size: 10, mtime: 1 })
    manager.save()
    expect(new WatermarkManager(path).getEntry('codex', 'synthetic.jsonl')).toBeNull()
    manager.beginBatch()
    manager.setEntry('codex', 'synthetic.jsonl', { offset: 20, size: 20, mtime: 2 })
    manager.save()
    manager.endBatch()
    expect(new WatermarkManager(path).getEntry('codex', 'synthetic.jsonl')).toBeNull()
    manager.endBatch()
    expect(new WatermarkManager(path).getEntry('codex', 'synthetic.jsonl')?.offset).toBe(20)
    manager.setEntry('codex', 'synthetic.jsonl', { offset: 30, size: 30, mtime: 3 })
    manager.save()
    expect(new WatermarkManager(path).getEntry('codex', 'synthetic.jsonl')?.offset).toBe(30)
  })
})

describe('F19 prepared statements are per database', () => {
  const record = {
    id: 'record', ts: 1, ingestedAt: 1, updatedAt: 1, lineOffset: 0, tool: 'codex', model: 'gpt-6-sol', provider: 'openai',
    inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0,
    cost: 1, costSource: 'pricing', sessionId: 'session', sourceFile: 'synthetic.jsonl', device: 'test', deviceInstanceId: 'instance',
  } as StatsRecord
  function database() {
    const run = vi.fn(() => ({ changes: 1 }))
    const prepare = vi.fn(() => ({ run }))
    return { db: { prepare } as unknown as Database.Database, prepare, run }
  }

  it.each(['record', 'tool-call', 'synced-record'])('reuses %s statements without crossing connection boundaries', (kind) => {
    const first = database()
    const second = database()
    const insert = (db: Database.Database) => {
      if (kind === 'record') insertRecord(db, record)
      else if (kind === 'tool-call') insertToolCall(db, { id: 'call', recordId: 'record', name: 'Read', ts: 1, callIndex: 0 })
      else insertSyncedRecord(db, { ...record, sessionKey: 'session-key' } as SyncRecord, 1)
    }
    insert(first.db)
    insert(first.db)
    insert(second.db)
    expect(first.prepare).toHaveBeenCalledTimes(1)
    expect(first.run).toHaveBeenCalledTimes(2)
    expect(second.prepare).toHaveBeenCalledTimes(1)
  })
})

describe('F19 streaming exports', () => {
  const rows = [{ id: 'one', ts: 1_700_000_000_000, tool: 'codex', model: 'gpt-6-sol', session_id: 'one', updated_at: 1 },
    { id: 'two', ts: 1_700_000_001_000, tool: 'codex', model: 'gpt-6-sol', session_id: 'two', updated_at: 2 }]
  function database() {
    const all = vi.fn(() => { throw new Error('Export must not buffer SQL rows') })
    const iterate = vi.fn(() => rows.values())
    return { db: { prepare: () => ({ all, iterate }) } as unknown as Database.Database, all, iterate }
  }

  it.each(['csv', 'json', 'ndjson'] as const)('streams %s using iterate, preserving compatibility bytes and backpressure', async (format) => {
    const { db, all, iterate } = database()
    const expected = exportData(db, format)
    const chunks = [...exportDataChunks(db, format)]
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(expected)
    let received = ''
    const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { received += chunk; setImmediate(callback) } })
    await writeExportData(db, format, output)
    expect(received).toBe(expected)
    expect(all).not.toHaveBeenCalled()
    expect(iterate).toHaveBeenCalledTimes(3)
    if (format === 'json') expect(expected).toBe(JSON.stringify(JSON.parse(expected), null, 2))
  })

  it('does not retain stdout listeners or close stdout after repeated exports', async () => {
    const events = ['error', 'close', 'end', 'finish']
    const before = events.map(event => process.stdout.listenerCount(event))
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk: unknown, _encoding: unknown, callback: () => void) => {
      queueMicrotask(callback)
      return true
    }) as never)
    try {
      for (let index = 0; index < 15; index++) await writeExportData(database().db, 'ndjson', process.stdout)
      expect(events.map(event => process.stdout.listenerCount(event))).toEqual(before)
      expect(process.stdout.writableEnded).toBe(false)
    } finally { write.mockRestore() }
  })
})

describe('F19 request-scoped pricing snapshot', () => {
  it('loads prices and aliases once regardless of the number of local models or response fields', () => {
    const db = createDatabase(':memory:')
    try {
      setUserPrice(db, 'review-model', { input: 2, output: 8 })
      setUserPricingAlias(db, 'review-alias', 'review-model')
      for (let index = 0; index < 30; index++) insertRecord(db, {
        id: `price-${index}`, ts: 1, ingestedAt: 1, updatedAt: 1, lineOffset: index, tool: 'codex', model: `review-model-${index}`,
        provider: 'test', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0,
        cost: 0, costSource: 'unknown', sessionId: 'session', sourceFile: 'synthetic.jsonl', device: 'test', deviceInstanceId: 'instance',
      })
      const prepare = vi.spyOn(db, 'prepare')
      const view = getPricingView(db)
      expect(view.localBindings).toHaveLength(30)
      expect(view.localBindings.every(binding => binding.hasPrice)).toBe(true)
      expect(view.registry).toMatchObject({ localModels: 30, matchedLocalModels: 30, unresolvedLocalModels: [] })
      expect(view.aliasBindings).toContainEqual(expect.objectContaining({ alias: 'review-alias', modelKey: 'review-model' }))
      const sql = prepare.mock.calls.map(([query]) => query)
      expect(sql.filter(query => query.includes('FROM model_prices'))).toHaveLength(1)
      expect(sql.filter(query => query.includes('FROM model_price_aliases'))).toHaveLength(1)
    } finally { db.close() }
  })
})
