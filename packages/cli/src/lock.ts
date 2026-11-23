import { lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'

const held = new Map<string, () => void>()

/** Dedicated connection: an OS lock survives awaits and is released on crash. */
export function acquireExclusiveLock(lockPath: string): (() => void) | null {
  try {
    const info = lstatSync(lockPath)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe lock file')
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err
  }
  const db = new Database(lockPath, { timeout: 0 })
  try {
    // A legacy PID/corrupt file is not ours to overwrite or reclaim.
    db.pragma('schema_version')
    db.exec('BEGIN EXCLUSIVE')
  } catch (err: any) {
    db.close()
    if (typeof err.code === 'string' && (err.code.startsWith('SQLITE_BUSY') || err.code === 'SQLITE_NOTADB')) return null
    throw err
  }
  let released = false
  return () => {
    if (released) return
    released = true
    try { db.exec('ROLLBACK') } finally { db.close() }
  }
}

/** Shared by sync, repair and remote clean, including the shared Git cache. */
export function acquireFileSyncLock(aiusageDir: string): (() => void) | null {
  return acquireExclusiveLock(join(aiusageDir, 'file-sync.lock'))
}

export function acquireLock(lockPath: string): boolean {
  const key = resolve(lockPath)
  if (held.has(key)) return false
  try {
    const release = acquireExclusiveLock(key)
    if (!release) return false
    held.set(key, release)
    return true
  } catch {
    return false
  }
}

export function releaseLock(lockPath: string): void {
  const key = resolve(lockPath)
  const release = held.get(key)
  if (release) {
    held.delete(key)
    release()
  }
}

export function isLocked(lockPath: string): boolean {
  if (held.has(resolve(lockPath))) return true
  try {
    lstatSync(lockPath)
  } catch (err: any) {
    return err.code !== 'ENOENT'
  }
  try {
    const release = acquireExclusiveLock(lockPath)
    if (!release) return true
    release()
    return false
  } catch {
    return true
  }
}
