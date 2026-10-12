import type Database from 'better-sqlite3'
import type { ToolCallRecord } from '@aiusage/core'
import { generateToolCallId } from '@aiusage/core'

export function insertToolCall(db: Database.Database, tc: ToolCallRecord): void {
  db.prepare(`
    INSERT OR REPLACE INTO tool_calls (id, record_id, tool, name, ts, call_index)
    VALUES (@id, @recordId, @tool, @name, @ts, @callIndex)
  `).run({
    id: tc.id,
    recordId: tc.recordId ?? null,
    tool: tc.recordId ? null : (tc as any).tool,
    name: tc.name,
    ts: tc.ts,
    callIndex: tc.callIndex,
  })
}

/** The columns a positional tool-call id is built from. */
export interface ToolCallIdRow {
  id: string
  record_id: string
  name: string
  ts: number
  call_index: number
}

/**
 * True when a tool call's id is the hash of its own record id, name,
 * timestamp and call index: the scheme every Claude Code tool call used
 * before ids were keyed on the `tool_use` block. The row carries everything
 * that hash was built from, so no flag is needed to tell the schemes apart.
 */
export function hasPositionalToolCallId(row: ToolCallIdRow): boolean {
  return row.id === generateToolCallId(row.record_id, row.name, row.ts, row.call_index)
}

/**
 * Delete the tool calls of `recordId` that are stored under a positional id
 * (see `hasPositionalToolCallId`). Used when a Claude Code log is read from
 * its start: its calls are about to be written under block-keyed ids, and
 * `insertToolCall` only replaces a row with the same id, so a row left under
 * the old id would count its call twice. Returns the number deleted.
 */
export function deletePositionalToolCalls(db: Database.Database, recordId: string): number {
  const rows = db.prepare(
    'SELECT id, record_id, name, ts, call_index FROM tool_calls WHERE record_id = ?'
  ).all(recordId) as ToolCallIdRow[]
  let deleted = 0
  for (const row of rows) {
    if (!hasPositionalToolCallId(row)) continue
    deleted += db.prepare('DELETE FROM tool_calls WHERE id = ?').run(row.id).changes
  }
  return deleted
}

export function getToolCallsByRecordId(db: Database.Database, recordId: string | null): ToolCallRecord[] {
  const rows = recordId === null
    ? db.prepare('SELECT * FROM tool_calls WHERE record_id IS NULL').all() as any[]
    : db.prepare('SELECT * FROM tool_calls WHERE record_id = ?').all(recordId) as any[]

  return rows.map(mapRowToToolCall)
}

export function getToolCallStats(db: Database.Database): Array<{ name: string; count: number }> {
  return db.prepare(`
    SELECT name, COUNT(*) as count
    FROM tool_calls
    GROUP BY name
    ORDER BY count DESC
  `).all() as Array<{ name: string; count: number }>
}

export function deleteOrphanToolCalls(db: Database.Database, beforeTs: number): number {
  const result = db.prepare(
    'DELETE FROM tool_calls WHERE record_id IS NULL AND ts < ?'
  ).run(beforeTs)
  return result.changes
}

function mapRowToToolCall(row: any): ToolCallRecord {
  return {
    id: row.id,
    recordId: row.record_id,
    name: row.name,
    ts: row.ts,
    callIndex: row.call_index,
  }
}
