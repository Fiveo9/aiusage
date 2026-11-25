import type Database from 'better-sqlite3'
import { LOCAL_RECORDS_WHERE } from '../db/records.js'

/** Strict calendar components: Date's normalisation must not accept invalid days. */
export function parseCalendarDate(value: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) throw new Error('Dates must use YYYY-MM-DD')
  const date = { year: Number(m[1]), month: Number(m[2]) - 1, day: Number(m[3]) }
  const check = new Date(0)
  check.setUTCFullYear(date.year, date.month, date.day)
  if (check.getUTCFullYear() !== date.year || check.getUTCMonth() !== date.month || check.getUTCDate() !== date.day) throw new Error('Invalid calendar date')
  return date
}

/**
 * Local midnight for a calendar date, expressed in ms since epoch. `dayOffset` is
 * applied to the calendar day (the Date constructor normalises overflow), so the
 * result is always the true start of that day even when DST skips midnight.
 */
export function localMidnightMs(date: { year: number; month: number; day: number }, dayOffset = 0): number {
  const value = new Date(0)
  value.setFullYear(date.year, date.month, date.day + dayOffset)
  value.setHours(0, 0, 0, 0)
  return value.getTime()
}

/** Format a ms timestamp as its local calendar date (YYYY-MM-DD). */
export function formatLocalDay(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Register `local_day(ts)` on the connection so SQL aggregations bucket timestamps by
 * local calendar day, matching the local-midnight boundaries used by date-range filters.
 * SQLite's own `strftime(..., 'unixepoch')` buckets by UTC date, and its `'localtime'`
 * modifier relies on the C runtime's timezone rather than the one Node uses.
 */
export function registerLocalDayFunction(db: Database.Database): void {
  db.function('local_day', { deterministic: true }, (ts: unknown) => {
    if (ts === null || ts === undefined) return null
    return formatLocalDay(Number(ts))
  })
}

/**
 * Bounds of a date range in ms since epoch: `start` inclusive, `end` exclusive.
 * A missing bound leaves that side open. The CLI's `summary` and `export` date
 * options use it too, so they count the same local days as the dashboard.
 */
export function getDateRangeBounds(range: string | null, from: string | null, to: string | null, weekStart: 0 | 1 = 1): { start?: number; end?: number } {
  if (range !== null && !SUMMARY_RANGES.includes(range)) throw new Error('Invalid range')
  if (from !== null || to !== null) {
    // Custom ranges come from a date picker as local calendar dates (YYYY-MM-DD).
    // Preset ranges use local-time boundaries, so custom ranges must too: start at
    // local midnight of `from`, end (exclusive) at local midnight of the day after `to`.
    // Parsing date-only strings with `new Date(str)` would interpret them as UTC.
    // Both boundaries are built from calendar components rather than by mutating a parsed
    // Date: where DST skips midnight (e.g. America/Santiago), the parsed start of `to` is
    // 01:00, and adding a day to that would leak an hour of the following day into the range.
    const start = from === null ? undefined : localMidnightMs(parseCalendarDate(from))
    const end = to === null ? undefined : localMidnightMs(parseCalendarDate(to), 1)
    if (start !== undefined && end !== undefined && start >= end) throw new Error('from must not be after to')
    return { ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) }
  }

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  if (range === 'week') {
    const dayOfWeek = today.getDay()
    const diff = (dayOfWeek - weekStart + 7) % 7
    const startOfWeek = new Date(today)
    startOfWeek.setDate(today.getDate() - diff)
    return { start: startOfWeek.getTime() }
  }
  if (range === 'month') {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    return { start: startOfMonth.getTime() }
  }
  if (range === 'last30') {
    const start = new Date(today)
    start.setDate(start.getDate() - 30)
    return { start: start.getTime() }
  }
  if (range === 'all') {
    return {}
  }
  // default: day
  return { start: today.getTime() }
}

export function getDateRangeFilter(range: string | null, from: string | null, to: string | null, prefix = '', weekStart: 0 | 1 = 1): { where: string; params: Record<string, unknown> } {
  const ts = prefix ? `${prefix}.ts` : 'ts'
  const { start, end } = getDateRangeBounds(range, from, to, weekStart)
  if (start === undefined) return end === undefined ? { where: '', params: {} } : { where: `AND ${ts} < @end`, params: { end } }
  if (end === undefined) return { where: `AND ${ts} >= @start`, params: { start } }
  return { where: `AND ${ts} >= @start AND ${ts} < @end`, params: { start, end } }
}

export interface DeviceFilter {
  /** SQL fragment for WHERE clause (prepend with AND) */
  where: string
  /** Named parameters for the WHERE fragment */
  params: Record<string, unknown>
  /** True when query should UNION records + synced_records */
  useUnion: boolean
  /** True when querying records table should exclude merged synced records */
  localOnly: boolean
  /** Only a known current identity can select the remote-only table. */
  remoteOnly?: boolean
}

