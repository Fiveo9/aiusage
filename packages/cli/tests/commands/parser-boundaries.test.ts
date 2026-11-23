import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '@aiusage/core'
import { AIUSAGE_DIR } from '../../src/config.js'
import { initializeDatabase } from '../../src/db/index.js'
import { completeJsonlEntries, completeJsonlInput } from '../../src/jsonl.js'
import { runParse } from '../../src/commands/parse.js'

const discovered = vi.hoisted(() => ({ logs: [] as Array<{ tool: Tool; paths: string[] }>, databases: [] as string[], zed: '' }))
vi.mock('../../src/discovery.js', async () => ({
  ...await vi.importActual<typeof import('../../src/discovery.js')>('../../src/discovery.js'),
  discoverLogFiles: () => discovered.logs,
  getDbPath: (key: string) => key === 'zed' && discovered.zed ? discovered.zed : null,
  getDbPaths: () => discovered.databases,
}))

const inference = { type: 'log', traceId: 'synthetic-trace', body: 'GenAI inference: synthetic', attributes: { 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 5, 'gen_ai.request.model': 'gpt-4o-mini', 'gen_ai.response.id': 'synthetic-response' } }
const codexCall = { type: 'response_item', timestamp: 1000, payload: { type: 'function_call', name: 'Read' } }
const codexUsage = { type: 'event_msg', timestamp: 1001, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, output_tokens: 2 } } } }
const qoderCall = { type: 'tool.requested', ts: 1000, loop_id: 'loop', data: { tool_name: 'Read' } }
const qoderUsage = { type: 'model.response.completed', ts: 1001, loop_id: 'loop', data: { model: 'qoder-auto', input_tokens: 5, output_tokens: 2 } }

