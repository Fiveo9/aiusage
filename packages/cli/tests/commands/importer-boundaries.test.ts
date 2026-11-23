import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runParseZcode } from '../../src/commands/parse-zcode.js'
import { runParseQoder } from '../../src/commands/parse-qoder.js'
import { runParseAntigravity } from '../../src/commands/parse-antigravity.js'
import { runParseCodeBuddy } from '../../src/commands/parse-codebuddy.js'
import { runParseKelivo } from '../../src/commands/parse-kelivo.js'
import { runParseKiro } from '../../src/commands/parse-kiro.js'

const base = { dbPath: 'synthetic.db', device: 'Synthetic', deviceInstanceId: 'synthetic-instance', now: 1000, cursor: null }
function varint(value: bigint): Buffer {
  let remaining = BigInt.asUintN(64, value)
  const bytes: number[] = []
  do {
    const byte = Number(remaining & 127n)
    remaining >>= 7n
    bytes.push(byte | (remaining ? 128 : 0))
  } while (remaining)
  return Buffer.from(bytes)
}
function field(number: number, value: bigint | Buffer): Buffer {
  return typeof value === 'bigint' ? Buffer.concat([varint(BigInt(number * 8)), varint(value)])
    : Buffer.concat([varint(BigInt(number * 8 + 2)), varint(BigInt(value.length)), value])
}