export function getToolFilter(tool: string | null, prefix = ''): { where: string; params: Record<string, unknown> } {
  if (!tool) return { where: '', params: {} }
  const col = prefix ? `${prefix}.tool` : 'tool'
  return { where: `AND ${col} = @tool`, params: { tool } }
}

export function classifyToolCall(name: string): 'mcp' | 'skill' | 'builtin' {
  if (name.startsWith('mcp__')) return 'mcp'
  if (name.startsWith('skill__') || name === 'Skill') return 'skill'
  return 'builtin'
}

export function parseMcpName(name: string): { server: string; action: string; display: string } {
  const withoutPrefix = name.slice(5)
  const idx = withoutPrefix.indexOf('__')
  if (idx === -1) return { server: withoutPrefix, action: '', display: withoutPrefix }
  return {
    server: withoutPrefix.slice(0, idx),
    action: withoutPrefix.slice(idx + 2),
    display: `${withoutPrefix.slice(0, idx)} / ${withoutPrefix.slice(idx + 2)}`,
  }
}

export function getToolTypeFilter(toolType: string | null): string {
  if (toolType === 'mcp') return "AND tc.name LIKE 'mcp\\_\\_%' ESCAPE '\\'"
  if (toolType === 'skill') return "AND (tc.name LIKE 'skill\\_\\_%' ESCAPE '\\' OR tc.name = 'Skill')"
  if (toolType === 'builtin') return "AND tc.name NOT LIKE 'mcp\\_\\_%' ESCAPE '\\' AND tc.name NOT LIKE 'skill\\_\\_%' ESCAPE '\\' AND tc.name != 'Skill'"
  return ''
}

// Rows merged from synced_records carry origin = 'synced' (see db/records.ts LOCAL_RECORDS_WHERE).
export const LOCAL_ONLY_FILTER = `AND ${LOCAL_RECORDS_WHERE}`

export function activityPaging(url: URL) {
  const integer = (key: string, fallback: number) => {
    const raw = url.searchParams.get(key)
    if (!raw) return fallback
    const parsed = Number(raw)
    return /^\d+$/.test(raw) && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
  }
  const page = integer('page', 1)
  const pageSize = Math.min(100, integer('pageSize', 50))
  const offset = (page - 1) * pageSize
  return page && pageSize && Number.isSafeInteger(offset) ? { page, pageSize, offset } : null
}

export function activityDeviceFilter(device: string | null, current: string | undefined, owner: string, origin: string) {
  if (device && device === current) return { where: `AND ${origin} = 'local'`, params: {} }
  if (device) return { where: `AND ${owner} = @activityDevice`, params: { activityDevice: device } }
  if (current) return { where: `AND (${origin} = 'local' OR ${owner} != @activityDevice)`, params: { activityDevice: current } }
  return { where: '', params: {} }
}

export function getDeviceFilter(
  device: string | null | undefined,
  currentDeviceInstanceId: string | undefined,
): DeviceFilter {
  if (!currentDeviceInstanceId) {
    // No device instance ID available — query only records (legacy behavior)
    return { where: device ? 'AND (device_instance_id = @deviceId OR device = @deviceId)' : '',
      params: device ? { deviceId: device } : {}, useUnion: false, localOnly: false }
  }

  if (!device) {
    // All devices: UNION local records + synced_records from other devices
    // localOnly=true prevents double-counting merged synced records
    return {
      where: '',
      params: { currentDeviceId: currentDeviceInstanceId },
      useUnion: true,
      localOnly: true,
    }
  }

  if (device === currentDeviceInstanceId) {
    // Current device only: query local records only (not merged synced from other devices)
    return { where: '', params: {}, useUnion: false, localOnly: true }
  }

  // Specific other device: query synced_records only
  return {
    where: 'AND device_instance_id = @deviceId',
    params: { deviceId: device },
    useUnion: false,
    localOnly: false,
    remoteOnly: true,
  }
}

/** One normalized record set for summary/tokens/cost/models/tools queries.
 * Legacy installations read records (including device aliases); a known local
 * identity reads local records or other owners' synced records, never its echo.
 * Activity routes keep their already-deduplicated activity views.
 */
export function buildDeviceRecordsCte(df: DeviceFilter, dr: SummaryFilter, tf: SummaryFilter): { cte: string; params: SummaryFilter['params'] } {
  const columns = 'tool, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, cost, cost_source, ts'
  const local = `SELECT ${columns}, session_id FROM records
    WHERE 1=1 ${df.useUnion ? '' : df.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${dr.where} ${tf.where}`
  const remote = `SELECT ${columns}, session_key AS session_id FROM synced_records
    WHERE 1=1 ${df.useUnion ? 'AND device_instance_id != @currentDeviceId' : df.where} ${dr.where} ${tf.where}`
  const selected = df.useUnion ? `${local} UNION ALL ${remote}` : df.remoteOnly ? remote : local
  return { cte: `WITH selected_records AS (${selected})`, params: { ...df.params, ...dr.params, ...tf.params } }
}

export type SummaryFilter = { where: string; params: Record<string, unknown> }

export const SUMMARY_RANGES = ['day', 'week', 'month', 'last30', 'all']
