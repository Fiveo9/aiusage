import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '../src/json-file.js'
import { getState, setState } from '../src/init.js'

const ORIGINAL = JSON.stringify({ deviceInstanceId: '11111111-2222-3333-4444-555555555555', lastSyncStatus: 'ok' })

// A rename replaces a read-only file on POSIX, so the temporary-file write
// must check the file itself. Root passes every access check, so skip there.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

describe.skipIf(isRoot)('a read-only file is not replaced by the temporary-file write (#104)', () => {
  let dir: string
  let statePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiusage-read-only-'))
    statePath = join(dir, 'state.json')
    writeFileSync(statePath, ORIGINAL)
    chmodSync(statePath, 0o444)
  })

  afterEach(() => {
    chmodSync(statePath, 0o644)
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it('writeFileAtomic throws and leaves the file and the directory as they were', () => {
    expect(() => writeFileAtomic(statePath, '{"deviceInstanceId":"other"}')).toThrow()
    expect(readFileSync(statePath, 'utf-8')).toBe(ORIGINAL)
    expect(readdirSync(dir)).toEqual(['state.json'])
  })

  it('setState throws and keeps the stored state', () => {
    expect(() => setState(dir, { lastSyncStatus: 'failed' })).toThrow()
    expect(readFileSync(statePath, 'utf-8')).toBe(ORIGINAL)
    expect(getState(dir)?.lastSyncStatus).toBe('ok')
  })

  it('writes again once the file is writable', () => {
    chmodSync(statePath, 0o644)
    setState(dir, { lastSyncStatus: 'failed' })
    expect(getState(dir)?.lastSyncStatus).toBe('failed')
    expect(getState(dir)?.deviceInstanceId).toBe('11111111-2222-3333-4444-555555555555')
  })
})
