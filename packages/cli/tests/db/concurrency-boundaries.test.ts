import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { StatsRecord, SyncRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { insertChangedRecords, insertRecord } from '../../src/db/records.js'
import { insertSyncedRecord, mergeSyncedRecordsIntoRecords } from '../../src/db/synced-records.js'
import { applyPragmas, createSchemaVersionTable } from '../../src/db/schema.js'
import { runMigrations } from '../../src/db/migrations/index.js'

function record(inputTokens: number): StatsRecord {
  return { id: 'synthetic', ts: 1000, ingestedAt: 1000, updatedAt: 1000, lineOffset: 0, tool: 'claude-code', model: 'synthetic', provider: 'synthetic',
    inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, cost: 0, costSource: 'unknown',
    sessionId: 's', sourceFile: 'synthetic.jsonl', device: 'Synthetic', deviceInstanceId: 'owner' }
}
function remote(id: string, inputTokens = 1, updatedAt = 1000): SyncRecord {
  return { ...record(inputTokens), id, updatedAt, sessionKey: 's' }
}

describe('review SQLite concurrency boundaries', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })
  afterEach(() => db.close())
  it('sets busy_timeout before requesting WAL', () => {
    const pragmas: string[] = []
    applyPragmas({ pragma: (statement: string) => pragmas.push(statement) } as unknown as Database.Database)
    expect(pragmas.indexOf('busy_timeout = 30000')).toBeLessThan(pragmas.indexOf('journal_mode = WAL'))
  })
  it('does not count an unchanged duplicate ID twice in one batch', () => {
    expect(insertChangedRecords(db, [record(2), record(2)])).toBe(1)
  })
  it('compares repeated IDs with the state already written in this batch', () => {
    insertRecord(db, record(1))
    expect(insertChangedRecords(db, [record(2), record(1)])).toBe(2)
    expect(db.prepare('SELECT input_tokens FROM records').get()).toEqual({ input_tokens: 1 })
  })
  it('rolls all pending migrations back when a later migration fails', () => {
    const fresh = new Database(':memory:')
    try {
      createSchemaVersionTable(fresh)
      fresh.exec("CREATE TRIGGER synthetic_migration_failure BEFORE INSERT ON schema_version WHEN NEW.version = 2 BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END;")
      expect(() => runMigrations(fresh)).toThrow('synthetic migration failure')
      expect(fresh.prepare('SELECT COUNT(*) AS n FROM schema_version').get()).toEqual({ n: 0 })
      expect(fresh.prepare("SELECT name FROM sqlite_master WHERE name = 'records'").get()).toBeUndefined()
    } finally { fresh.close() }
  })
  it('rolls merged-copy refreshes back if a later new-row insert fails', () => {
    insertSyncedRecord(db, remote('first'))
    expect(mergeSyncedRecordsIntoRecords(db)).toBe(1)
    insertSyncedRecord(db, remote('first', 2, 2000))
    insertSyncedRecord(db, remote('second'))
    db.exec("CREATE TRIGGER synthetic_merge_failure BEFORE INSERT ON records WHEN NEW.id = 'second' BEGIN SELECT RAISE(ABORT, 'synthetic merge failure'); END;")
    expect(() => mergeSyncedRecordsIntoRecords(db)).toThrow('synthetic merge failure')
    expect(db.prepare("SELECT input_tokens FROM records WHERE id = 'first'").get()).toEqual({ input_tokens: 1 })
  })
  it('continues to report only newly inserted merged copies, not refreshes', () => {
    insertSyncedRecord(db, remote('first'))
    expect(mergeSyncedRecordsIntoRecords(db)).toBe(1)
    insertSyncedRecord(db, remote('first', 2, 2000))
    expect(mergeSyncedRecordsIntoRecords(db)).toBe(0)
    expect(db.prepare("SELECT input_tokens FROM records WHERE id = 'first'").get()).toEqual({ input_tokens: 2 })
  })

  it('serializes the schema-version read across two actual local processes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiusage-migration-boundary-'))
    const databasePath = join(root, 'synthetic.db')
    const ready = join(root, 'ready')
    const go = join(root, 'go')
    const worker = fileURLToPath(new URL('../helpers/migration-worker.mjs', import.meta.url))
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
    const start = (mode: string) => {
      const child = spawn(process.execPath, ['--import', loader, worker, databasePath, mode, ready, go], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', bytes => { output += bytes.toString() })
      child.stderr.on('data', bytes => { output += bytes.toString() })
      const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', code => resolve({ code, output }))
      })
      return { child, done }
    }
    const first = start('pause')
    let second: ReturnType<typeof start> | undefined
    try {
      const deadline = Date.now() + 5000
      while (!existsSync(ready)) {
        if (Date.now() >= deadline) throw new Error('First migration worker did not reach the version-read barrier')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      second = start('normal')
      await Promise.race([second.done, new Promise(resolve => setTimeout(resolve, 3000))])
      writeFileSync(go, 'go')
      const results = await Promise.all([first.done, second.done])
      expect(results.map(result => ({ code: result.code, output: result.output.trim() }))).toEqual([
        { code: 0, output: 'migration-ok' }, { code: 0, output: 'migration-ok' },
      ])
    } finally {
      writeFileSync(go, 'go')
      await Promise.all([first.done, ...(second ? [second.done] : [])])
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})
