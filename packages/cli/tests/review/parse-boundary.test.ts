import { afterAll, beforeEach, afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const state = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const parent = path.resolve('../../.artifacts/parse-boundary-tests')
  fs.mkdirSync(parent, { recursive: true })
  return { root: fs.mkdtempSync(path.join(parent, 'case-')), paths: [] as string[] }
})
vi.mock('../../src/config.js', async (original) => ({
  ...await original<typeof import('../../src/config.js')>(),
  AIUSAGE_DIR: state.root,
  loadConfig: () => ({ device: 'synthetic', platform: 'test' }),
}))
vi.mock('../../src/init.js', async (original) => ({
  ...await original<typeof import('../../src/init.js')>(),
  getState: () => ({ deviceInstanceId: 'synthetic-test-device' }),
}))
vi.mock('../../src/discovery.js', async (original) => ({
  ...await original<typeof import('../../src/discovery.js')>(),
  discoverLogFiles: () => [{ tool: 'codex', paths: state.paths }],
  getDbPath: () => null,
}))
import { initializeDatabase } from '../../src/db/index.js'
import { runParse } from '../../src/commands/parse.js'

const { recycleOutput } = createRequire(import.meta.url)('../../../../scripts/recycle-output.cjs')
let db: Database.Database
beforeEach(() => {
  recycleOutput(resolve('../..'), state.root)
  mkdirSync(state.root)
  state.paths = []
  db = new Database(':memory:')
  initializeDatabase(db)
})
afterEach(() => db.close())
afterAll(() => recycleOutput(resolve('../..'), state.root))
const model = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-4o', cwd: '/synthetic/中文' } }) + '\r\n'
const usage = JSON.stringify({ type: 'event_msg', timestamp: '2026-11-19T00:00:00Z',
  payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 20 } } } })

it('imports a completed tail once and persists its byte-accurate watermark', async () => {
  const file = join(state.root, 'rollout-tail.jsonl')
  state.paths = [file]
  const split = usage.length - 4
  writeFileSync(file, model + usage.slice(0, split))
  expect((await runParse(db, 'codex')).errors).toEqual([])
  expect(db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 0 })
  const first = JSON.parse(readFileSync(join(state.root, 'watermark.json'), 'utf8'))
  expect(first.files.codex[file].offset).toBe(Buffer.byteLength(model))

  appendFileSync(file, usage.slice(split))
  expect((await runParse(db, 'codex')).errors).toEqual([])
  expect(db.prepare('SELECT model, input_tokens, output_tokens, line_offset FROM records').all())
    .toEqual([{ model: 'gpt-4o', input_tokens: 10, output_tokens: 20, line_offset: Buffer.byteLength(model) }])
  expect((await runParse(db, 'codex')).parsedCount).toBe(0)
  expect(db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 1 })
})

it('does not reuse a preceding file model during a real import', async () => {
  const first = join(state.root, 'rollout-a.jsonl')
  const second = join(state.root, 'rollout-b.jsonl')
  state.paths = [first, second]
  writeFileSync(first, model + usage + '\n')
  writeFileSync(second, usage + '\n')
  expect((await runParse(db, 'codex')).errors).toEqual([])
  expect(db.prepare('SELECT model FROM records WHERE source_file = ?').get(first)).toEqual({ model: 'gpt-4o' })
  expect(db.prepare('SELECT model, cost, cost_source FROM records WHERE source_file = ?').get(second))
    .toEqual({ model: 'unknown', cost: 0, cost_source: 'unknown' })
})
