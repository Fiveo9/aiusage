import { join } from 'node:path'
import Database from 'better-sqlite3'

/**
 * Take the lock that lets one cloud sync run at a time per installation, or
 * return `null` when another sync holds it. The result releases the lock.
 *
 * `serve` and `aiusage sync` are separate processes, so the lock has to work
 * between processes. It is an exclusive SQLite transaction on a database file
 * of its own, held on a connection of its own: the operating system's file
 * lock behind it is taken atomically and goes away with the process that
 * holds it, so there is no stale lock to detect or take over, and nothing a
 * second process could remove by mistake. Nothing is ever written to the
 * file, and no other connection uses it, so holding the transaction across
 * network requests blocks no one but another cloud sync.
 */
export function acquireCloudSyncLock(aiusageDir: string): (() => void) | null {
  const lockDb = new Database(join(aiusageDir, 'cloud-sync.lock'), { timeout: 0 })
  try {
    lockDb.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    lockDb.close()
    const code = (error as { code?: string }).code
    if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) return null
    throw error
  }
  return () => {
    try {
      lockDb.exec('ROLLBACK')
    } finally {
      lockDb.close()
    }
  }
}
