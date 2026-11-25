import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runParseTrae } from '../../src/commands/parse-trae.js'

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawnSync: vi.fn(original.spawnSync) }
})

/**
 * Create a git snapshot repo at `repoPath` with the given lightweight tags.
 * Each tag points at an empty commit dated `tsSeconds` so that
 * `git for-each-ref --format=%(creatordate:unix)` reports that timestamp.
 */
function makeSnapshotRepo(repoPath: string, tags: Array<{ name: string; ts: number }>): void {
  mkdirSync(repoPath, { recursive: true })
  const git = (args: string[], input?: string) => {
    const r = spawnSync('git', args, { cwd: repoPath, encoding: 'utf-8', input })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  }
  git(['init', '-q'])
  // Real lightweight refs and individual commit dates, in one batch. No checkout,
  // reset, clean or pruning command is used in this synthetic fixture.
  const input = tags.map(({ name, ts }) => `commit refs/tags/${name}\ncommitter Test <test@example.com> ${ts} +0000\ndata ${Buffer.byteLength(name)}\n${name}\n\n`).join('')
  git(['fast-import', '--quiet'], input)
}

describe('parse-trae', () => {
  let root: string
  let dbPath: string
  let snapshotDir: string

  const sessionId = 'a1b2c3d4e5f6a1b2c3d4e5f6'

  beforeEach(() => {
    vi.clearAllMocks()
    root = mkdtempSync(join(tmpdir(), 'trae-test-'))
    // Mimic the Trae layout the parser expects.
    const globalStorage = join(root, 'User', 'globalStorage')
    mkdirSync(globalStorage, { recursive: true })
    dbPath = join(globalStorage, 'state.vscdb')
    writeFileSync(dbPath, '')
    snapshotDir = join(root, 'ModularData', 'ai-agent', 'snapshot')
    mkdirSync(snapshotDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('extracts session metadata from snapshot git tags', () => {
    const start = 1_700_000_000
    makeSnapshotRepo(join(snapshotDir, sessionId, 'v2'), [
      { name: `chain-start-${sessionId}`, ts: start },
      { name: 'before-chat-turn-1', ts: start + 10 },
      { name: 'before-chat-turn-2', ts: start + 20 },
      { name: `toolcall-${sessionId}-1`, ts: start + 15 },
    ])

    const result = runParseTrae({
      dbPath,
      device: 'macbook',
      deviceInstanceId: 'device-123',
      now: 1_778_822_000_000,
    })

    expect(result.errors).toHaveLength(0)
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({
      tool: 'trae',
      provider: 'trae',
      sessionId,
      ts: start * 1000,
      inputTokens: 2 * 200,
      outputTokens: 2 * 800,
    })
    expect(result.toolCalls).toHaveLength(1)
    expect(result.lastImportedAt).toBe(start * 1000)
  })

  it('falls back to earliest tag when no chain-start tag exists', () => {
    const start = 1_700_000_500
    makeSnapshotRepo(join(snapshotDir, sessionId, 'v2'), [
      { name: 'before-chat-turn-1', ts: start + 30 },
      { name: 'before-chat-turn-2', ts: start },
    ])

    const result = runParseTrae({
      dbPath,
      device: 'macbook',
      deviceInstanceId: 'device-123',
      now: 1_778_822_000_000,
    })

    expect(result.records).toHaveLength(1)
    expect(result.records[0].ts).toBe(start * 1000)
  })

  it('emits a session again after it was imported, without moving lastImportedAt back', () => {
    const start = 1_700_000_000
    makeSnapshotRepo(join(snapshotDir, sessionId, 'v2'), [
      { name: `chain-start-${sessionId}`, ts: start },
      { name: 'before-chat-turn-1', ts: start + 10 },
    ])

    const result = runParseTrae({
      dbPath,
      device: 'macbook',
      deviceInstanceId: 'device-123',
      now: 1_778_822_000_000,
      lastImportedAt: start * 1000 + 1,
    })

    // The record id is stable, so writing it again updates the row in place.
    expect(result.records).toHaveLength(1)
    expect(result.lastImportedAt).toBe(start * 1000 + 1)
  })

  it('returns an error when ModularData is missing', () => {
    rmSync(snapshotDir, { recursive: true, force: true })
    rmSync(join(root, 'ModularData'), { recursive: true, force: true })

    const result = runParseTrae({
      dbPath,
      device: 'macbook',
      deviceInstanceId: 'device-123',
      now: 1_778_822_000_000,
    })

    expect(result.records).toHaveLength(0)
    expect(result.errors).toContain('Trae ModularData not found')
  })

  const tagQueries = () => vi.mocked(spawnSync).mock.calls.filter(([, args]) => Array.isArray(args) && args[0] === 'for-each-ref').length

  it('reuses unchanged tag metadata while emitting the same stable records', () => {
    makeSnapshotRepo(join(snapshotDir, sessionId, 'v2'), [{ name: 'before-chat-turn-1', ts: 1_700_000_000 }])
    const options = { dbPath, device: 'test', deviceInstanceId: 'test-instance', now: 1_700_001_000_000 }
    const first = runParseTrae(options)
    const calls = tagQueries()
    expect(runParseTrae(options).records).toEqual(first.records)
    expect(tagQueries()).toBe(calls)
  })

  it('invalidates metadata when an old session gains loose tags or packed refs change', () => {
    const repo = join(snapshotDir, sessionId, 'v2')
    makeSnapshotRepo(repo, [{ name: 'before-chat-turn-1', ts: 1_700_000_000 }])
    const options = { dbPath, device: 'test', deviceInstanceId: 'test-instance', now: 1_700_001_000_000 }
    runParseTrae(options)
    makeSnapshotRepo(repo, [{ name: 'before-chat-turn-2', ts: 1_700_000_010 }])
    expect(runParseTrae(options).records[0].inputTokens).toBe(400)
    const calls = tagQueries()
    const packed = spawnSync('git', ['pack-refs', '--all', '--no-prune'], { cwd: repo, encoding: 'utf8' })
    expect(packed.status).toBe(0)
    expect(runParseTrae(options).records[0].inputTokens).toBe(400)
    expect(tagQueries()).toBe(calls + 1)
  })

  it('retries a failed metadata query even when refs did not change', () => {
    makeSnapshotRepo(join(snapshotDir, sessionId, 'v2'), [{ name: 'before-chat-turn-1', ts: 1_700_000_000 }])
    const options = { dbPath, device: 'test', deviceInstanceId: 'test-instance', now: 1_700_001_000_000 }
    vi.mocked(spawnSync).mockImplementationOnce(() => ({ status: 1, stdout: '', stderr: 'synthetic failure' }) as ReturnType<typeof spawnSync>)
    expect(runParseTrae(options).records).toEqual([])
    expect(runParseTrae(options).records).toHaveLength(1)
    expect(tagQueries()).toBe(2)
  })
})