describe('review importer boundaries', () => {
  let db: Database.Database
  let root: string
  beforeEach(() => {
    db = new Database(':memory:')
    root = mkdtempSync(join(tmpdir(), 'aiusage-importer-boundaries-'))
  })
  afterEach(() => {
    db.close()
    renameSync(root, `${root}-recycled`)
  })

  function zcode(): void {
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
      CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT, model_id TEXT, status TEXT, started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER);
      CREATE TABLE tool_usage (id TEXT PRIMARY KEY, tool_name TEXT, status TEXT, started_at INTEGER);`)
  }
  it('ZCode imports an earlier running request after a later one completed', () => {
    zcode()
    db.exec("INSERT INTO model_usage VALUES ('early','s','unknown','running',100,0,0,0,0,0), ('late','s','unknown','completed',200,2,1,0,0,0)")
    const first = runParseZcode(db, { ...base, toolCursor: null })
    db.exec("UPDATE model_usage SET status='completed', input_tokens=3, output_tokens=1 WHERE id='early'")
    const second = runParseZcode(db, { ...base, cursor: first.nextCursor, toolCursor: first.nextToolCursor })
    expect(second.records.map(record => record.inputTokens)).toEqual([3])
    expect(second.nextCursor?.lastStartedAt).toBe(200)
  })
  it('ZCode imports an earlier running tool call after a later one completed', () => {
    zcode()
    db.exec("INSERT INTO tool_usage VALUES ('early','Read','running',100), ('late','Read','completed',200)")
    const first = runParseZcode(db, { ...base, toolCursor: null })
    db.exec("UPDATE tool_usage SET status='completed' WHERE id='early'")
    const second = runParseZcode(db, { ...base, cursor: first.nextCursor, toolCursor: first.nextToolCursor })
    expect(second.toolCalls).toHaveLength(1)
    expect(second.nextToolCursor?.lastStartedAt).toBe(200)
  })
  it('ZCode tool IDs are independent of batch boundaries and names shared at one time', () => {
    zcode()
    db.exec("INSERT INTO tool_usage VALUES ('first','Read','completed',100), ('second','Read','completed',100)")
    const full = runParseZcode(db, { ...base, toolCursor: null })
    const tail = runParseZcode(db, { ...base, toolCursor: { lastStartedAt: 100, lastId: 'first' } })
    expect(tail.toolCalls[0].id).toBe(full.toolCalls[1].id)
    expect(new Set(full.toolCalls.map(call => call.id)).size).toBe(2)
  })
  it('Qoder skips non-object and bad token rows without losing a later valid row', () => {
    db.exec('CREATE TABLE chat_message (id TEXT, session_id TEXT, request_id TEXT, role TEXT, token_info TEXT, gmt_create INTEGER); CREATE TABLE chat_record (request_id TEXT, extra TEXT);')
    const insert = db.prepare('INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?)')
    for (const [index, value] of ['null', '[1]', '{"prompt_tokens":"not-a-number"}', '{"prompt_tokens":3,"completion_tokens":1}'].entries()) {
      insert.run(`row-${index}`, 's', null, 'assistant', value, index + 1)
    }
    const result = runParseQoder(db, base)
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({ inputTokens: 3, outputTokens: 1 })
  })
  it.each([-1n, 9_007_199_254_740_993n])('Antigravity treats %s as a signed sentinel or rejects unsafe overflow', input => {
    db.exec('CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER); CREATE TABLE steps (idx INTEGER, metadata BLOB);')
    const usage = Buffer.concat([field(2, input), field(3, 2n), field(10, 2n)])
    const chat = Buffer.concat([field(4, usage), field(19, Buffer.from('unknown'))])
    const generation = field(1, chat)
    db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(0, generation, generation.length)
    const result = runParseAntigravity(db, { ...base, fallbackTs: 1000, startIndex: 0 })
    if (input < 0) {
      expect(result.records).toHaveLength(1)
      expect(result.records[0]).toMatchObject({ inputTokens: 0, outputTokens: 2 })
    } else {
      expect(result.records).toEqual([])
      expect(result.errors.length).toBeGreaterThan(0)
    }
  })

  function buddy(name: string, extra: unknown, createdAt?: string): void {
    const messages = join(root, 'conversation', 'messages')
    mkdirSync(messages, { recursive: true })
    writeFileSync(join(messages, name), JSON.stringify({ role: 'assistant', extra: JSON.stringify(extra), createdAt }))
  }
  it('CodeBuddy counts cache-write/thinking-only snapshots with missing createdAt behind the cursor', () => {
    buddy('valid.json', { statsSnapshot: { cacheWriteTokens: 2, thinkingTokens: 3 } })
    const result = runParseCodeBuddy({ ...base, dataDir: root, cursor: 10_000 })
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({ ts: 0, cacheWriteTokens: 2, thinkingTokens: 3 })
  })
  it('CodeBuddy skips a null extra turn without discarding valid conversation usage', () => {
    buddy('invalid.json', null)
    buddy('valid.json', { statsSnapshot: { cacheMissTokens: 2, lastOutputTokens: 3 } }, '2026-01-01')
    const result = runParseCodeBuddy({ ...base, dataDir: root, cursor: undefined })
    expect(result.errors).toEqual([])
    expect(result.records).toHaveLength(1)
  })
  it('Kelivo missing timestamps have stable IDs on re-import', async () => {
    const filePath = join(root, 'chats.json')
    writeFileSync(filePath, JSON.stringify({ messages: [{ role: 'assistant', conversationId: 's', promptTokens: 2, completionTokens: 1 }] }))
    const first = await runParseKelivo({ ...base, filePath })
    const second = await runParseKelivo({ ...base, now: 2000, filePath })
    expect(first.records).toHaveLength(1)
    expect(second.records[0]).toMatchObject({ id: first.records[0].id, ts: first.records[0].ts })
  })
  it('Kiro missing timestamps have stable IDs on re-import', () => {
    db.exec('CREATE TABLE tokens_generated (id INTEGER, model TEXT, provider TEXT, tokens_prompt INTEGER, tokens_generated INTEGER, timestamp TEXT)')
    db.exec("INSERT INTO tokens_generated VALUES (1,'unknown','unknown',2,1,NULL)")
    const first = runParseKiro(db, base)
    const second = runParseKiro(db, { ...base, now: 2000 })
    expect(second.records[0]).toMatchObject({ id: first.records[0].id, ts: first.records[0].ts })
  })
})
