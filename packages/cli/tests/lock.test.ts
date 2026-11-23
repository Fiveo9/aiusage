import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { acquireLock, releaseLock, isLocked } from '../src/lock.js'

describe('SQLite owned lock', () => {
  let testDir: string
  let lockPath: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'aiusage-lock-test-'))
    lockPath = join(testDir, 'parse.lock')
  })

  afterEach(() => {
    releaseLock(lockPath)
    rmSync(testDir, { recursive: true, force: true })
  })

  it('acquires lock when no lock exists', () => {
    const acquired = acquireLock(lockPath)
    expect(acquired).toBe(true)
    expect(existsSync(lockPath)).toBe(true)
  })

  it('does not allow a second acquisition by the same process', () => {
    expect(acquireLock(lockPath)).toBe(true)
    expect(acquireLock(lockPath)).toBe(false)
  })

  it('releases lock', () => {
    acquireLock(lockPath)
    releaseLock(lockPath)
    expect(existsSync(lockPath)).toBe(true)
    expect(isLocked(lockPath)).toBe(false)
    expect(acquireLock(lockPath)).toBe(true)
  })

  it('checks if locked', () => {
    expect(isLocked(lockPath)).toBe(false)
    acquireLock(lockPath)
    expect(isLocked(lockPath)).toBe(true)
    releaseLock(lockPath)
    expect(isLocked(lockPath)).toBe(false)
  })

  it('preserves a legacy PID file and never releases a file it does not own', () => {
    writeFileSync(lockPath, '999999999')
    expect(acquireLock(lockPath)).toBe(false)
    releaseLock(lockPath)
    expect(readFileSync(lockPath, 'utf8')).toBe('999999999')
  })

  it('serializes actual processes and releases the OS lock when its owner exits', async () => {
    const worker = fileURLToPath(new URL('./helpers/lock-worker.mjs', import.meta.url))
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
    const child = spawn(process.execPath, ['--import', loader, worker, lockPath], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    try {
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.once('data', bytes => bytes.toString().trim() === 'held' ? resolve() : reject(new Error('Synthetic worker failed to acquire lock')))
        child.once('error', reject)
        child.once('exit', () => reject(new Error('Synthetic worker exited before readiness')))
      })
      await ready
      expect(acquireLock(lockPath)).toBe(false)
      releaseLock(lockPath)
      expect(isLocked(lockPath)).toBe(true)
      child.kill()
      await done
      expect(acquireLock(lockPath)).toBe(true)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await done
    }
  })
})
