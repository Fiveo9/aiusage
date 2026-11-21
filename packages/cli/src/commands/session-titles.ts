import Database from 'better-sqlite3'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { NEXT_UPDATED_AT } from '../db/record-version.js'

type Titles = Record<string, string>
type Source = { tool: string; source_file: string; session_id: string }

export function normalizeSessionTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const title = value.replace(/\u0000/g, '').trim()
  return title || undefined
}

// Only metadata with an explicit title is accepted. Never use prompts, messages,
// compaction summaries, filenames, or project directories as a session title.
export function titleFromMetadata(tool: string, row: any): { id: string; title: string } | undefined {
  if (!row || typeof row !== 'object') return undefined
  const id = tool === 'codex' ? row.id : row.sessionId
  const title = normalizeSessionTitle(tool === 'codex' ? row.thread_name : row.customTitle)
  if (typeof id !== 'string' || !id || !title) return undefined
  if (tool === 'claude-code' && row.type !== 'custom-title') return undefined
  return { id, title }
}

function codexIndex(sourceFile: string): string | undefined {
  let directory = dirname(sourceFile)
  while (dirname(directory) !== directory) {
    if (['sessions', 'archived_sessions'].includes(basename(directory))) {
      return join(dirname(directory), 'session_index.jsonl')
    }
    directory = dirname(directory)
  }
  return undefined
}

async function readJsonlTitles(file: string, tool: string): Promise<Titles> {
  const titles: Titles = Object.create(null)
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    try {
      const entry = titleFromMetadata(tool, JSON.parse(line))
      if (entry) titles[entry.id] = entry.title
    } catch {
      // An interrupted final line must not hide earlier complete metadata.
    }
  }
  return titles
}

function readClaudeIndex(file: string): Titles {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const titles: Titles = Object.create(null)
  for (const entry of parsed.entries ?? []) {
    const title = normalizeSessionTitle(entry.customTitle) ?? normalizeSessionTitle(entry.summary)
    if (typeof entry.sessionId === 'string' && title) titles[entry.sessionId] = title
  }
  return titles
}

function readDatabaseTitles(file: string, table: 'session' | 'sessions'): Titles {
  const source = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const columns = source.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!['id', 'title'].every(name => columns.some(column => column.name === name))) return {}
    const rows = source.prepare(`SELECT id, title FROM ${table} WHERE title IS NOT NULL AND title != ''`).all() as { id: string; title: unknown }[]
    const titles: Titles = Object.create(null)
    for (const row of rows) {
      const title = normalizeSessionTitle(row.title)
      if (title) titles[row.id] = title
    }
    return titles
  } finally {
    source.close()
  }
}

function signature(file: string): string {
  const stat = statSync(file)
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

/** Refresh titles even when the usage watermark is at EOF (renames add no usage). */
export async function backfillSessionTitles(
  db: Database.Database,
  deviceInstanceId: string,
  filterTool?: string,
): Promise<number> {
  const sources = db.prepare(`
    SELECT DISTINCT tool, source_file, session_id FROM records
    WHERE origin = 'local' AND device_instance_id = ?
      AND tool IN ('codex', 'claude-code', 'opencode', 'kilocode', 'hermes')
      ${filterTool ? 'AND tool = ?' : ''}
  `).all(...(filterTool ? [deviceInstanceId, filterTool] : [deviceInstanceId])) as Source[]
  const loaded = new Map<string, Promise<Titles>>()

  function cached(file: string, read: () => Promise<Titles> | Titles, sqlite = false): Promise<Titles> {
    if (!loaded.has(file)) {
      loaded.set(file, (async () => {
        try {
          let stamp = signature(file)
          if (sqlite) {
            try { stamp += `:${signature(`${file}-wal`)}` } catch { stamp += ':no-wal' }
          }
          const saved = db.prepare('SELECT signature, titles_json FROM session_title_sources WHERE source_file = ?').get(file) as { signature: string; titles_json: string } | undefined
          if (saved?.signature === stamp) return JSON.parse(saved.titles_json) as Titles
          const titles = await read()
          let after = signature(file)
          if (sqlite) {
            try { after += `:${signature(`${file}-wal`)}` } catch { after += ':no-wal' }
          }
          if (after === stamp) {
            db.prepare(`INSERT INTO session_title_sources (source_file, signature, titles_json) VALUES (?, ?, ?)
              ON CONFLICT(source_file) DO UPDATE SET signature = excluded.signature, titles_json = excluded.titles_json
            `).run(file, stamp, JSON.stringify(titles))
          }
          return titles
        } catch {
          // Missing/locked/older source metadata cannot erase an already known title.
          // Do not cache failures, so the next import can retry.
          return {}
        }
      })())
    }
    return loaded.get(file)!
  }

  const update = db.prepare(`UPDATE records SET session_title = ?, updated_at = ${NEXT_UPDATED_AT}
    WHERE origin = 'local' AND device_instance_id = ? AND tool = ?
      AND source_file = ? AND session_id = ? AND session_title != ?`)
  let changed = 0
  for (const row of sources) {
    let title: string | undefined
    if (row.tool === 'codex') {
      const index = codexIndex(row.source_file)
      if (index) {
        const titles = await cached(index, () => readJsonlTitles(index, 'codex'))
        // Older imports kept the rollout timestamp before the UUID in session_id.
        const uuid = row.session_id.match(/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i)?.[1]
        title = titles[row.session_id] ?? (uuid ? titles[uuid] : undefined)
      }
    } else if (row.tool === 'claude-code') {
      const index = join(dirname(row.source_file), 'sessions-index.json')
      const id = basename(row.session_id.replace(/\\/g, '/'))
      const indexed = (await cached(index, () => readClaudeIndex(index)))[id]
      const custom = (await cached(row.source_file, () => readJsonlTitles(row.source_file, 'claude-code')))[id]
      title = custom ?? indexed
    } else {
      const file = row.tool === 'hermes' ? row.source_file.split(':session:')[0] : row.source_file
      title = (await cached(file, () => readDatabaseTitles(file, row.tool === 'hermes' ? 'sessions' : 'session'), true))[row.session_id]
    }
    title = normalizeSessionTitle(title)
    if (title) changed += update.run(title, Date.now(), deviceInstanceId, row.tool, row.source_file, row.session_id, title).changes
  }
  return changed
}
