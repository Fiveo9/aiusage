import type Database from 'better-sqlite3'
import type { StatsRecord, ToolCallRecord } from '@aiusage/core'
import { calculateCost, generateOrphanToolCallId, inferProvider, parseTimestamp, recordIdFor, type RecordIdBuilder } from '@aiusage/core'
import type { ZcodeCursor, ZcodeToolCursor } from '../watermark.js'

export type { ZcodeCursor, ZcodeToolCursor }

export interface ZcodeImportOptions {
  dbPath: string
  device: string
  deviceInstanceId: string
  /** Builds record ids (see recordIdFor); runParse passes recordIdsForReread. */
  recordId?: RecordIdBuilder
  platform?: string
  now: number
  cursor: ZcodeCursor | null
  toolCursor: ZcodeToolCursor | null
  exchangeRate?: number
}

export interface ZcodeImportResult {
  records: StatsRecord[]
  toolCalls: ToolCallRecord[]
  nextCursor: ZcodeCursor | null
  nextToolCursor: ZcodeToolCursor | null
  errors: string[]
}

interface ZcodeModelUsageRow {
  id: string
  session_id: string
  model_id: string
  status: string
  started_at: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  directory?: string | null
}

interface ZcodeToolUsageRow {
  id: string
  tool_name: string
  status: string
  started_at: number
}

/**
 * Normalize a ZCode model_id for provider inference and price matching.
 *
 * ZCode stores model names in their vendor display form (e.g. "GLM-5.2"),
 * while the provider map and price table key on lowercase prefixes
 * (e.g. "glm-"). Lowercasing lets both lookups succeed without changes
 * to the shared provider/pricing tables.
 */
function normalizeZcodeModel(value: unknown): string {
  if (typeof value !== 'string') return 'unknown'
  const trimmed = value.trim()
  if (!trimmed) return 'unknown'
  return trimmed.toLowerCase()
}

