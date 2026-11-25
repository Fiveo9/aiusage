import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, renameSync, realpathSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { Aggregator, type StatsRecord } from '@aiusage/core'
import { createDatabase } from '../src/db/index.js'
import { runParse } from '../src/commands/parse.js'
import { AIUSAGE_DIR } from '../src/config.js'
import { WatermarkManager } from '../src/watermark.js'
import { insertRecord } from '../src/db/records.js'
import { backfillSessionTitles, sessionTitleSignature } from '../src/commands/session-titles.js'

const controls = vi.hoisted(() => ({ discovered: [] as Array<{ tool: string; paths: string[] }>,
  cursorRecords: [] as StatsRecord[], cursorErrors: [] as string[], cursorRead: vi.fn() }))
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, readFileSync: vi.fn(original.readFileSync) }
})
vi.mock('../src/discovery.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/discovery.js')>(),
  discoverLogFiles: () => controls.discovered, getDbPaths: () => [], getDbPath: () => '' }))
vi.mock('../src/config.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/config.js')>(),
  loadConfig: () => ({ device: 'fixture', platform: 'win32' }) }))
vi.mock('../src/init.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/init.js')>(),
  getState: () => ({ deviceInstanceId: 'f19-instance' }) }))
vi.mock('../src/commands/parse-cursor.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/commands/parse-cursor.js')>(),
  runParseCursor: (...args: unknown[]) => {
    controls.cursorRead(...args)
    return { records: controls.cursorRecords, partialRecords: [], toolCalls: [], errors: controls.cursorErrors,
      nextCursor: { lastCreatedAt: 1, lastId: 'old-session' } }
  } }))

const temporaryRoot = realpathSync(tmpdir())
const fixture = mkdtempSync(join(temporaryRoot, 'aiusage-f19-stream-'))
mkdirSync(AIUSAGE_DIR, { recursive: true })
const opened: Database.Database[] = []
const database = () => { const db = createDatabase(':memory:'); opened.push(db); return db }
beforeEach(() => { controls.discovered = []; controls.cursorRecords = []; controls.cursorErrors = []; vi.clearAllMocks() })
afterEach(() => { vi.restoreAllMocks(); for (const db of opened.splice(0)) db.close() })
afterAll(() => {
  const target = resolve(temporaryRoot, `recycled-${basename(fixture)}`)
  if (dirname(realpathSync(fixture)) !== temporaryRoot || dirname(target) !== temporaryRoot) throw new Error('Unsafe fixture recycle path')
  renameSync(fixture, target)
})

const modelLine = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-sol', cwd: '/synthetic/project' } })
const callLine = JSON.stringify({ type: 'response_item', timestamp: 1_700_000_000_000,
  payload: { type: 'function_call', name: 'Read', arguments: 'PRIVATE_SENTINEL' } })
const usageLine = JSON.stringify({ type: 'event_msg', timestamp: 1_700_000_001_000,
  payload: { type: 'token_count', last_token_usage: { input_tokens: 30, output_tokens: 10 } } })
function source(name: string) {
  const file = join(fixture, `${name}.jsonl`)
  writeFileSync(file, `${modelLine}\n${callLine}\n`)
  controls.discovered = [{ tool: 'codex', paths: [file] }]
  return file
}

describe('F19 actual incremental parse workflow', () => {
  it('restores state after a new run, reads no full source, and retires the original orphan atomically', async () => {
    const db = database()
    const file = source('resume')
    expect((await runParse(db, 'codex')).errors).toEqual([])
    const original = db.prepare('SELECT id FROM tool_calls WHERE record_id IS NULL').get() as { id: string }
    appendFileSync(file, `${usageLine}\n`)
    const parse = vi.spyOn(Aggregator.prototype, 'parseLine')
    vi.mocked(readFileSync).mockClear()
    expect((await runParse(db, 'codex')).errors).toEqual([])
    expect(parse).toHaveBeenCalledTimes(1)
    expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => path === file)).toEqual([])
    expect(db.prepare('SELECT model, input_tokens FROM records').get()).toEqual({ model: 'gpt-6-sol', input_tokens: 30 })
    expect(db.prepare('SELECT 1 FROM tool_calls WHERE id = ?').get(original.id)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS count FROM tool_calls WHERE record_id IS NOT NULL').get()).toEqual({ count: 1 })
  })

  it('does not publish offset/state on transaction failure and safely retries the appended bytes', async () => {
    const db = database()
    const file = source('rollback')
    await runParse(db, 'codex')
    const wmPath = join(AIUSAGE_DIR, 'watermark.json')
    const original = new WatermarkManager(wmPath).getEntry('codex', file)!
    appendFileSync(file, `${usageLine}\n`)
    db.exec(`CREATE TABLE f19_fault(enabled INTEGER); INSERT INTO f19_fault VALUES (1);
      CREATE TEMP TRIGGER f19_fail_usage BEFORE INSERT ON records WHEN (SELECT enabled FROM f19_fault) = 1
      BEGIN SELECT RAISE(ABORT, 'synthetic transaction failure'); END;`)
    expect((await runParse(db, 'codex')).errors).toHaveLength(1)
    expect(new WatermarkManager(wmPath).getEntry('codex', file)).toEqual(original)
    expect(db.prepare('SELECT COUNT(*) AS count FROM records').get()).toEqual({ count: 0 })
    db.prepare('UPDATE f19_fault SET enabled = 0').run()
    expect((await runParse(db, 'codex')).errors).toEqual([])
    expect(new WatermarkManager(wmPath).getEntry('codex', file)!.offset).toBeGreaterThan(original.offset)
    expect(db.prepare('SELECT COUNT(*) AS count FROM records').get()).toEqual({ count: 1 })
  })

  it('replays an old watermark once, then resumes without historical parsing', async () => {
    const db = database()
    const file = source('legacy')
    await runParse(db, 'codex')
    const wm = new WatermarkManager(join(AIUSAGE_DIR, 'watermark.json'))
    const entry = wm.getEntry('codex', file)!
    wm.setEntry('codex', file, { offset: entry.offset, size: entry.size, mtime: entry.mtime })
    wm.save()
    appendFileSync(file, `${usageLine}\n`)
    const parse = vi.spyOn(Aggregator.prototype, 'parseLine')
    expect((await runParse(db, 'codex')).errors).toEqual([])
    expect(parse).toHaveBeenCalledTimes(3)
    parse.mockClear()
    appendFileSync(file, `${usageLine}\n`)
    expect((await runParse(db, 'codex')).errors).toEqual([])
    expect(parse).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM records').get()).toEqual({ count: 2 })
  })
})

