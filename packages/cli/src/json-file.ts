import { existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

/**
 * A settings file (`config.json`, `state.json`) that exists but cannot be
 * used. It is never treated as missing: a caller that defaulted and saved
 * would replace the user's settings, or the device identity, with defaults.
 * The message names the file and the problem, says that the file was left
 * untouched, and ends with `recovery`.
 */
export class JsonFileError extends Error {
  constructor(public readonly path: string, public readonly problem: string, recovery: string) {
    super(`Cannot use ${path}: ${problem}. The file was left untouched. ${recovery}`)
    this.name = 'JsonFileError'
  }
}

export type JsonFileRead =
  | { status: 'missing' }
  | { status: 'ok'; value: Record<string, unknown> }
  /** The file exists; `problem` completes the sentence "Cannot use <path>: ...". */
  | { status: 'invalid'; problem: string }

/** Read a file that holds one JSON object, telling "does not exist" apart from "cannot be used". */
export function readJsonObjectFile(path: string): JsonFileRead {
  if (!existsSync(path)) return { status: 'missing' }
  let content: string
  try {
    content = readFileSync(path, 'utf-8')
  } catch (error) {
    // Removed between the two calls.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'invalid', problem: `it could not be read (${error instanceof Error ? error.message : String(error)})` }
  }
  if (typeof content !== 'string' || content.trim() === '') return { status: 'invalid', problem: 'it is empty' }
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    return { status: 'invalid', problem: `it is not valid JSON (${error instanceof Error ? error.message : String(error)})` }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'invalid', problem: 'it does not contain a JSON object' }
  }
  return { status: 'ok', value: value as Record<string, unknown> }
}

/** Error codes Windows answers with while another process has the destination open. */
const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      if (attempt >= 5 || !BUSY_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1))
    }
  }
}

/**
 * Write `content` to `path` through a temporary file in the same directory
 * and a rename, as `leaderboard/credentials.ts` does. A reader in another
 * process sees the old file or the new one, never part of one, and a crash
 * mid-write leaves the old file in place.
 *
 * With `exclusive`, the file is only created: when it already exists nothing
 * is written and the result is `false`. Two processes creating it at the same
 * time end up with one file, the content of whichever came first; neither
 * path below ever replaces a file that is there.
 */
export function writeFileAtomic(path: string, content: string, options: { mode?: number; exclusive?: boolean } = {}): boolean {
  const tmpFile = `${path}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmpFile, content, { encoding: 'utf-8', mode: options.mode })
    if (!options.exclusive) {
      renameWithRetry(tmpFile, path)
      return true
    }
    try {
      // A hard link is created only if the name is free, complete content and all.
      linkSync(tmpFile, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      // A file system without hard links: create the file in place instead.
      // `wx` fails when the name is taken, so this cannot replace a file
      // another process created in the meantime; a reader that catches the
      // file half written finds it unusable and leaves it alone.
      try {
        writeFileSync(path, content, { encoding: 'utf-8', mode: options.mode, flag: 'wx' })
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw createError
      }
    }
    return true
  } finally {
    try { unlinkSync(tmpFile) } catch { /* renamed away, or cleanup best-effort */ }
  }
}