function advanceCursor(cursor: ZcodeCursor | null, row: { id: string; started_at: number }): ZcodeCursor {
  const lastStartedAt = parseTimestamp(row.started_at, 0, 'ms')
  const lastId = String(row.id)
  if (cursor && (cursor.lastStartedAt > lastStartedAt || (cursor.lastStartedAt === lastStartedAt && cursor.lastId >= lastId))) return cursor
  return { lastStartedAt, lastId }
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * Parse ZCode CLI usage data from its SQLite database.
 *
 * ZCode stores per-request token usage in the `model_usage` table and tool
 * invocations in the `tool_usage` table. The two are related only through
 * `turn_id` (a multi-to-multi link), so tool calls are emitted as orphans
 * (recordId = null) — they carry no parent token record. Each table is read
 * incrementally using its own (started_at, id) cursor.
 *
 * Only completed model_usage rows with non-zero token usage are emitted.
 * Tool calls from completed tool_usage rows are always emitted.
 */
export function runParseZcode(db: Database.Database, options: ZcodeImportOptions): ZcodeImportResult {
  const { dbPath, device, deviceInstanceId, platform, now, cursor, toolCursor, exchangeRate } = options
  const records: StatsRecord[] = []
  const toolCalls: ToolCallRecord[] = []
  const errors: string[] = []
  let nextCursor: ZcodeCursor | null = null
  let nextToolCursor: ZcodeToolCursor | null = null

  // --- Token records (model_usage) ---
  const modelRows = db.prepare(`
    SELECT m.id, m.session_id, m.model_id, m.status, m.started_at,
           m.input_tokens, m.output_tokens, m.reasoning_tokens,
           m.cache_creation_input_tokens, m.cache_read_input_tokens,
           s.directory
    FROM model_usage m
    LEFT JOIN session s ON s.id = m.session_id
    WHERE m.status IN ('completed', 'running')
      AND (m.status = 'running' OR m.started_at > ? OR (m.started_at = ? AND m.id > ?)
        OR m.id IN (SELECT value FROM json_each(?)))
    ORDER BY m.started_at, m.id
  `).all(
    cursor?.lastStartedAt ?? 0,
    cursor?.lastStartedAt ?? 0,
    cursor?.lastId ?? '',
    JSON.stringify(cursor?.pendingIds ?? []),
  ) as ZcodeModelUsageRow[]

  const pendingIds: string[] = []
  for (const row of modelRows) {
    nextCursor = advanceCursor(nextCursor ?? cursor, row)
    if (row.status === 'running') {
      pendingIds.push(row.id)
      continue
    }

    const inputTokens = tokenCount(row.input_tokens)
    const outputTokens = tokenCount(row.output_tokens)
    const thinkingTokens = tokenCount(row.reasoning_tokens)
    const cacheReadTokens = tokenCount(row.cache_read_input_tokens)
    const cacheWriteTokens = tokenCount(row.cache_creation_input_tokens)

    if (inputTokens + outputTokens + thinkingTokens + cacheReadTokens + cacheWriteTokens === 0) continue

    const model = normalizeZcodeModel(row.model_id)
    const provider = inferProvider(model)
    const ts = parseTimestamp(row.started_at, 0, 'ms')
    const recordId = recordIdFor(options, `${dbPath}:${row.id}`, ts)

    const tokenArgs = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, thinkingTokens }
    const calculatedCost = model !== 'unknown' ? calculateCost(model, tokenArgs, exchangeRate) : 0

    records.push({
      id: recordId,
      ts,
      ingestedAt: now,
      updatedAt: now,
      lineOffset: 0,
      tool: 'zcode',
      model,
      provider,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      thinkingTokens,
      cost: calculatedCost,
      costSource: calculatedCost > 0 ? 'pricing' : 'unknown',
      sessionId: String(row.session_id ?? 'unknown'),
      sourceFile: dbPath,
      device,
      deviceInstanceId,
      platform,
      cwd: typeof row.directory === 'string' && row.directory ? row.directory : '',
    })
  }

  // --- Tool calls (tool_usage), emitted as orphans ---
  const toolRows = db.prepare(`
    SELECT id, tool_name, status, started_at
    FROM tool_usage
    WHERE status IN ('completed', 'running')
      AND (status = 'running' OR started_at > ? OR (started_at = ? AND id > ?)
        OR id IN (SELECT value FROM json_each(?)))
    ORDER BY started_at, id
  `).all(
    toolCursor?.lastStartedAt ?? 0,
    toolCursor?.lastStartedAt ?? 0,
    toolCursor?.lastId ?? '',
    JSON.stringify(toolCursor?.pendingIds ?? []),
  ) as ZcodeToolUsageRow[]

  const pendingToolIds: string[] = []
  for (const row of toolRows) {
    nextToolCursor = advanceCursor(nextToolCursor ?? toolCursor, row)
    if (row.status === 'running') {
      pendingToolIds.push(row.id)
      continue
    }
    const name = typeof row.tool_name === 'string' && row.tool_name.trim() ? row.tool_name.trim() : 'unknown'
    const ts = parseTimestamp(row.started_at, 0, 'ms')
    toolCalls.push({
      id: generateOrphanToolCallId('zcode', recordIdFor(options, `${dbPath}:tool:${row.id}`, 0), 0, 0),
      recordId: null,
      name,
      ts,
      callIndex: 0,
      tool: 'zcode',
    })
  }

  return {
    records,
    toolCalls,
    nextCursor: nextCursor ? { ...nextCursor, pendingIds } : cursor?.pendingIds?.length ? { ...cursor, pendingIds } : null,
    nextToolCursor: nextToolCursor ? { ...nextToolCursor, pendingIds: pendingToolIds } : toolCursor?.pendingIds?.length ? { ...toolCursor, pendingIds: pendingToolIds } : null,
    errors,
  }
}
