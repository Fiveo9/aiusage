import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'

const fixture = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'aiusage-windows-path-')), paths: [] as Array<{ tool: Tool; paths: string[] }>, trae: '' }
})
vi.mock('../../src/config.js', async original => ({ ...await original<typeof import('../../src/config.js')>(),
  AIUSAGE_DIR: fixture.root, loadConfig: () => ({ exchangeRate: 1 }) }))
vi.mock('../../src/init.js', async original => ({ ...await original<typeof import('../../src/init.js')>(),
  getState: () => ({ deviceInstanceId: 'synthetic-device' }) }))
vi.mock('../../src/discovery.js', async original => ({ ...await original<typeof import('../../src/discovery.js')>(),
  discoverLogFiles: () => fixture.paths, getDbPath: (key: string) => key === 'trae' ? fixture.trae || null : null, getDbPaths: () => [] }))
vi.mock('../../src/commands/parse-trae.js', () => ({ runParseTrae: () => { throw new Error('synthetic Trae failure') } }))
import { extractSessionId, runParse } from '../../src/commands/parse.js'

describe('review Windows session path boundaries', () => {
  let db: Database.Database
  beforeEach(() => { fixture.paths = []; fixture.trae = ''; db = new Database(':memory:'); initializeDatabase(db) })
  afterEach(() => db.close())
  afterAll(() => rmSync(fixture.root, { recursive: true, force: true }))
  it.each([
    ['claude-code', 'C:\\synthetic\\projects\\p\\sid.jsonl', 'sid'],
    ['codex', 'C:\\synthetic\\rollout-archive\\rollout-sid.jsonl', 'sid'],
    ['openclaw', 'C:\\synthetic\\agents\\main\\sessions\\sid.jsonl', 'sid'],
    ['copilot', 'C:\\synthetic\\otel\\copilot-otel-20261123.jsonl', 'copilot-otel-20261123'],
    ['pi', 'C:\\synthetic\\sessions\\2026-11-23_sid.jsonl', 'sid'],
    ['pi', 'C:\\synthetic\\sessions\\sid.jsonl', 'sid'],
    ['codefuse', 'C:\\synthetic\\sessions\\ant_cc_sid.json', 'sid'],
    ['qoder', 'C:\\synthetic\\sessions\\sid\\segments\\one.jsonl', 'sid'],
    ['gemini', 'C:\\synthetic\\chats\\session-sid.json', 'session-sid'],
    ['kimi', 'C:\\synthetic\\sessions\\sid\\wire.jsonl', 'sid'],
    ['codebuddy', 'C:\\synthetic\\projects\\p\\sid.jsonl', 'sid'],
    ['omp', 'C:\\synthetic\\agent\\sessions\\sid.jsonl', 'sid'],
    ['craft', 'C:\\synthetic\\sessions\\sid.jsonl', 'sid'],
    ['droid', 'C:\\synthetic\\sessions\\sid.jsonl', 'sid'],
  ] as Array<[Tool, string, string]>)('extracts the %s session without a drive or directory prefix', (tool, file, expected) => {
    expect(extractSessionId(file, tool)).toBe(expected)
  })
  it('keeps the Cursor composer ID during a real native-path transcript import', async () => {
    const directory = join(fixture.root, 'agent-transcripts', 'composer-id')
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'composer-id.jsonl')
    writeFileSync(file, JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'a'.repeat(300) }] } }) + '\n')
    fixture.paths = [{ tool: 'cursor', paths: [file] }]
    expect((await runParse(db, 'cursor')).errors).toEqual([])
    expect(db.prepare("SELECT session_id FROM records WHERE tool = 'cursor'").get()).toEqual({ session_id: 'composer-id' })
  })
  it('contains a Trae source failure in the parse result instead of rejecting the whole import', async () => {
    fixture.trae = join(fixture.root, 'synthetic-trae.db')
    writeFileSync(fixture.trae, '')
    const result = await runParse(db, 'trae')
    expect(result.errors.some(error => error.includes('synthetic Trae failure'))).toBe(true)
  })
})
