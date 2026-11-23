import type Database from 'better-sqlite3'
import type { StatsRecord, ToolCallRecord } from '@aiusage/core'
import { inferProvider, calculateCost, normalizeQoderModel, parseTimestamp, recordIdFor, type RecordIdBuilder } from '@aiusage/core'
import type { QoderCursor } from '../watermark.js'

export interface QoderImportOptions {
  dbPath: string
  device: string
  deviceInstanceId: string
  /** Builds record ids (see recordIdFor); runParse passes recordIdsForReread. */
  recordId?: RecordIdBuilder
  platform?: string
  now: number
  cursor: QoderCursor | null
  exchangeRate?: number
}

export interface QoderImportResult {
  records: StatsRecord[]
  toolCalls: ToolCallRecord[]
  nextCursor: QoderCursor | null
  errors: string[]
}

interface MessageRow {
  id: string
  session_id: string
  gmt_create: number
  token_info: string
  record_extra: string | null
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function parseModelKey(recordExtra: string | null): string {
  if (!recordExtra) return 'qoder-auto'
  try {
    const parsed = JSON.parse(recordExtra) as { modelConfig?: { key?: string } }
    const key = parsed?.modelConfig?.key?.trim() ?? ''
    const normalized = normalizeQoderModel(key)
    return normalized === 'unknown' ? 'qoder-auto' : normalized
  } catch {
    return 'qoder-auto'
  }
}

export function runParseQoder(
  db: Database.Database,
  options: QoderImportOptions,
): QoderImportResult {
  const { dbPath, device, deviceInstanceId, platform, now, cursor, exchangeRate } = options
  const records: StatsRecord[] = []
  const toolCalls: ToolCallRecord[] = []
  const errors: string[] = []
  let lastCursor: QoderCursor | null = null

  const messages = db
    .prepare(
      `SELECT m.id, m.session_id, m.gmt_create, m.token_info,
              r.extra AS record_extra
       FROM chat_message m
       LEFT JOIN chat_record r ON m.request_id = r.request_id
       WHERE m.role = 'assistant'
         AND length(m.token_info) > 2
         AND (m.gmt_create > ? OR (m.gmt_create = ? AND m.id > ?))
       ORDER BY m.gmt_create, m.id`,
    )
    .all(
      cursor?.lastGmtCreate ?? 0,
      cursor?.lastGmtCreate ?? 0,
      cursor?.lastId ?? '',
    ) as MessageRow[]

  for (const row of messages) {
    const ts = parseTimestamp(row.gmt_create, NaN, 'ms')
    if (!Number.isFinite(ts)) {
      errors.push(`message ${row.id}: invalid timestamp`)
      continue
    }
    lastCursor = { lastGmtCreate: ts, lastId: row.id }

    let tokenInfo: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number }
    try {
      tokenInfo = JSON.parse(row.token_info)
    } catch (e) {
      errors.push(`message ${row.id}: invalid token_info JSON: ${e instanceof Error ? e.message : e}`)
      continue
    }

    if (!tokenInfo || typeof tokenInfo !== 'object' || Array.isArray(tokenInfo)) continue

    const cacheReadTokens = tokenCount(tokenInfo.cached_tokens)
    // OpenAI API convention: prompt_tokens includes cached_tokens, so subtract
    // to avoid double-counting (unlike Anthropic where input_tokens excludes cache)
    const inputTokens = Math.max(0, tokenCount(tokenInfo.prompt_tokens) - cacheReadTokens)
    const outputTokens = tokenCount(tokenInfo.completion_tokens)

    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0) continue

    const model = parseModelKey(row.record_extra)
    const provider = inferProvider(model)

    const tokenArgs = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, thinkingTokens: 0 }
    const calculatedCost = calculateCost(model, tokenArgs, exchangeRate)
    const cost = calculatedCost
    const costSource: StatsRecord['costSource'] = calculatedCost > 0 ? 'pricing' : 'unknown'

    const recordId = recordIdFor(options, dbPath + ':' + row.id, ts)

    records.push({
      id: recordId,
      ts,
      ingestedAt: now,
      updatedAt: now,
      lineOffset: 0,
      tool: 'qoder',
      model,
      provider,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
      cost,
      costSource,
      sessionId: row.session_id,
      sourceFile: dbPath,
      device,
      deviceInstanceId,
      platform,
    })
  }

  return { records, toolCalls, nextCursor: lastCursor, errors }
}
