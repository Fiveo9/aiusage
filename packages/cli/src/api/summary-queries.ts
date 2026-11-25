import type Database from 'better-sqlite3'
import { buildDeviceRecordsCte, type DeviceFilter, type SummaryFilter } from './query-helpers.js'

export interface SummaryTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  thinkingTokens: number
  totalTokens: number
  totalCost: number
  activeDays: number
  totalSessions: number
}

export function querySummaryTotals(db: Database.Database, df: DeviceFilter, dr: SummaryFilter, tf: SummaryFilter, includeByTool: boolean) {
  const { cte, params } = buildDeviceRecordsCte(df, dr, tf)
  const totals = db.prepare(`${cte}
    SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
           COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
           COALESCE(SUM(thinking_tokens), 0) AS thinkingTokens,
           COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens), 0) AS totalTokens,
           COALESCE(SUM(cost), 0) AS totalCost,
           COUNT(DISTINCT local_day(ts)) AS activeDays,
           COUNT(DISTINCT session_id) AS totalSessions
    FROM selected_records
  `).get(params) as SummaryTotals
  const byToolRows = includeByTool ? db.prepare(`${cte}
    SELECT tool,
           SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS tokens,
           SUM(cost) AS cost
    FROM selected_records GROUP BY tool ORDER BY cost DESC
  `).all(params) as Array<{ tool: string; tokens: number; cost: number }> : []
  return { totals, byToolRows }
}

export function queryTokens(db: Database.Database, df: DeviceFilter, dr: SummaryFilter, tf: SummaryFilter) {
  const { cte, params } = buildDeviceRecordsCte(df, dr, tf)
  const data = db.prepare(`${cte}
    SELECT local_day(ts) AS date,
           SUM(input_tokens) AS inputTokens,
           SUM(output_tokens) AS outputTokens,
           SUM(cache_read_tokens) AS cacheReadTokens,
           SUM(cache_write_tokens) AS cacheWriteTokens,
           SUM(thinking_tokens) AS thinkingTokens
    FROM selected_records GROUP BY date ORDER BY date
  `).all(params)
  return { data }
}

export function queryCosts(db: Database.Database, df: DeviceFilter, dr: SummaryFilter, tf: SummaryFilter) {
  const { cte, params } = buildDeviceRecordsCte(df, dr, tf)
  const data = db.prepare(`${cte}
    SELECT local_day(ts) AS date, SUM(cost) AS cost
    FROM selected_records GROUP BY date ORDER BY date
  `).all(params)
  const byToolRows = db.prepare(`${cte}
    SELECT tool, SUM(cost) AS cost FROM selected_records GROUP BY tool ORDER BY cost DESC
  `).all(params) as Array<{ tool: string; cost: number }>
  const byModelRows = db.prepare(`${cte}
    SELECT model, SUM(cost) AS cost FROM selected_records GROUP BY model ORDER BY cost DESC
  `).all(params) as Array<{ model: string; cost: number }>
  const byTool: Record<string, number> = {}
  const byModel: Record<string, number> = {}
  for (const row of byToolRows) byTool[row.tool] = row.cost
  for (const row of byModelRows) byModel[row.model] = row.cost

  // Provenance uses the same CTE as totals, including legacy/owner filtering.
  const sourceRows = db.prepare(`${cte}
    SELECT CASE WHEN cost_source IN ('log', 'pricing') THEN cost_source ELSE 'unknown' END AS source,
           COUNT(*) AS records, COALESCE(SUM(cost), 0) AS cost
    FROM selected_records GROUP BY source
  `).all(params) as Array<{ source: 'log' | 'pricing' | 'unknown'; records: number; cost: number }>
  const sources = { log: { records: 0, cost: 0 }, pricing: { records: 0, cost: 0 }, unknown: { records: 0, cost: 0 } }
  for (const row of sourceRows) sources[row.source] = { records: row.records, cost: row.cost }
  const totalRecords = sources.log.records + sources.pricing.records + sources.unknown.records
  const knownRecords = sources.log.records + sources.pricing.records
  const unpricedModels = db.prepare(`${cte}
    SELECT model, COUNT(*) AS records,
           SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS tokens
    FROM selected_records WHERE cost_source NOT IN ('log', 'pricing') OR cost_source IS NULL
    GROUP BY model ORDER BY records DESC, model ASC
  `).all(params)
  return { data, byTool, byModel, provenance: {
    sources, totalRecords, knownRecords, coverage: totalRecords ? knownRecords / totalRecords : null, unpricedModels,
  } }
}

export function queryModels(db: Database.Database, df: DeviceFilter, dr: SummaryFilter, tf: SummaryFilter) {
  const { cte, params } = buildDeviceRecordsCte(df, dr, tf)
  const rows = db.prepare(`${cte}
    SELECT model, provider, COUNT(*) AS callCount,
           SUM(input_tokens) AS inputTokens,
           SUM(output_tokens) AS outputTokens,
           SUM(cache_read_tokens) AS cacheReadTokens,
           SUM(cache_write_tokens) AS cacheWriteTokens,
           SUM(thinking_tokens) AS thinkingTokens,
           SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS totalTokens,
           SUM(cost) AS totalCost
    FROM selected_records WHERE model != 'unknown'
    GROUP BY model, provider ORDER BY totalTokens DESC
  `).all(params) as any[]
  const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0)
  return { models: rows.map(row => ({ ...row, percentage: totalTokens > 0 ? Math.round(row.totalTokens / totalTokens * 1000) / 10 : 0 })) }
}

export function queryTools(db: Database.Database, df: DeviceFilter, dr: SummaryFilter, tf: SummaryFilter) {
  const { cte, params } = buildDeviceRecordsCte(df, dr, tf)
  const tools = db.prepare(`${cte}
    SELECT tool, COUNT(DISTINCT session_id) AS sessionCount
    FROM selected_records GROUP BY tool ORDER BY sessionCount DESC
  `).all(params)
  return { tools }
}