function cursorFixture(name: string) {
  const file = join(fixture, `${name}.db`)
  const sourceDb = new Database(file)
  opened.push(sourceDb)
  sourceDb.exec('PRAGMA journal_mode = WAL; CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES (1)')
  controls.cursorRecords = [{ id: `cursor-${name}`, ts: 1, ingestedAt: 1, updatedAt: 1, lineOffset: 0,
    tool: 'cursor', model: 'gpt-6-sol', provider: 'openai', inputTokens: 10, outputTokens: 1,
    cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, cost: 1, costSource: 'pricing',
    sessionId: 'old-session', sourceFile: file, cwd: '/synthetic/project', device: 'fixture', deviceInstanceId: 'f19-instance' }]
  return { file, sourceDb }
}

describe('F19 Cursor source change gating', () => {
  it('skips unchanged DB/WAL but imports new bubbles for the same old createdAt session', async () => {
    const db = database()
    const { file, sourceDb } = cursorFixture('cursor-growth')
    expect((await runParse(db, 'cursor', { cursorDbPath: file })).errors).toEqual([])
    await runParse(db, 'cursor', { cursorDbPath: file })
    expect(controls.cursorRead).toHaveBeenCalledTimes(1)
    sourceDb.prepare('INSERT INTO sample VALUES (?)').run(2)
    controls.cursorRecords = controls.cursorRecords.map(record => ({ ...record, inputTokens: 20 }))
    expect((await runParse(db, 'cursor', { cursorDbPath: file })).errors).toEqual([])
    expect(controls.cursorRead).toHaveBeenCalledTimes(2)
    expect(db.prepare('SELECT input_tokens FROM records').get()).toEqual({ input_tokens: 20 })
  })

  it('retries unchanged sources after an incomplete/failed read', async () => {
    const db = database()
    const { file } = cursorFixture('cursor-retry')
    controls.cursorErrors = ['synthetic busy']
    expect((await runParse(db, 'cursor', { cursorDbPath: file })).errors).toEqual(['synthetic busy'])
    controls.cursorErrors = []
    expect((await runParse(db, 'cursor', { cursorDbPath: file })).errors).toEqual([])
    expect(controls.cursorRead).toHaveBeenCalledTimes(2)
  })
})

describe('F19 batched title metadata transaction', () => {
  it('rolls back the source signature with a failed title update, then retries successfully', async () => {
    const db = database()
    const file = join(fixture, 'title-rollback.jsonl')
    writeFileSync(file, JSON.stringify({ type: 'custom-title', sessionId: 'title-session', customTitle: 'Explicit title' }) + '\n')
    insertRecord(db, { id: 'title-record', ts: 1, ingestedAt: 1, updatedAt: 1, lineOffset: 0,
      tool: 'claude-code', model: 'gpt-6-sol', provider: 'openai', inputTokens: 1, outputTokens: 1,
      cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, cost: 1, costSource: 'pricing',
      sessionId: 'title-session', sourceFile: file, device: 'fixture', deviceInstanceId: 'f19-instance' })
    const shared = new Map([[file, { signature: sessionTitleSignature(file), titles: { 'title-session': 'Explicit title' } }]])
    db.exec(`CREATE TABLE f19_title_fault(enabled INTEGER); INSERT INTO f19_title_fault VALUES (1);
      CREATE TEMP TRIGGER f19_fail_title BEFORE UPDATE OF session_title ON records WHEN (SELECT enabled FROM f19_title_fault) = 1
      BEGIN SELECT RAISE(ABORT, 'synthetic title failure'); END;`)
    await expect(backfillSessionTitles(db, 'f19-instance', 'claude-code', shared)).rejects.toThrow('title failure')
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_title_sources').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT session_title FROM records').get()).toEqual({ session_title: '' })
    db.prepare('UPDATE f19_title_fault SET enabled = 0').run()
    expect(await backfillSessionTitles(db, 'f19-instance', 'claude-code', shared)).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_title_sources').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT session_title FROM records').get()).toEqual({ session_title: 'Explicit title' })
  })
})