describe('parser boundaries through runParse', () => {
  let db: Database.Database
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiusage-parser-boundaries-'))
    mkdirSync(AIUSAGE_DIR, { recursive: true })
    writeFileSync(join(AIUSAGE_DIR, 'watermark.json'), '{}')
    discovered.logs = []
    discovered.databases = []
    discovered.zed = ''
    db = new Database(':memory:')
    initializeDatabase(db)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
    // Synthetic fixtures have no links; retain them recoverably until run cleanup.
    renameSync(root, `${root}-recycled`)
  })

  function log(tool: Tool, rows: unknown[]): string {
    const file = join(root, 'synthetic.jsonl')
    discovered.logs = [{ tool, paths: [file] }]
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    return file
  }

  it.each(['codex', 'codefuse', 'qoder'] as const)('%s adopts a previous-poll orphan without double counting', async tool => {
    const file = log(tool, [tool === 'qoder' ? qoderCall : codexCall])
    expect((await runParse(db, tool)).errors).toEqual([])
    expect(db.prepare('SELECT tool, record_id FROM tool_calls').all()).toEqual([{ tool, record_id: null }])
    appendFileSync(file, JSON.stringify(tool === 'qoder' ? qoderUsage : codexUsage) + '\n')
    expect((await runParse(db, tool)).errors).toEqual([])
    const calls = db.prepare('SELECT record_id FROM tool_calls').all() as Array<{ record_id: string | null }>
    expect(calls).toHaveLength(1)
    expect(calls[0].record_id).not.toBeNull()
    appendFileSync(file, '{"type":"ignored"}\n')
    expect((await runParse(db, tool)).toolCallCount).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get()).toEqual({ n: 1 })
  })

  it('does not finalize a historical Copilot fallback on a metadata-only poll', async () => {
    const file = log('copilot', [inference])
    await runParse(db, 'copilot')
    appendFileSync(file, '{"type":"ignored"}\n')
    expect((await runParse(db, 'copilot')).parsedCount).toBe(0)
  })

  it('retires a published Copilot fallback atomically with its later ChatSpan', async () => {
    const file = log('copilot', [inference])
    await runParse(db, 'copilot')
    const previous = db.prepare('SELECT id FROM records').get() as { id: string }
    db.prepare('INSERT INTO sync_record_state (target, record_id, synced_at) VALUES (?, ?, ?)').run('synthetic-target', previous.id, 1)
    appendFileSync(file, JSON.stringify({ ...inference, type: 'span', name: 'chat synthetic', spanId: 'synthetic-span', attributes: { ...inference.attributes, 'gen_ai.operation.name': 'chat' } }) + '\n')
    expect((await runParse(db, 'copilot')).errors).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT id FROM records WHERE id = ?').get(previous.id)).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM sync_retired_wire_ids WHERE target = ?').get('synthetic-target')).toBeDefined()
  })

  it('adopts a timestamp-less OpenClaw call only by a stable block identity', async () => {
    const content = [{ type: 'toolCall', id: 'synthetic-call', name: 'Read' }]
    const file = log('openclaw', [{ message: { role: 'assistant', content } }])
    await runParse(db, 'openclaw')
    appendFileSync(file, JSON.stringify({ message: { role: 'assistant', content, usage: { input: 1, output: 1 } } }) + '\n')
    expect((await runParse(db, 'openclaw')).errors).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT record_id FROM tool_calls').get()).not.toEqual({ record_id: null })
  })

  it('a first-run tool backfill preserves the orphan identity and raw byte position', async () => {
    let clock = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => clock++)
    log('openclaw', [
      { message: { role: 'assistant', content: [{ type: 'toolCall', id: 'synthetic-call', name: 'Read' }] } },
      { message: { role: 'assistant', usage: { input: 1, output: 1 } } },
    ])
    expect((await runParse(db, 'openclaw')).errors).toEqual([])
    expect(db.prepare('SELECT tool, record_id FROM tool_calls').all()).toEqual([{ tool: 'openclaw', record_id: null }])
  })

  it('keeps source offsets based on raw bytes even with invalid UTF-8', async () => {
    const first = Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0xff]), Buffer.from('","usage":{"input_tokens":1}}\n')])
    const second = Buffer.from('{"usage":{"input_tokens":2}}\n')
    const file = log('gemini', [])
    writeFileSync(file, Buffer.concat([first, second]))
    expect((await runParse(db, 'gemini')).errors).toEqual([])
    expect(db.prepare('SELECT line_offset FROM records ORDER BY line_offset').all()).toEqual([{ line_offset: 0 }, { line_offset: first.length }])
  })

  it('resets a JSONL watermark after the file is truncated', async () => {
    const file = log('gemini', [{ padding: 'synthetic-padding'.repeat(20), usage: { input_tokens: 1 } }])
    await runParse(db, 'gemini')
    writeFileSync(file, '{"usage":{"input_tokens":4}}\n')
    expect((await runParse(db, 'gemini')).errors).toEqual([])
    expect(db.prepare('SELECT input_tokens FROM records').all()).toEqual([{ input_tokens: 4 }])
  })

  it('re-reads a smaller Kiro snapshot and keeps a missing-time request under its stable ID', async () => {
    const file = join(root, 'synthetic.json')
    discovered.logs = [{ tool: 'kiro', paths: [file] }]
    const snapshot = (input: number) => ({ session_id: 's', session_state: { conversation_metadata: { user_turn_metadatas: [{ input_token_count: input, output_token_count: 1 }] } } })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    writeFileSync(file, JSON.stringify({ ...snapshot(10), padding: 'synthetic'.repeat(20) }))
    utimesSync(file, 1, 1)
    await runParse(db, 'kiro')
    const first = db.prepare('SELECT id FROM records').get() as { id: string }
    clock.mockReturnValue(2000)
    writeFileSync(file, JSON.stringify(snapshot(2)))
    utimesSync(file, 2, 2)
    expect((await runParse(db, 'kiro')).errors).toEqual([])
    expect(db.prepare('SELECT id, input_tokens FROM records').all()).toEqual([{ id: first.id, input_tokens: 2 }])
  })

  it('discovers all default OpenCode database filenames without broadening explicit overrides', async () => {
    const directory = join(root, 'opencode')
    mkdirSync(directory)
    for (const name of ['opencode.db', 'opencode-synthetic.db', 'unrelated.db']) writeFileSync(join(directory, name), '')
    const actual = await vi.importActual<typeof import('../../src/discovery.js')>('../../src/discovery.js')
    expect(actual.getDbPaths('opencode', { XDG_DATA_HOME: root }).sort()).toEqual([join(directory, 'opencode.db'), join(directory, 'opencode-synthetic.db')].sort())
    expect(actual.getDbPaths('opencode', { XDG_DATA_HOME: root, OPENCODE_DB: join(directory, 'opencode.db') })).toEqual([join(directory, 'opencode.db')])
  })

  it('imports all OpenCode databases with independent watermarks', async () => {
    for (const [index, name] of ['opencode.db', 'opencode-synthetic.db'].entries()) {
      const file = join(root, name)
      const source = new Database(file)
      source.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);')
      source.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('same-id', `session-${index}`, 1000, JSON.stringify({ role: 'assistant', modelID: 'unknown', tokens: { input: index + 1, output: 1 }, time: { created: 1000, completed: 1001 } }))
      source.close()
      discovered.databases.push(file)
    }
    expect((await runParse(db, 'opencode')).errors).toEqual([])
    expect(db.prepare('SELECT input_tokens FROM records ORDER BY input_tokens').all()).toEqual([{ input_tokens: 1 }, { input_tokens: 2 }])
    expect((await runParse(db, 'opencode')).parsedCount).toBe(0)
  })

  it('a Zed thread update uses the actual stored-time callback instead of inserting a second row', async () => {
    discovered.zed = join(root, 'zed.sqlite')
    const source = new Database(discovered.zed)
    source.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, updated_at TEXT, data_type TEXT, data TEXT)')
    source.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run('thread', '2026-01-01', 'json', JSON.stringify({ cumulative_token_usage: { input_tokens: 1 } }))
    source.close()
    expect((await runParse(db, 'zed')).errors).toEqual([])
    const first = db.prepare('SELECT id, ts FROM records').get() as { id: string; ts: number }
    const changed = new Database(discovered.zed)
    changed.prepare('UPDATE threads SET updated_at = ?, data = ?').run('2026-01-02', JSON.stringify({ cumulative_token_usage: { input_tokens: 2 } }))
    changed.close()
    expect((await runParse(db, 'zed')).errors).toEqual([])
    expect(db.prepare('SELECT id, ts, input_tokens FROM records').all()).toEqual([{ ...first, input_tokens: 2 }])
  })
})

describe('raw JSONL boundaries', () => {
  it('exposes byte offsets without changing the existing complete-lines API', () => {
    const buffer = Buffer.concat([Buffer.from('"'), Buffer.from([0xff]), Buffer.from('"\nnull\n{"unfinished":')])
    const result = completeJsonlInput(buffer)
    expect(result.lines).toEqual(['"�"', 'null', ''])
    expect(completeJsonlEntries(buffer).entries).toEqual([{ line: '"�"', offset: 0 }, { line: 'null', offset: 4 }, { line: '', offset: 9 }])
    expect(result.nextOffset).toBe(9)
  })
})
