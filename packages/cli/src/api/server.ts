import http from 'node:http'
import path from 'node:path'
import { hostname, platform, tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { removePriceOverride, resolveExchangeRate, fetchExchangeRate, TOOLS, type PriceEntry } from '@aiusage/core'
import { AIUSAGE_DIR, buildConsentConfig, loadConfig, saveConfig, updateConfig } from '../config.js'
import { withSettingsLock } from '../settings-lock.js'
import { JsonFileError } from '../json-file.js'
import { GitHubAuthError } from '../github/errors.js'
import { deleteGitHubCredentials, saveGitHubCredentials } from '../github/credentials.js'
import { browserProtocol, isTrustedApiRequest } from './trust.js'
import { credentialStatus, publicSyncConfig, setSyncCredentials } from './credential-settings.js'
import { createGitHubDeviceSessions } from '../github/device-sessions.js'
import { safeGitHubError, validateRepo } from '../github/auth.js'
import type { Config, SyncConfig } from '../config.js'
import { setSyncConsent } from '../init.js'
import { generateConsentFingerprint } from '../sync/consent.js'
import { getSyncTarget } from '../sync/target.js'
import { extractProject, extractProjectFromCwd } from './project-extraction.js'
import { getSessionTitle } from '../db/session-titles.js'
import { discoverTools } from '../discovery.js'
import type { SyncStartResult, SyncStatusSnapshot } from '../sync/runtime.js'
import { queryAllQuotas } from '../quota.js'
import {
  buildAuthCookie,
  buildClearAuthCookie,
  getDashboardPassword,
  isAuthenticated,
  shouldProtectApiPath,
  verifyPassword,
} from '../auth.js'
import { getSiteUrl } from '../site-url.js'
import { hasCredentials } from '../device-auth/credentials.js'
import { isKelivoSourceFile, runParseKelivo } from '../commands/parse-kelivo.js'
import { recalcPricing } from '../commands/recalc.js'
import { insertChangedRecords, LOCAL_RECORDS_WHERE, recordIdsForReread } from '../db/records.js'
import { AsyncTaskQueue, type AsyncTaskQueueStatus } from '../db/write-queue.js'
import { getPricingRegistrySummary, getUserAliasBindings, listLocalModelBindings, listPricingAliasTargets, listPricingModels, loadPricingRuntime, removeUserPricingAlias, resetUserPriceToSynced, setUserPrice, setUserPricingAlias, syncPricingFromLitellm } from '../pricing-registry.js'
import type { DetectedTool } from '../discovery.js'
import { BodyTooLargeError, readJsonBody, readBodyBuffer } from './request-body.js'


function getManualImportMetadata(db: Database.Database): Record<string, { lastImportedAt: number }> {
  const rows = db.prepare(`
    SELECT tool, MAX(ingested_at) AS lastImportedAt
    FROM records
    WHERE tool IN ('kelivo')
    GROUP BY tool
  `).all() as Array<{ tool: string; lastImportedAt: number | null }>

  const metadata: Record<string, { lastImportedAt: number }> = {}
  for (const row of rows) {
    if (typeof row.lastImportedAt === 'number') {
      metadata[row.tool] = { lastImportedAt: row.lastImportedAt }
    }
  }
  return metadata
}

function attachManualImportMetadata(tools: DetectedTool[], db: Database.Database): DetectedTool[] {
  const metadata = getManualImportMetadata(db)
  return tools.map((tool) => {
    const toolMetadata = metadata[tool.tool]
    return toolMetadata ? { ...tool, ...toolMetadata } : tool
  })
}

function countExistingRecordIds(db: Database.Database, ids: string[]): number {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return 0

  const stmt = db.prepare('SELECT 1 FROM records WHERE id = ? LIMIT 1')
  let count = 0
  for (const id of uniqueIds) {
    if (stmt.get(id)) count++
  }
  return count
}

type PricingRecalcState = 'idle' | 'queued' | 'running' | 'done' | 'error'

interface PricingRecalcStatus {
  state: PricingRecalcState
  needsRecalc: boolean
  needsRecalcSince: number | null
  total: number
  processed: number
  updated: number
  skipped: number
  queueRunning: boolean
  queuePending: number
  startedAt: number | null
  finishedAt: number | null
  error: string | null
}

function emptyPricingRecalcStatus(): PricingRecalcStatus {
  return {
    state: 'idle',
    needsRecalc: false,
    needsRecalcSince: null,
    total: 0,
    processed: 0,
    updated: 0,
    skipped: 0,
    queueRunning: false,
    queuePending: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  }
}

/** Calendar components of a YYYY-MM-DD string (falls back to Date parsing for other formats). */
function parseCalendarDate(value: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (m) return { year: Number(m[1]), month: Number(m[2]) - 1, day: Number(m[3]) }
  const d = new Date(value)
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() }
}

/**
 * Local midnight for a calendar date, expressed in ms since epoch. `dayOffset` is
 * applied to the calendar day (the Date constructor normalises overflow), so the
 * result is always the true start of that day even when DST skips midnight.
 */
function localMidnightMs(date: { year: number; month: number; day: number }, dayOffset = 0): number {
  return new Date(date.year, date.month, date.day + dayOffset).getTime()
}

/** Format a ms timestamp as its local calendar date (YYYY-MM-DD). */
function formatLocalDay(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Register `local_day(ts)` on the connection so SQL aggregations bucket timestamps by
 * local calendar day, matching the local-midnight boundaries used by date-range filters.
 * SQLite's own `strftime(..., 'unixepoch')` buckets by UTC date, and its `'localtime'`
 * modifier relies on the C runtime's timezone rather than the one Node uses.
 */
function registerLocalDayFunction(db: Database.Database): void {
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
  if (from && to) {
    // Custom ranges come from a date picker as local calendar dates (YYYY-MM-DD).
    // Preset ranges use local-time boundaries, so custom ranges must too: start at
    // local midnight of `from`, end (exclusive) at local midnight of the day after `to`.
    // Parsing date-only strings with `new Date(str)` would interpret them as UTC.
    // Both boundaries are built from calendar components rather than by mutating a parsed
    // Date: where DST skips midnight (e.g. America/Santiago), the parsed start of `to` is
    // 01:00, and adding a day to that would leak an hour of the following day into the range.
    const startMs = localMidnightMs(parseCalendarDate(from))
    const endMs = localMidnightMs(parseCalendarDate(to), 1)
    return { start: startMs, end: endMs }
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

function getDateRangeFilter(range: string | null, from: string | null, to: string | null, prefix = '', weekStart: 0 | 1 = 1): { where: string; params: Record<string, unknown> } {
  const ts = prefix ? `${prefix}.ts` : 'ts'
  const { start, end } = getDateRangeBounds(range, from, to, weekStart)
  if (start === undefined) return { where: '', params: {} }
  if (end === undefined) return { where: `AND ${ts} >= @start`, params: { start } }
  return { where: `AND ${ts} >= @start AND ${ts} < @end`, params: { start, end } }
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function bodyTooLarge(res: http.ServerResponse): void {
  res.setHeader('Connection', 'close')
  json(res, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'JSON body exceeds the allowed size' } }, 413)
}

function isDatabaseLockedError(error: unknown): boolean {
  return error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message)
}

function databaseBusy(res: http.ServerResponse): void {
  json(res, {
    error: {
      code: 'DATABASE_BUSY',
      message: 'Database is busy. Wait for the current refresh, sync, or import to finish and retry.',
    },
  }, 503)
}

function multipartBoundary(contentType: string | string[] | undefined): string | null {
  const value = Array.isArray(contentType) ? contentType[0] : contentType
  if (!value) return null
  const match = value.match(/(?:^|;)\s*boundary=("([^"]+)"|[^;]+)/i)
  if (!match) return null
  return (match[2] ?? match[1]).replace(/^"|"$/g, '')
}

async function readMultipartFile(req: http.IncomingMessage): Promise<{ filename: string; data: Buffer } | null> {
  const maxFileBytes = 64 * 1024 * 1024
  const maxBodyBytes = maxFileBytes + 64 * 1024
  if (Number(req.headers['content-length']) > maxBodyBytes) {
    req.pause()
    throw new BodyTooLargeError()
  }
  const boundary = multipartBoundary(req.headers['content-type'])
  if (!boundary) return null

  const body = await readBodyBuffer(req, maxBodyBytes)
  const marker = Buffer.from(`--${boundary}`)
  let position = body.indexOf(marker)
  while (position !== -1) {
    position += marker.length
    if (body.subarray(position, position + 2).toString() === '--') return null
    if (body.subarray(position, position + 2).toString() === '\r\n') position += 2

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), position)
    if (headerEnd === -1) return null
    const headers = body.subarray(position, headerEnd).toString('utf-8')
    const filenameMatch = headers.match(/Content-Disposition:[^\r\n]*\bname="file"[^\r\n]*\bfilename="([^"]+)"/i)
    const dataStart = headerEnd + 4
    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), dataStart)
    if (nextBoundary === -1) return null
    if (filenameMatch) {
      const data = body.subarray(dataStart, nextBoundary)
      if (data.length > maxFileBytes) throw new BodyTooLargeError()
      return { filename: path.basename(filenameMatch[1]), data }
    }
    position = body.indexOf(marker, nextBoundary)
  }
  return null
}

function isKelivoBackupFilename(filename: string): boolean {
  return isKelivoSourceFile(filename)
}

async function proxyCloudSyncStatus(res: http.ServerResponse): Promise<void> {
  const upstream = new URL('/api/cli/sync/status', getSiteUrl())

  try {
    const response = await fetch(upstream, {
      headers: { Accept: 'application/json' },
    })
    const contentType = response.headers.get('content-type') || ''
    if (!response.ok || !contentType.includes('application/json')) {
      json(res, { enabled: false })
      return
    }

    const data = await response.json().catch(() => null)
    json(res, data && typeof data.enabled === 'boolean' ? data : { enabled: false })
  } catch {
    json(res, { enabled: false })
  }
}


export interface ApiServerOptions {
  currentDeviceInstanceId?: string
  onRefresh?: () => Promise<{ parsedCount: number; toolCallCount: number; errors: string[] }>
  onSyncStart?: () => SyncStartResult
  getSyncStatus?: () => SyncStatusSnapshot | null
  onConfigUpdated?: () => void
  runDbWrite?: <T>(task: () => T | Promise<T>) => Promise<T>
  getDbWriteQueueStatus?: () => AsyncTaskQueueStatus
}

interface DeviceFilter {
  /** SQL fragment for WHERE clause (prepend with AND) */
  where: string
  /** Named parameters for the WHERE fragment */
  params: Record<string, unknown>
  /** True when query should UNION records + synced_records */
  useUnion: boolean
  /** True when querying records table should exclude merged synced records */
  localOnly: boolean
}

function getToolFilter(tool: string | null, prefix = ''): { where: string; params: Record<string, unknown> } {
  if (!tool) return { where: '', params: {} }
  const col = prefix ? `${prefix}.tool` : 'tool'
  return { where: `AND ${col} = @tool`, params: { tool } }
}

function classifyToolCall(name: string): 'mcp' | 'skill' | 'builtin' {
  if (name.startsWith('mcp__')) return 'mcp'
  if (name.startsWith('skill__') || name === 'Skill') return 'skill'
  return 'builtin'
}

function parseMcpName(name: string): { server: string; action: string; display: string } {
  const withoutPrefix = name.slice(5)
  const idx = withoutPrefix.indexOf('__')
  if (idx === -1) return { server: withoutPrefix, action: '', display: withoutPrefix }
  return {
    server: withoutPrefix.slice(0, idx),
    action: withoutPrefix.slice(idx + 2),
    display: `${withoutPrefix.slice(0, idx)} / ${withoutPrefix.slice(idx + 2)}`,
  }
}

function getToolTypeFilter(toolType: string | null): string {
  if (toolType === 'mcp') return "AND tc.name LIKE 'mcp\\_\\_%' ESCAPE '\\'"
  if (toolType === 'skill') return "AND (tc.name LIKE 'skill\\_\\_%' ESCAPE '\\' OR tc.name = 'Skill')"
  if (toolType === 'builtin') return "AND tc.name NOT LIKE 'mcp\\_\\_%' ESCAPE '\\' AND tc.name NOT LIKE 'skill\\_\\_%' ESCAPE '\\' AND tc.name != 'Skill'"
  return ''
}

// Rows merged from synced_records carry origin = 'synced' (see db/records.ts LOCAL_RECORDS_WHERE).
const LOCAL_ONLY_FILTER = `AND ${LOCAL_RECORDS_WHERE}`

function activityPaging(url: URL) {
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

function activityDeviceFilter(device: string | null, current: string | undefined, owner: string, origin: string) {
  if (device && device === current) return { where: `AND ${origin} = 'local'`, params: {} }
  if (device) return { where: `AND ${owner} = @activityDevice`, params: { activityDevice: device } }
  if (current) return { where: `AND (${origin} = 'local' OR ${owner} != @activityDevice)`, params: { activityDevice: current } }
  return { where: '', params: {} }
}

function getDeviceFilter(
  device: string | null | undefined,
  currentDeviceInstanceId: string | undefined,
): DeviceFilter {
  if (!currentDeviceInstanceId) {
    // No device instance ID available — query only records (legacy behavior)
    return { where: '', params: {}, useUnion: false, localOnly: false }
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
  }
}

type SummaryFilter = { where: string; params: Record<string, unknown> }

interface SummaryTotals {
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

const SUMMARY_RANGES = ['day', 'week', 'month', 'last30', 'all']

/**
 * Aggregate totals (and optionally the per-tool breakdown) for the summary
 * endpoints. Shared by the authenticated /api/summary route and the public
 * /api/home-summary route so both report identical numbers.
 */
function querySummaryTotals(
  db: Database.Database,
  df: DeviceFilter,
  dr: SummaryFilter,
  tf: SummaryFilter,
  includeByTool: boolean,
): { totals: SummaryTotals; byToolRows: any[] } {
  let totals: any
  let byToolRows: any[] = []

  if (df.useUnion) {
    // All devices: UNION records + synced_records (excluding current device's synced copy)
    const unionSql = `
      SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, cost, ts, session_id
      FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
      UNION ALL
      SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, cost, ts, session_key AS session_id
      FROM synced_records WHERE device_instance_id != @currentDeviceId ${dr.where} ${tf.where}
    `
    totals = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
        COALESCE(SUM(thinking_tokens), 0) AS thinkingTokens,
        COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens), 0) AS totalTokens,
        COALESCE(SUM(cost), 0) AS totalCost,
        COUNT(DISTINCT local_day(ts)) AS activeDays,
        COUNT(DISTINCT session_id) AS totalSessions
      FROM (${unionSql})
    `).get({ ...dr.params, ...df.params, ...tf.params }) as any

    if (includeByTool) byToolRows = db.prepare(`
      SELECT tool, SUM(tokens) AS tokens, SUM(cost) AS cost FROM (
        SELECT tool,
               SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS tokens,
               SUM(cost) AS cost
        FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
        GROUP BY tool
        UNION ALL
        SELECT tool,
               SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS tokens,
               SUM(cost) AS cost
        FROM synced_records WHERE device_instance_id != @currentDeviceId ${dr.where} ${tf.where}
        GROUP BY tool
      ) GROUP BY tool ORDER BY cost DESC
    `).all({ ...dr.params, ...df.params, ...tf.params }) as any[]
  } else if (df.where) {
    // Specific other device: query synced_records only
    totals = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
        COALESCE(SUM(thinking_tokens), 0) AS thinkingTokens,
        COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens), 0) AS totalTokens,
        COALESCE(SUM(cost), 0) AS totalCost,
        COUNT(DISTINCT local_day(ts)) AS activeDays,
        COUNT(DISTINCT session_key) AS totalSessions
      FROM synced_records WHERE 1=1 ${df.where} ${dr.where} ${tf.where}
    `).get({ ...dr.params, ...df.params, ...tf.params }) as any

    if (includeByTool) byToolRows = db.prepare(`
      SELECT tool,
             SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS tokens,
             SUM(cost) AS cost
      FROM synced_records WHERE 1=1 ${df.where} ${dr.where} ${tf.where}
      GROUP BY tool ORDER BY cost DESC
    `).all({ ...dr.params, ...df.params, ...tf.params }) as any[]
  } else {
    // Current device or legacy: query records only
    totals = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
        COALESCE(SUM(thinking_tokens), 0) AS thinkingTokens,
        COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens), 0) AS totalTokens,
        COALESCE(SUM(cost), 0) AS totalCost,
        COUNT(DISTINCT local_day(ts)) AS activeDays,
        COUNT(DISTINCT session_id) AS totalSessions
      FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
    `).get({ ...dr.params, ...tf.params }) as any

    if (includeByTool) byToolRows = db.prepare(`
      SELECT tool,
             SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS tokens,
             SUM(cost) AS cost
      FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
      GROUP BY tool ORDER BY cost DESC
    `).all({ ...dr.params, ...tf.params }) as any[]
  }
  return { totals, byToolRows }
}

function summaryTotalsPayload(totals: SummaryTotals): SummaryTotals {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    thinkingTokens: totals.thinkingTokens,
    totalTokens: totals.totalTokens,
    totalCost: totals.totalCost,
    activeDays: totals.activeDays,
    totalSessions: totals.totalSessions,
  }
}

export function createApiServer(db: Database.Database, options?: ApiServerOptions): http.Server {
  registerLocalDayFunction(db)
  const githubDeviceAction = createGitHubDeviceSessions()
  const cfg = loadConfig()
  let weekStart: 0 | 1 = (cfg?.weekStart ?? 1) as 0 | 1
  const dashboardPassword = getDashboardPassword()
  const localWriteQueue = new AsyncTaskQueue()
  const runDbWrite = options?.runDbWrite ?? (<T>(task: () => T | Promise<T>) => localWriteQueue.run(task))
  const getDbWriteQueueStatus = options?.getDbWriteQueueStatus ?? (() => localWriteQueue.getStatus())
  let pricingRecalcStatus = emptyPricingRecalcStatus()
  let pricingNeedsRecalcSince: number | null = null
  let pricingRecalcGeneration = 0

  const currentPricingRecalcStatus = (): PricingRecalcStatus => {
    const status = {
      ...pricingRecalcStatus,
      needsRecalc: pricingNeedsRecalcSince != null,
      needsRecalcSince: pricingNeedsRecalcSince,
    }
    if (status.state !== 'queued') return status
    const queueStatus = getDbWriteQueueStatus()
    return {
      ...status,
      queueRunning: queueStatus.running,
      queuePending: queueStatus.pending,
    }
  }

  const markPricingNeedsRecalc = (): number => {
    pricingRecalcGeneration += 1
    pricingNeedsRecalcSince = Date.now()
    return pricingNeedsRecalcSince
  }

  const startPricingRecalc = (): { accepted: boolean; status: PricingRecalcStatus } => {
    if (pricingRecalcStatus.state === 'queued' || pricingRecalcStatus.state === 'running') {
      return { accepted: false, status: currentPricingRecalcStatus() }
    }

    const startedAt = Date.now()
    const startedGeneration = pricingRecalcGeneration

    pricingRecalcStatus = {
      ...emptyPricingRecalcStatus(),
      state: 'running',
      startedAt,
    }

    const runRecalc = async () => {
      pricingRecalcStatus = {
        ...pricingRecalcStatus,
        state: 'running',
        queueRunning: false,
        queuePending: 0,
        startedAt: pricingRecalcStatus.startedAt ?? Date.now(),
      }
      try {
        await recalcPricing(db, {
          currentDeviceInstanceId: options?.currentDeviceInstanceId,
          onProgress: (progress) => {
            pricingRecalcStatus = {
              ...pricingRecalcStatus,
              total: progress.total,
              processed: progress.processed,
              updated: progress.updatedCount,
              skipped: progress.skippedCount,
              state: 'running',
            }
          },
          betweenBatches: () => new Promise<void>((resolve) => setImmediate(resolve)),
        })
        if (pricingNeedsRecalcSince != null && pricingRecalcGeneration === startedGeneration) {
          pricingNeedsRecalcSince = null
        }
        pricingRecalcStatus = {
          ...pricingRecalcStatus,
          state: 'done',
          needsRecalc: pricingNeedsRecalcSince != null,
          needsRecalcSince: pricingNeedsRecalcSince,
          finishedAt: Date.now(),
          error: null,
        }
      } catch (error) {
        pricingRecalcStatus = {
          ...pricingRecalcStatus,
          state: 'error',
          finishedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    setImmediate(() => {
      void runRecalc().catch((error) => {
        pricingRecalcStatus = {
          ...pricingRecalcStatus,
          state: 'error',
          finishedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        }
      })
    })

    return { accepted: true, status: currentPricingRecalcStatus() }
  }

  const loginAttempts = new Map<string, number[]>()
  function loginRetryAfter(req: http.IncomingMessage): number {
    const now = Date.now()
    const cutoff = now - 60_000
    for (const [key, attempts] of loginAttempts) {
      const recent = attempts.filter(time => time > cutoff)
      if (recent.length) loginAttempts.set(key, recent)
      else loginAttempts.delete(key)
    }
    const key = req.socket.remoteAddress || 'unknown'
    const attempts = loginAttempts.get(key) || []
    if (attempts.length >= 10) return Math.max(1, Math.ceil((attempts[0] + 60_000 - now) / 1000))
    if (!loginAttempts.has(key) && loginAttempts.size >= 1024) return 60
    attempts.push(now)
    loginAttempts.set(key, attempts)
    return 0
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (!isTrustedApiRequest(req, dashboardPassword)) {
      json(res, { error: { code: 'FORBIDDEN', message: 'Untrusted API origin or host' } }, 403)
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === '/api/auth/status' && req.method === 'GET') {
      json(res, {
        enabled: dashboardPassword != null,
        authenticated: isAuthenticated(dashboardPassword, req.headers.cookie),
      })
      return
    }

    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req, 16 * 1024)
        if (body.password !== undefined && typeof body.password !== 'string') {
          json(res, { error: { code: 'INVALID_PARAM', message: 'password must be a string' } }, 400)
          return
        }
        if (dashboardPassword) {
          const retryAfter = loginRetryAfter(req)
          if (retryAfter) {
            res.setHeader('Retry-After', String(retryAfter))
            json(res, { error: { code: 'RATE_LIMITED', message: 'Too many login attempts' } }, 429)
            return
          }
        }
        if (!verifyPassword(dashboardPassword, typeof body.password === 'string' ? body.password : null)) {
          json(res, { error: { code: 'UNAUTHORIZED', message: 'Invalid password' } }, 401)
          return
        }

        if (dashboardPassword) {
          res.setHeader('Set-Cookie', buildAuthCookie(dashboardPassword, browserProtocol(req) === 'https:'))
        }
        json(res, { ok: true })
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          bodyTooLarge(res)
          return
        }
        json(res, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400)
      }
      return
    }

    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', buildClearAuthCookie(browserProtocol(req) === 'https:'))
      json(res, { ok: true })
      return
    }

    if (dashboardPassword && shouldProtectApiPath(url.pathname) && !isAuthenticated(dashboardPassword, req.headers.cookie)) {
      json(res, { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401)
      return
    }

    if (url.pathname === '/api/cli/sync/status' && req.method === 'GET') {
      await proxyCloudSyncStatus(res)
      return
    }

    const range = url.searchParams.get('range')
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')

    // Validate tool parameter early — same style as range validation
    const toolParam = url.searchParams.get('tool')
    if (toolParam && !(TOOLS as readonly string[]).includes(toolParam)) {
      json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid tool' } }, 400)
      return
    }

    try {
      // ── /api/home-summary ─────────────────────────────────────────
      // Deliberately public when a dashboard password is set (see auth.ts).
      // Only aggregate totals across all devices and tools are returned; the
      // device/tool filters and per-tool, tool-call, and MCP breakdowns are
      // reserved for the authenticated /api/summary route.
      if (url.pathname === '/api/home-summary') {
        if (range && !SUMMARY_RANGES.includes(range)) {
          json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid range' } }, 400)
          return
        }
        const df = getDeviceFilter(null, options?.currentDeviceInstanceId)
        const dr = getDateRangeFilter(range, null, null, '', weekStart)
        const { totals } = querySummaryTotals(db, df, dr, getToolFilter(null), false)
        json(res, summaryTotalsPayload(totals))
        return
      }

      // ── /api/summary ──────────────────────────────────────────────
      if (url.pathname === '/api/summary') {
        if (range && !SUMMARY_RANGES.includes(range)) {
          json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid range' } }, 400)
          return
        }
        const device = url.searchParams.get('device')
        const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
        const dr = getDateRangeFilter(range, from, to, '', weekStart)
        const tool = url.searchParams.get('tool')
        const tf = getToolFilter(tool)

        const { totals, byToolRows } = querySummaryTotals(db, df, dr, tf, true)

        const byTool: Record<string, { tokens: number; cost: number }> = {}
        for (const row of byToolRows) {
          byTool[row.tool] = { tokens: row.tokens, cost: row.cost }
        }

        const drJoin = getDateRangeFilter(range, from, to, 'tc', weekStart)
        const callDevice = activityDeviceFilter(device, options?.currentDeviceInstanceId, 'tc.owner', 'tc.origin')
        const tfJoin = getToolFilter(tool, 'r')
        const tfJoinO = tfJoin.where.replaceAll('r.tool', 'COALESCE(r.tool, tc.tool)')
        const topToolCalls = db.prepare(`
          SELECT tc.name, COUNT(*) AS count
          FROM activity_tool_calls tc
          LEFT JOIN records r ON r.id = tc.record_id
          WHERE 1=1 ${callDevice.where} ${drJoin.where} ${tfJoinO}
          GROUP BY tc.name ORDER BY count DESC LIMIT 10
        `).all({ ...drJoin.params, ...callDevice.params, ...tfJoin.params }) as any[]

        const topMcpServersRaw = db.prepare(`
          SELECT tc.name, COUNT(*) AS count
          FROM activity_tool_calls tc
          LEFT JOIN records r ON r.id = tc.record_id
          WHERE tc.name LIKE 'mcp\\_\\_%' ESCAPE '\\'
            AND INSTR(SUBSTR(tc.name, 6), '__') > 0
            ${callDevice.where} ${drJoin.where} ${tfJoinO}
          GROUP BY tc.name ORDER BY count DESC
        `).all({ ...drJoin.params, ...callDevice.params, ...tfJoin.params }) as any[]

        // Aggregate by server (multiple mcp__server__X tools collapse to one server)
        const mcpServerMap = new Map<string, number>()
        for (const row of topMcpServersRaw) {
          const server = parseMcpName(row.name).server
          mcpServerMap.set(server, (mcpServerMap.get(server) ?? 0) + row.count)
        }
        const topMcpServers = Array.from(mcpServerMap.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([server, count]) => ({ server, count }))

        json(res, {
          ...summaryTotalsPayload(totals),
          byTool,
          topToolCalls,
          topMcpServers,
        })
        return
      }

      // ── /api/tokens ───────────────────────────────────────────────
      if (url.pathname === '/api/tokens') {
        const dr = getDateRangeFilter(range, from, to, '', weekStart)
        const device = url.searchParams.get('device')
        const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
        const tool = url.searchParams.get('tool')
        const tf = getToolFilter(tool)

        let sql: string
        let params: Record<string, unknown>

        if (df.useUnion) {
          sql = `
            SELECT local_day(ts) AS date,
                   SUM(input_tokens) AS inputTokens,
                   SUM(output_tokens) AS outputTokens,
                   SUM(cache_read_tokens) AS cacheReadTokens,
                   SUM(cache_write_tokens) AS cacheWriteTokens,
                   SUM(thinking_tokens) AS thinkingTokens
            FROM (
              SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, ts FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
              UNION ALL
              SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, ts FROM synced_records WHERE device_instance_id != @currentDeviceId ${dr.where} ${tf.where}
            )
            GROUP BY date ORDER BY date`
          params = { ...dr.params, currentDeviceId: df.params.currentDeviceId, ...tf.params }
        } else if (device && device !== options?.currentDeviceInstanceId) {
          sql = `
            SELECT local_day(ts) AS date,
                   SUM(input_tokens) AS inputTokens,
                   SUM(output_tokens) AS outputTokens,
                   SUM(cache_read_tokens) AS cacheReadTokens,
                   SUM(cache_write_tokens) AS cacheWriteTokens,
                   SUM(thinking_tokens) AS thinkingTokens
            FROM synced_records WHERE 1=1 ${df.where} ${dr.where} ${tf.where}
            GROUP BY date ORDER BY date`
          params = { ...df.params, ...dr.params, ...tf.params }
        } else {
          sql = `
            SELECT local_day(ts) AS date,
                   SUM(input_tokens) AS inputTokens,
                   SUM(output_tokens) AS outputTokens,
                   SUM(cache_read_tokens) AS cacheReadTokens,
                   SUM(cache_write_tokens) AS cacheWriteTokens,
                   SUM(thinking_tokens) AS thinkingTokens
            FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
            GROUP BY date ORDER BY date`
          params = { ...dr.params, ...tf.params }
        }

        const rows = db.prepare(sql).all(params) as any[]
        json(res, { data: rows })
        return
      }

      // ── /api/cost ─────────────────────────────────────────────────
      if (url.pathname === '/api/cost') {
        const dr = getDateRangeFilter(range, from, to, '', weekStart)
        const device = url.searchParams.get('device')
        const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
        const tool = url.searchParams.get('tool')
        const tf = getToolFilter(tool)

        let daily: any[]
        let byToolRows: any[]
        let byModelRows: any[]

        if (df.useUnion) {
          daily = db.prepare(`
            SELECT local_day(ts) AS date,
                   SUM(cost) AS cost
            FROM (
              SELECT cost, ts FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
              UNION ALL
              SELECT cost, ts FROM synced_records WHERE device_instance_id != @currentDeviceId ${dr.where} ${tf.where}
            )
            GROUP BY date ORDER BY date
          `).all({ ...dr.params, currentDeviceId: df.params.currentDeviceId, ...tf.params }) as any[]

          byToolRows = db.prepare(`
            SELECT tool, SUM(cost) AS cost FROM (
              SELECT tool, SUM(cost) AS cost FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where} GROUP BY tool
              UNION ALL
              SELECT tool, SUM(cost) AS cost FROM synced_records WHERE device_instance_id != @currentDeviceId ${dr.where} ${tf.where} GROUP BY tool
            ) GROUP BY tool ORDER BY cost DESC
          `).all({ ...dr.params, currentDeviceId: df.params.currentDeviceId, ...tf.params }) as any[]

          byModelRows = db.prepare(`
            SELECT model, SUM(cost) AS cost FROM (
              SELECT model, SUM(cost) AS cost FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where} GROUP BY model
              UNION ALL
              SELECT model, SUM(cost) AS cost FROM synced_records WHERE device_instance_id != @currentDeviceId ${dr.where} ${tf.where} GROUP BY model
            ) GROUP BY model ORDER BY cost DESC
          `).all({ ...dr.params, currentDeviceId: df.params.currentDeviceId, ...tf.params }) as any[]
        } else if (device && device !== options?.currentDeviceInstanceId) {
          daily = db.prepare(`
            SELECT local_day(ts) AS date,
                   SUM(cost) AS cost
            FROM synced_records WHERE 1=1 ${df.where} ${dr.where} ${tf.where}
            GROUP BY date ORDER BY date
          `).all({ ...df.params, ...dr.params, ...tf.params }) as any[]

          byToolRows = db.prepare(`
            SELECT tool, SUM(cost) AS cost
            FROM synced_records WHERE 1=1 ${df.where} ${dr.where} ${tf.where}
            GROUP BY tool ORDER BY cost DESC
          `).all({ ...df.params, ...dr.params, ...tf.params }) as any[]

          byModelRows = db.prepare(`
            SELECT model, SUM(cost) AS cost
            FROM synced_records WHERE 1=1 ${df.where} ${dr.where} ${tf.where}
            GROUP BY model ORDER BY cost DESC
          `).all({ ...df.params, ...dr.params, ...tf.params }) as any[]
        } else {
          daily = db.prepare(`
            SELECT local_day(ts) AS date,
                   SUM(cost) AS cost
            FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
            GROUP BY date ORDER BY date
          `).all({ ...dr.params, ...tf.params }) as any[]

          byToolRows = db.prepare(`
            SELECT tool, SUM(cost) AS cost
            FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
            GROUP BY tool ORDER BY cost DESC
          `).all({ ...dr.params, ...tf.params }) as any[]

          byModelRows = db.prepare(`
            SELECT model, SUM(cost) AS cost
            FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
            GROUP BY model ORDER BY cost DESC
          `).all({ ...dr.params, ...tf.params }) as any[]
        }

        const byTool: Record<string, number> = {}
        for (const r of byToolRows) byTool[r.tool] = r.cost

        const byModel: Record<string, number> = {}
        for (const r of byModelRows) byModel[r.model] = r.cost

        // Keep provenance on the exact same record set as the existing cost totals.
        const provenanceColumns = 'cost, cost_source, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens'
        const provenanceSql = df.useUnion
          ? `SELECT ${provenanceColumns} FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
             UNION ALL SELECT ${provenanceColumns} FROM synced_records WHERE device_instance_id != @currentDeviceId ${dr.where} ${tf.where}`
          : device && device !== options?.currentDeviceInstanceId
            ? `SELECT ${provenanceColumns} FROM synced_records WHERE 1=1 ${df.where} ${dr.where} ${tf.where}`
            : `SELECT ${provenanceColumns} FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}`
        const provenanceParams = { ...df.params, ...dr.params, ...tf.params }
        const sourceRows = db.prepare(`WITH filtered AS (${provenanceSql})
          SELECT CASE WHEN cost_source IN ('log', 'pricing') THEN cost_source ELSE 'unknown' END AS source,
                 COUNT(*) AS records, COALESCE(SUM(cost), 0) AS cost
          FROM filtered GROUP BY source
        `).all(provenanceParams) as Array<{ source: 'log' | 'pricing' | 'unknown'; records: number; cost: number }>
        const sources = { log: { records: 0, cost: 0 }, pricing: { records: 0, cost: 0 }, unknown: { records: 0, cost: 0 } }
        for (const row of sourceRows) sources[row.source] = { records: row.records, cost: row.cost }
        const totalRecords = sources.log.records + sources.pricing.records + sources.unknown.records
        const knownRecords = sources.log.records + sources.pricing.records
        const unpricedModels = db.prepare(`WITH filtered AS (${provenanceSql})
          SELECT model, COUNT(*) AS records,
                 SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS tokens
          FROM filtered WHERE cost_source NOT IN ('log', 'pricing') OR cost_source IS NULL
          GROUP BY model ORDER BY records DESC, model ASC
        `).all(provenanceParams)
        json(res, { data: daily, byTool, byModel, provenance: {
          sources, totalRecords, knownRecords,
          coverage: totalRecords ? knownRecords / totalRecords : null,
          unpricedModels,
        } })
        return
      }

      // ── /api/models ───────────────────────────────────────────────
      if (url.pathname === '/api/models') {
        const dr = getDateRangeFilter(range, from, to, '', weekStart)
        const device = url.searchParams.get('device')
        const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
        const tool = url.searchParams.get('tool')
        const tf = getToolFilter(tool)

        let totalTokensAcrossModels: number
        let rows: any[]

        if (df.useUnion) {
          const unionSql = `
            SELECT model, provider,
                   COUNT(*) AS callCount,
                   SUM(input_tokens) AS inputTokens,
                   SUM(output_tokens) AS outputTokens,
                   SUM(cache_read_tokens) AS cacheReadTokens,
                   SUM(cache_write_tokens) AS cacheWriteTokens,
                   SUM(thinking_tokens) AS thinkingTokens,
                   SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS totalTokens,
                   SUM(cost) AS totalCost
            FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
            GROUP BY model, provider
            UNION ALL
            SELECT model, provider,
                   COUNT(*) AS callCount,
                   SUM(input_tokens) AS inputTokens,
                   SUM(output_tokens) AS outputTokens,
                   SUM(cache_read_tokens) AS cacheReadTokens,
                   SUM(cache_write_tokens) AS cacheWriteTokens,
                   SUM(thinking_tokens) AS thinkingTokens,
                   SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS totalTokens,
                   SUM(cost) AS totalCost
            FROM synced_records WHERE device_instance_id != @currentDeviceId ${dr.where} ${tf.where}
            GROUP BY model, provider
          `
          const mergedRows = db.prepare(`
            SELECT model, provider,
                   SUM(callCount) AS callCount,
                   SUM(inputTokens) AS inputTokens,
                   SUM(outputTokens) AS outputTokens,
                   SUM(cacheReadTokens) AS cacheReadTokens,
                   SUM(cacheWriteTokens) AS cacheWriteTokens,
                   SUM(thinkingTokens) AS thinkingTokens,
                   SUM(totalTokens) AS totalTokens,
                   SUM(totalCost) AS totalCost
            FROM (${unionSql})
            WHERE model != 'unknown'
            GROUP BY model, provider ORDER BY totalTokens DESC
          `).all({ ...dr.params, ...df.params, ...tf.params }) as any[]
          totalTokensAcrossModels = mergedRows.reduce((sum, row) => sum + row.totalTokens, 0)
          rows = mergedRows
        } else if (device && device !== options?.currentDeviceInstanceId) {
          rows = db.prepare(`
            SELECT model, provider,
                   COUNT(*) AS callCount,
                   SUM(input_tokens) AS inputTokens,
                   SUM(output_tokens) AS outputTokens,
                   SUM(cache_read_tokens) AS cacheReadTokens,
                   SUM(cache_write_tokens) AS cacheWriteTokens,
                   SUM(thinking_tokens) AS thinkingTokens,
                   SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS totalTokens,
                   SUM(cost) AS totalCost
            FROM synced_records WHERE 1=1 AND model != 'unknown' ${df.where} ${dr.where} ${tf.where}
            GROUP BY model, provider ORDER BY totalTokens DESC
          `).all({ ...df.params, ...dr.params, ...tf.params }) as any[]
          totalTokensAcrossModels = rows.reduce((sum, row) => sum + row.totalTokens, 0)
        } else {
          rows = db.prepare(`
            SELECT model, provider,
                   COUNT(*) AS callCount,
                   SUM(input_tokens) AS inputTokens,
                   SUM(output_tokens) AS outputTokens,
                   SUM(cache_read_tokens) AS cacheReadTokens,
                   SUM(cache_write_tokens) AS cacheWriteTokens,
                   SUM(thinking_tokens) AS thinkingTokens,
                   SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS totalTokens,
                   SUM(cost) AS totalCost
            FROM records WHERE 1=1 AND model != 'unknown' ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
            GROUP BY model, provider ORDER BY totalTokens DESC
          `).all({ ...dr.params, ...tf.params }) as any[]
          totalTokensAcrossModels = rows.reduce((sum, row) => sum + row.totalTokens, 0)
        }

        const models = rows.map(r => ({
          model: r.model,
          provider: r.provider,
          callCount: r.callCount,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheReadTokens: r.cacheReadTokens,
          cacheWriteTokens: r.cacheWriteTokens,
          thinkingTokens: r.thinkingTokens,
          totalTokens: r.totalTokens,
          totalCost: r.totalCost,
          percentage: totalTokensAcrossModels > 0
            ? Math.round((r.totalTokens / totalTokensAcrossModels) * 1000) / 10
            : 0,
        }))

        json(res, { models })
        return
      }

      // ── /api/tool-calls ───────────────────────────────────────────
      if (url.pathname === '/api/tool-calls' || url.pathname === '/api/tool-calls/events') {
        const device = url.searchParams.get('device')
        const df = activityDeviceFilter(device, options?.currentDeviceInstanceId, 'tc.owner', 'tc.origin')

        const dr = getDateRangeFilter(range, from, to, 'tc', weekStart)
        const tool = url.searchParams.get('tool')
        const tfRaw = getToolFilter(tool, 'r')
        const tf = {
          where: tfRaw.where.replaceAll('r.tool', 'COALESCE(r.tool, tc.tool)'),
          params: tfRaw.params,
        }
        const toolType = url.searchParams.get('toolType')
        if (toolType && !['mcp', 'skill', 'builtin'].includes(toolType)) {
          json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid toolType' } }, 400)
          return
        }
        const ttf = getToolTypeFilter(toolType)

        if (url.pathname.endsWith('/events')) {
          const paging = activityPaging(url)
          const name = url.searchParams.get('name')
          if (!paging || !name) {
            json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid tool name or pagination' } }, 400)
            return
          }
          const source = `FROM activity_tool_calls tc LEFT JOIN records r ON r.id = tc.record_id
            WHERE tc.name = @name ${df.where} ${dr.where} ${tf.where} ${ttf}`
          const params = { ...df.params, ...dr.params, ...tf.params, name }
          const { total } = db.prepare(`SELECT COUNT(*) AS total ${source}`).get(params) as { total: number }
          const events = db.prepare(`SELECT tc.id, tc.name, tc.ts, tc.call_index AS callIndex,
            COALESCE(r.tool, tc.tool) AS tool, tc.record_id AS recordId, r.session_id AS sessionId,
            COALESCE(tc.owner, @current) AS deviceInstanceId ${source}
            ORDER BY tc.ts DESC, tc.owner, tc.id LIMIT @pageSize OFFSET @offset`)
            .all({ ...params, current: options?.currentDeviceInstanceId ?? null, pageSize: paging.pageSize, offset: paging.offset })
          json(res, { events, total, page: paging.page, pageSize: paging.pageSize })
          return
        }

        const totalRow = db.prepare(`
          SELECT COUNT(*) AS total FROM activity_tool_calls tc
          LEFT JOIN records r ON r.id = tc.record_id
          WHERE 1=1 ${df.where} ${dr.where} ${tf.where} ${ttf}
        `).get({ ...df.params, ...dr.params, ...tf.params }) as any
        const total = totalRow.total || 1

        const rows = db.prepare(`
          SELECT tc.name, COUNT(*) AS count
          FROM activity_tool_calls tc
          LEFT JOIN records r ON r.id = tc.record_id
          WHERE 1=1 ${df.where} ${dr.where} ${tf.where} ${ttf}
          GROUP BY tc.name ORDER BY count DESC
        `).all({ ...df.params, ...dr.params, ...tf.params }) as any[]

        const toolCalls = rows.map(r => {
          const type = classifyToolCall(r.name)
          const mcpParsed = type === 'mcp' ? parseMcpName(r.name) : null
          const displayName = mcpParsed
            ? mcpParsed.display
            : (type === 'skill' && r.name.startsWith('skill__'))
              ? r.name.slice('skill__'.length)
              : r.name
          return {
            name: r.name,
            displayName,
            mcpServer: mcpParsed ? mcpParsed.server : null,
            type,
            count: r.count,
            percentage: Math.round((r.count / total) * 1000) / 10,
          }
        })

        json(res, { toolCalls })
        return
      }

      // ── /api/sessions/:sessionId ──────────────────────────────────
      if (url.pathname.startsWith('/api/sessions/') && req.method === 'GET') {
        const sessionId = decodeURIComponent(url.pathname.slice('/api/sessions/'.length))
        if (!sessionId) {
          json(res, { error: { code: 'INVALID_PARAM', message: 'Missing sessionId' } }, 400)
          return
        }

        const toolParam = url.searchParams.get('tool')
        const deviceParam = url.searchParams.get('device')

        // Build optional filters
        const toolClause = toolParam ? 'AND tool = @tool' : ''
        const df = activityDeviceFilter(deviceParam, options?.currentDeviceInstanceId, 'device_instance_id', 'origin')
        const deviceClause = df.where
        const filterParams: Record<string, unknown> = { sessionId, ...df.params }
        if (toolParam) filterParams.tool = toolParam

        // Session metadata: one row for the whole session, whatever tools and models it used
        const totals = db.prepare(`
          SELECT session_id AS sessionId,
                 MIN(ts) AS firstTs,
                 MAX(ts) AS lastTs,
                 MAX(ts) - MIN(ts) AS duration,
                 SUM(input_tokens) AS inputTokens,
                 SUM(output_tokens) AS outputTokens,
                 SUM(cache_read_tokens) AS cacheReadTokens,
                 SUM(cache_write_tokens) AS cacheWriteTokens,
                 SUM(thinking_tokens) AS thinkingTokens,
                 SUM(cost) AS cost,
                 COUNT(*) AS recordCount
          FROM activity_records
          WHERE session_id = @sessionId ${toolClause} ${deviceClause}
          GROUP BY session_id
        `).get(filterParams) as any

        // Models in order of first use; `tool` and `model` stay single values (the first used)
        const modelRows = db.prepare(`
          SELECT tool, model
          FROM activity_records
          WHERE session_id = @sessionId ${toolClause} ${deviceClause}
          GROUP BY tool, model
          ORDER BY MIN(ts) ASC, MIN(sort_key) ASC
        `).all(filterParams) as any[]
        const meta = totals && {
          sessionId: totals.sessionId,
          tool: modelRows[0]?.tool,
          model: modelRows[0]?.model,
          models: [...new Set(modelRows.map(r => r.model))],
          ...totals,
        }

        // Fetch cwd from the first record that has one
        const cwdRow = db.prepare(`
          SELECT cwd FROM activity_records
          WHERE session_id = @sessionId AND cwd != '' ${toolClause} ${deviceClause}
          LIMIT 1
        `).get(filterParams) as any
        const cwd = cwdRow?.cwd || ''

        if (!meta) {
          json(res, { error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404)
          return
        }

        // Records in ascending order
        const records = db.prepare(`
          SELECT id, ts, model,
                 input_tokens AS inputTokens,
                 output_tokens AS outputTokens,
                 cache_read_tokens AS cacheReadTokens,
                 cache_write_tokens AS cacheWriteTokens,
                 thinking_tokens AS thinkingTokens,
                 cost
          FROM activity_records
          WHERE session_id = @sessionId ${toolClause} ${deviceClause}
          ORDER BY ts ASC
        `).all(filterParams) as any[]

        // Tool calls for all records in this session
        const rToolClause = toolParam ? 'AND r.tool = @tool' : ''
        const rDeviceClause = activityDeviceFilter(deviceParam, options?.currentDeviceInstanceId, 'r.device_instance_id', 'r.origin').where
        const toolCallRows = db.prepare(`
          SELECT tc.record_id AS recordId, tc.name, tc.ts, tc.call_index AS callIndex
          FROM activity_tool_calls tc
          JOIN records r ON r.id = tc.record_id
          WHERE r.session_id = @sessionId ${rToolClause} ${rDeviceClause}
          ORDER BY tc.record_id, tc.call_index ASC
        `).all(filterParams) as any[]

        // Group tool calls by record_id
        const toolCallsByRecord: Record<string, any[]> = {}
        for (const tc of toolCallRows) {
          if (!toolCallsByRecord[tc.recordId]) toolCallsByRecord[tc.recordId] = []
          const type = classifyToolCall(tc.name)
          const mcpParsed = type === 'mcp' ? parseMcpName(tc.name) : null
          const displayName = mcpParsed
            ? mcpParsed.display
            : (type === 'skill' && tc.name.startsWith('skill__'))
              ? tc.name.slice('skill__'.length)
              : tc.name
          toolCallsByRecord[tc.recordId].push({
            name: tc.name,
            displayName,
            type,
            ts: tc.ts,
            callIndex: tc.callIndex,
          })
        }

        const toolCallCount = toolCallRows.length

        const titleRow = db.prepare(`SELECT session_title FROM activity_session_titles
          WHERE id IN (SELECT id FROM activity_records WHERE session_id = @sessionId ${toolClause} ${deviceClause})
          ORDER BY updated_at DESC, id DESC LIMIT 1
        `).get(filterParams) as { session_title: string } | undefined

        json(res, {
          session: { ...meta, sessionTitle: titleRow?.session_title, toolCallCount, cwd },
          records: records.map(r => ({
            ...r,
            toolCalls: toolCallsByRecord[r.id] ?? [],
          })),
        })
        return
      }

      // ── /api/sessions ─────────────────────────────────────────────
      if (url.pathname === '/api/sessions') {
        const query = (url.searchParams.get('q') || '').trim()
        const sort = url.searchParams.get('sort') || 'newest'
        if (query.length > 200 || !['newest', 'cost', 'tokens'].includes(sort) || query.includes('\0')) {
          json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid session search or sort' } }, 400)
          return
        }
        // Absent or empty gives the default; anything but a positive integer is rejected
        const parsePagingParam = (name: string, fallback: number): number | null => {
          const value = url.searchParams.get(name)
          if (value === null || value === '') return fallback
          if (!/^\d+$/.test(value)) return null
          const n = Number(value)
          return Number.isSafeInteger(n) && n >= 1 ? n : null
        }
        const page = parsePagingParam('page', 1)
        const requestedPageSize = parsePagingParam('pageSize', 50)
        if (page === null || requestedPageSize === null) {
          json(res, { error: { code: 'INVALID_PARAM', message: `Invalid ${page === null ? 'page' : 'pageSize'}` } }, 400)
          return
        }
        const pageSize = Math.min(100, requestedPageSize)
        const offset = (page - 1) * pageSize
        if (!Number.isSafeInteger(offset)) {
          json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid page' } }, 400)
          return
        }

        const dr = getDateRangeFilter(range, from, to, 'r', weekStart)
        const device = url.searchParams.get('device')
        const df = activityDeviceFilter(device, options?.currentDeviceInstanceId, 'r.device_instance_id', 'r.origin')
        const tool = url.searchParams.get('tool')

        const tf = getToolFilter(tool, 'r')
        const params: Record<string, unknown> = { ...dr.params, ...df.params, ...tf.params }
        const recordFilter = `${dr.where} ${df.where} ${tf.where}`

        // Resolve the latest title outside the date window, matching the displayed title.
        // Search session metadata before paging without filtering away its usage records.
        const grouped = `WITH grouped AS (
          SELECT r.session_id AS sessionId, r.device_instance_id AS deviceInstanceId,
                 r.tool, r.model, MIN(r.ts) AS ts, MAX(r.ts) AS lastTs,
                 MAX(r.ts) - MIN(r.ts) AS duration,
                 SUM(r.input_tokens) AS inputTokens, SUM(r.output_tokens) AS outputTokens,
                 SUM(r.cache_read_tokens) AS cacheReadTokens, SUM(r.cache_write_tokens) AS cacheWriteTokens,
                 SUM(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens + r.thinking_tokens) AS totalTokens,
                 SUM(r.cost) AS cost,
                 (SELECT st.session_title FROM activity_session_titles st
                  WHERE st.session_id = r.session_id AND st.device_instance_id = r.device_instance_id
                    ${tool ? 'AND st.tool = @tool' : ''}
                  ORDER BY st.updated_at DESC, st.id DESC LIMIT 1) AS sessionTitle
          FROM activity_records r WHERE 1=1 ${recordFilter}
          GROUP BY r.device_instance_id, r.session_id
        ), matched AS (SELECT * FROM grouped
          ${query ? "WHERE instr(lower(sessionId), lower(@query)) > 0 OR instr(lower(COALESCE(sessionTitle, '')), lower(@query)) > 0" : ''})`
        if (query) params.query = query
        const order = `${sort === 'cost' ? 's.cost' : sort === 'tokens' ? 's.totalTokens' : 's.lastTs'} DESC, s.sessionId ASC, s.deviceInstanceId ASC`
        const totalRow = db.prepare(`${grouped} SELECT COUNT(*) AS total FROM matched`).get(params) as { total: number }

        // Aggregate records per session first: joining tool_calls before the SUMs would count
        // a record once per tool call. Tool calls are then counted for the page's sessions only.
        const sessions = db.prepare(`${grouped}
          SELECT s.*,
                 (
                   SELECT COUNT(*)
                   FROM records r
                   JOIN activity_tool_calls tc ON tc.record_id = r.id
                   WHERE r.session_id = s.sessionId AND r.device_instance_id = s.deviceInstanceId ${recordFilter}
                 ) AS toolCallCount
          FROM (SELECT * FROM matched s ORDER BY ${order} LIMIT @limit OFFSET @offset) s
          ORDER BY ${order}
        `).all({ ...params, limit: pageSize, offset }) as any[]

        json(res, {
          sessions,
          total: totalRow.total,
          page,
          pageSize,
        })
        return
      }

      // ── /api/projects ─────────────────────────────────────────────
      if (url.pathname === '/api/projects' || url.pathname === '/api/projects/sessions') {
        const dr = getDateRangeFilter(range, from, to, '', weekStart)
        const device = url.searchParams.get('device')
        const df = activityDeviceFilter(device, options?.currentDeviceInstanceId, 'device_instance_id', 'origin')
        const tool = url.searchParams.get('tool')
        const tf = getToolFilter(tool)

        const rows = db.prepare(`
            SELECT source_file, cwd, device_instance_id AS deviceInstanceId, session_id AS sessionId, MIN(ts) AS ts,
                   SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS totalTokens,
                   SUM(cost) AS cost
            FROM activity_records WHERE 1=1 ${dr.where} ${df.where} ${tf.where}
            GROUP BY device_instance_id, session_id, source_file, cwd ORDER BY totalTokens DESC
          `).all({ ...dr.params, ...df.params, ...tf.params }) as any[]

        // Build a cwd inference map for Claude Code paths: encoded project dir → cwd.
        // Records without cwd can inherit it from another session in the same project directory.
        const cwdByEncodedDir = new Map<string, string>()
        for (const row of rows) {
          if (row.cwd && row.source_file) {
            const m = (row.source_file as string).replace(/\\/g, '/').match(/\.claude\/projects\/([^/]+)/)
            const key = m && JSON.stringify([row.deviceInstanceId, m[1]])
            if (key && !cwdByEncodedDir.has(key)) cwdByEncodedDir.set(key, row.cwd)
          }
        }

        // Aggregate by project
        type ProjectSession = { sessionId: string; deviceInstanceId: string; ts: number; tokens: number; cost: number }
        const projectMap = new Map<string, { sessions: Map<string, ProjectSession>; tokens: number; cost: number; fullPath: string }>()
        for (const row of rows) {
          if (!row.source_file) continue
          let effectiveCwd: string = row.cwd || ''
          if (!effectiveCwd) {
            const m = (row.source_file as string).replace(/\\/g, '/').match(/\.claude\/projects\/([^/]+)/)
            if (m) effectiveCwd = cwdByEncodedDir.get(JSON.stringify([row.deviceInstanceId, m[1]])) || ''
          }
          const fromCwd = effectiveCwd ? extractProjectFromCwd(effectiveCwd) : null
          const project = (fromCwd && fromCwd !== 'unknown') ? fromCwd : extractProject(row.source_file)
          const group = projectMap.get(project) ?? { sessions: new Map<string, ProjectSession>(), tokens: 0, cost: 0, fullPath: effectiveCwd || row.source_file }
          const key = JSON.stringify([row.deviceInstanceId, row.sessionId])
          const session = group.sessions.get(key) ?? { sessionId: row.sessionId, deviceInstanceId: row.deviceInstanceId, ts: row.ts, tokens: 0, cost: 0 }
          session.ts = Math.min(session.ts, row.ts)
          session.tokens += row.totalTokens
          session.cost += row.cost
          group.sessions.set(key, session)
          group.tokens += row.totalTokens
          group.cost += row.cost
          projectMap.set(project, group)
        }

        if (url.pathname.endsWith('/sessions')) {
          const name = url.searchParams.get('name')
          const paging = activityPaging(url)
          if (!name || !paging) {
            json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid project name or pagination' } }, 400)
            return
          }
          const rows = [...(projectMap.get(name)?.sessions.values() ?? [])].sort((left, right) =>
            right.ts - left.ts || left.deviceInstanceId.localeCompare(right.deviceInstanceId) || left.sessionId.localeCompare(right.sessionId))
          const sessions = rows.slice(paging.offset, paging.offset + paging.pageSize).map(session => ({
            ...session, sessionTitle: getSessionTitle(db, session.sessionId, session.deviceInstanceId, tool || undefined),
          }))
          json(res, { sessions, total: rows.length, page: paging.page, pageSize: paging.pageSize })
          return
        }
        const totalTokens = [...projectMap.values()].reduce((sum, project) => sum + project.tokens, 0) || 1
        const projects = [...projectMap]
          .map(([name, data]) => ({
            name,
            sessions: data.sessions.size,
            tokens: data.tokens,
            cost: data.cost,
            percentage: Math.round((data.tokens / totalTokens) * 1000) / 10,
            fullPath: data.fullPath,
          }))
          .sort((a, b) => b.tokens - a.tokens)

        json(res, { projects })
        return
      }

      // ── /api/pricing ────────────────────────────────────────────────
      if (url.pathname === '/api/pricing') {
        // GET: list all prices from the local pricing registry plus models from DB.
        if (req.method === 'GET') {
          json(res, { models: listPricingModels(db), registry: getPricingRegistrySummary(db), targets: listPricingAliasTargets(db), aliasBindings: getUserAliasBindings(db), localBindings: listLocalModelBindings(db) })
          return
        }
        // PUT: set price override
        if (req.method === 'PUT') {
          let data: Record<string, unknown>
          try {
            data = await readJsonBody(req)
          } catch (error) {
            if (error instanceof BodyTooLargeError) { bodyTooLarge(res); return }
            json(res, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400)
            return
          }
          if (!data.model || typeof data.input !== 'number' || typeof data.output !== 'number') {
            json(res, { error: { code: 'INVALID_PARAM', message: 'model, input, output required' } }, 400)
            return
          }
          const entry: PriceEntry = {
            input: data.input,
            output: data.output,
            cacheRead: data.cacheRead as number | undefined,
            cacheWrite: data.cacheWrite as number | undefined,
          }
          if (data.currency === 'CNY') {
            entry.currency = 'CNY'
          }
          try {
            await runDbWrite(() => {
              setUserPrice(db, data.model as string, entry)
              const cfg = updateConfig((c) => {
                c.priceOverrides = { ...c.priceOverrides, [data.model as string]: entry }
              })
              loadPricingRuntime(db, cfg)
            })
          } catch (error) {
            if (isDatabaseLockedError(error)) {
              databaseBusy(res)
              return
            }
            throw error
          }
          json(res, { ok: true, needsRecalc: true, needsRecalcSince: markPricingNeedsRecalc() })
          return
        }
        // DELETE: remove price override
        if (req.method === 'DELETE') {
          const model = url.searchParams.get('model')
          if (!model) {
            json(res, { error: { code: 'INVALID_PARAM', message: 'model param required' } }, 400)
            return
          }
          try {
            await runDbWrite(() => {
              resetUserPriceToSynced(db, model)
              removePriceOverride(model)
              const cfg = updateConfig((c) => {
                if (!c.priceOverrides) return false
                delete c.priceOverrides[model]
              })
              loadPricingRuntime(db, cfg)
            })
            json(res, { ok: true, needsRecalc: true, needsRecalcSince: markPricingNeedsRecalc() })
          } catch (error) {
            if (isDatabaseLockedError(error)) {
              databaseBusy(res)
              return
            }
            throw error
          }
          return
        }
      }

      if (url.pathname === '/api/pricing/alias' && req.method === 'POST') {
        try {
          const data = await readJsonBody(req)
          if (typeof data.alias !== 'string' || typeof data.modelKey !== 'string') {
            json(res, { error: { code: 'INVALID_PARAM', message: 'alias and modelKey required' } }, 400)
            return
          }
          const { alias, modelKey } = data
          await runDbWrite(() => {
            setUserPricingAlias(db, alias, modelKey)
            loadPricingRuntime(db, loadConfig())
          })
          json(res, { ok: true, needsRecalc: true, needsRecalcSince: markPricingNeedsRecalc() })
        } catch (error) {
          if (error instanceof BodyTooLargeError) { bodyTooLarge(res); return }
          if (isDatabaseLockedError(error)) {
            databaseBusy(res)
            return
          }
          json(res, { error: { code: 'INVALID_PARAM', message: error instanceof Error ? error.message : 'Invalid pricing alias' } }, 400)
        }
        return
      }

      if (url.pathname === '/api/pricing/alias' && req.method === 'DELETE') {
        const alias = url.searchParams.get('alias')
        if (!alias) {
          json(res, { error: { code: 'INVALID_PARAM', message: 'alias param required' } }, 400)
          return
        }
        try {
          await runDbWrite(() => {
            removeUserPricingAlias(db, alias)
            loadPricingRuntime(db, loadConfig())
          })
          json(res, { ok: true, needsRecalc: true, needsRecalcSince: markPricingNeedsRecalc() })
        } catch (error) {
          if (isDatabaseLockedError(error)) {
            databaseBusy(res)
            return
          }
          json(res, { error: { code: 'INVALID_PARAM', message: error instanceof Error ? error.message : 'Invalid pricing alias' } }, 400)
        }
        return
      }

      if (url.pathname === '/api/pricing/sync' && req.method === 'POST') {
        try {
          const summary = await runDbWrite(async () => {
            const summary = await syncPricingFromLitellm(db)
            loadPricingRuntime(db, loadConfig())
            return summary
          })
          json(res, { ok: true, summary, needsRecalc: true, needsRecalcSince: markPricingNeedsRecalc() })
        } catch (error) {
          if (isDatabaseLockedError(error)) {
            databaseBusy(res)
            return
          }
          json(res, { error: { code: 'SYNC_FAILED', message: error instanceof Error ? error.message : 'Pricing sync failed' } }, 502)
        }
        return
      }

      // ── /api/pricing/recalc ─────────────────────────────────────────
      if (url.pathname === '/api/pricing/recalc' && req.method === 'GET') {
        json(res, currentPricingRecalcStatus())
        return
      }

      if (url.pathname === '/api/pricing/recalc' && req.method === 'POST') {
        const result = startPricingRecalc()
        json(res, result, result.accepted ? 202 : 200)
        return
      }

      // ── /api/sync ──────────────────────────────────────────────────
      if (url.pathname === '/api/sync') {
        if (req.method === 'POST') {
          if (!options?.onSyncStart) {
            json(res, { error: { code: 'NOT_AVAILABLE', message: 'Sync not configured' } }, 501)
            return
          }
          const result = options.onSyncStart()
          json(res, result, result.accepted ? 202 : 200)
          return
        }
        // GET: sync status
        const status = options?.getSyncStatus?.() ?? null
        json(res, { status })
        return
      }

      // ── /api/refresh ────────────────────────────────────────────────
      if (url.pathname === '/api/refresh') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST')
          json(res, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST to refresh' } }, 405)
          return
        }
        if (!options?.onRefresh) {
          json(res, { error: { code: 'NOT_AVAILABLE', message: 'Refresh not available' } }, 501)
          return
        }
        try {
          const result = await runDbWrite(() => options.onRefresh!())
          json(res, result)
        } catch (error) {
          if (isDatabaseLockedError(error)) {
            databaseBusy(res)
            return
          }
          throw error
        }
        return
      }

      // ── /api/quotas ───────────────────────────────────────────────
      if (url.pathname === '/api/quotas' && req.method === 'GET') {
        const results = await queryAllQuotas()
        json(res, { quotas: results })
        return
      }

      // ── /api/devices ──────────────────────────────────────────────
      if (url.pathname === '/api/devices') {
        const currentId = options?.currentDeviceInstanceId
        if (!currentId) {
          json(res, { currentDeviceInstanceId: null, devices: [] })
          return
        }

        const config = loadConfig()
        const currentDeviceAlias = config?.device || hostname()

        // Current device: only local records (not merged from synced)
        const localRows = db.prepare(`
          SELECT device, device_instance_id AS deviceInstanceId, COUNT(*) AS recordCount
          FROM records
          WHERE device_instance_id = @currentId AND ${LOCAL_RECORDS_WHERE}
          GROUP BY device_instance_id
        `).all({ currentId }) as any[]

        // Other devices from synced_records (exclude current device's copy)
        const syncedRows = db.prepare(`
          SELECT device, device_instance_id AS deviceInstanceId, platform, COUNT(*) AS recordCount
          FROM synced_records
          WHERE device_instance_id != @currentId
          GROUP BY device_instance_id
        `).all({ currentId }) as any[]

        function getDisplayName(device: string, deviceInstanceId: string): string {
          if (deviceInstanceId === currentId) return currentDeviceAlias
          if (device && device !== 'unknown' && !/^[0-9a-f]{8}$/.test(device)) return device
          if (/^[0-9a-f]{8}-/.test(deviceInstanceId)) return deviceInstanceId.slice(0, 8)
          if (device && device !== 'unknown') return device
          return 'Unknown Device'
        }

        function getPlatformLabel(p: string | undefined): string {
          if (p === 'win32') return 'Windows'
          if (p === 'darwin') return 'macOS'
          if (p === 'linux') return 'Linux'
          return ''
        }

        // Infer platform from device name when sync record has no platform field
        function inferPlatform(device: string, deviceInstanceId: string): string {
          const name = (device || '').toLowerCase()
          const id = (deviceInstanceId || '').toLowerCase()
          // Windows hostnames: DESKTOP-XXXXX, LAPTOP-XXXXX
          if (/^(desktop|laptop)-/.test(name)) return 'Windows'
          // macOS: .local suffix, "macbook", "imac", "mac-mini"
          if (name.endsWith('.local') || /macbook|imac|mac\s*mini|mac\s*pro|mac\s*studio/.test(name)) return 'macOS'
          // Linux common hostnames
          if (/^(ubuntu|debian|centos|fedora|arch|linux|server|node|prod|dev|staging)/.test(name)) return 'Linux'
          // If displayName is just a UUID prefix (8 hex chars), platform is unknown
          return ''
        }

        // Current platform
        const currentPlatform = config?.platform || platform()

        // Merge and deduplicate
        const deviceMap = new Map<string, { device: string; deviceInstanceId: string; displayName: string; platform: string; recordCount: number }>()
        for (const row of localRows) {
          const displayName = getDisplayName(row.device, row.deviceInstanceId)
          deviceMap.set(row.deviceInstanceId, { device: row.device, deviceInstanceId: row.deviceInstanceId, displayName, platform: getPlatformLabel(currentPlatform), recordCount: row.recordCount })
        }
        for (const row of syncedRows) {
          const displayName = getDisplayName(row.device, row.deviceInstanceId)
          const platformLabel = getPlatformLabel(row.platform) || inferPlatform(row.device, row.deviceInstanceId)
          const existing = deviceMap.get(row.deviceInstanceId)
          if (existing) {
            existing.recordCount += row.recordCount
          } else {
            deviceMap.set(row.deviceInstanceId, { device: row.device, deviceInstanceId: row.deviceInstanceId, displayName, platform: platformLabel, recordCount: row.recordCount })
          }
        }

        const devices = [...deviceMap.values()].sort((a, b) => b.recordCount - a.recordCount)
        json(res, { currentDeviceInstanceId: currentId, devices })
        return
      }

      // ── /api/tools ────────────────────────────────────────────────
      if (url.pathname === '/api/tools' && req.method === 'GET') {
        const device = url.searchParams.get('device')
        const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
        const dr = getDateRangeFilter(range, from, to, '', weekStart)

        let rows: Array<{ tool: string; sessionCount: number }>

        if (df.useUnion) {
          rows = db.prepare(`
            SELECT tool, COUNT(DISTINCT session_id) AS sessionCount FROM (
              SELECT tool, session_id FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''}
              UNION ALL
              SELECT tool, session_key AS session_id FROM synced_records WHERE device_instance_id != @currentDeviceId ${dr.where}
            ) GROUP BY tool ORDER BY sessionCount DESC
          `).all({ ...dr.params, ...df.params }) as any[]
        } else if (df.where) {
          rows = db.prepare(`
            SELECT tool, COUNT(DISTINCT session_key) AS sessionCount
            FROM synced_records WHERE 1=1 ${df.where} ${dr.where}
            GROUP BY tool ORDER BY sessionCount DESC
          `).all({ ...dr.params, ...df.params }) as any[]
        } else {
          rows = db.prepare(`
            SELECT tool, COUNT(DISTINCT session_id) AS sessionCount
            FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''}
            GROUP BY tool ORDER BY sessionCount DESC
          `).all({ ...dr.params }) as any[]
        }

        json(res, { tools: rows })
        return
      }

      // Only configured state for a sync target is exposed, never keys or values.
      if (url.pathname.startsWith('/api/github/') && req.method === 'POST') {
        try {
          const body = await readJsonBody(req, 4096)
          const action = url.pathname.slice('/api/github/'.length)
          const result = await githubDeviceAction(action, body)
          if (action === 'connect' && result.ok) options?.onConfigUpdated?.()
          json(res, result)
        } catch (error) {
          if (error instanceof BodyTooLargeError) { bodyTooLarge(res); return }
          json(res, { error: { code: 'GITHUB_AUTH_FAILED', message: safeGitHubError(error) } }, 400)
        }
        return
      }

      if (url.pathname === '/api/config/credentials/status' && req.method === 'GET') {
        const backend = url.searchParams.get('backend')
        const sync = backend === 'github' || backend === 's3'
          ? { backend, repo: url.searchParams.get('repo') ?? '', bucket: url.searchParams.get('bucket') ?? '' } as SyncConfig
          : undefined
        json(res, sync ? credentialStatus(loadConfig() ?? {}, sync) : {})
        return
      }

      // ── /api/config ───────────────────────────────────────────────
      if (url.pathname === '/api/config') {
        if (req.method === 'GET') {
          const currentCfg = loadConfig() ?? {}
          const osPlatform = platform()
          const { credentials, priceOverrides, platform: _cfgPlatform, sources: _legacySources, ...rest } = currentCfg
          json(res, {
            device: rest.device ?? null,
            weekStart: rest.weekStart ?? 1,
            refreshInterval: rest.refreshInterval ?? rest.dashboardPollInterval ?? rest.parseInterval ?? null,
            retentionDays: rest.retentionDays ?? null,
            sync: publicSyncConfig(rest.sync),
            syncInterval: rest.syncInterval ?? null,
            loggedIn: hasCredentials(),
            displayCurrency: rest.displayCurrency ?? 'USD',
            exchangeRate: rest.exchangeRate ?? null,
            exchangeRateCache: rest.exchangeRateCache ?? null,
            siteUrl: getSiteUrl(),
            credentialStatus: credentialStatus(currentCfg),
            hostname: hostname(),
            platform: osPlatform,
          })
          return
        }

        if (req.method === 'PUT') {
          let update: Record<string, unknown>
          try {
            update = await readJsonBody(req)
          } catch (error) {
            if (error instanceof BodyTooLargeError) { bodyTooLarge(res); return }
            json(res, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400)
            return
          }
          // Set once config.json is written: a failure after that point (the
          // consent in state.json) must not be reported as nothing saved.
          let configSaved = false
          const syncCredentials = update.syncCredentials && typeof update.syncCredentials === 'object'
            ? update.syncCredentials as Record<string, unknown> : undefined
          // A new GitHub token goes to the OS keychain first, outside the
          // settings lock: the keychain can wait on the user (an access
          // prompt), and other processes must not wait on that to save
          // state.json or config.json. It is removed again unless the saved
          // config refers to it.
          let storedTokenId: string | undefined
          let storedTokenKept = false
          try {
            const githubToken = syncCredentials?.githubToken
            if (typeof githubToken === 'string' && githubToken) {
              storedTokenId = saveGitHubCredentials({ method: 'pat', accessToken: githubToken })
            }
            // Read, change and save under the settings lock, so that a change
            // another process saves meanwhile (`aiusage init`, a login, a
            // sync) is not written over with the copy read here.
            const saved = withSettingsLock(AIUSAGE_DIR, (): boolean => {
              const existing: Config = loadConfig() ?? {}

              if ('device' in update) {
                if (!update.device) delete existing.device
                else existing.device = String(update.device)
              }
              if ('weekStart' in update) {
                const ws = Number(update.weekStart)
                if (ws === 0 || ws === 1) {
                  existing.weekStart = ws as 0 | 1
                  weekStart = ws as 0 | 1
                } else {
                  delete existing.weekStart
                }
              }
              if ('displayCurrency' in update) {
                const dc = update.displayCurrency
                if (dc === 'USD' || dc === 'CNY') {
                  existing.displayCurrency = dc
                } else {
                  delete existing.displayCurrency
                }
              }
              if ('exchangeRate' in update) {
                const er = update.exchangeRate
                if (er != null && typeof er === 'number' && er > 0) {
                  existing.exchangeRate = er
                } else {
                  delete existing.exchangeRate
                }
              }

              // Milliseconds. A delay above 2^31 - 1 overflows a Node timer, which then
              // fires every 1 ms, and a value typed in seconds runs back to back.
              // A blank or zero value still clears the setting.
              const intervalBounds: Array<[string, number, number]> = [
                ['refreshInterval', 1000, 2147483647],
                ['syncInterval', 60000, 2147483647],
              ]
              const intervals: Record<string, number | undefined> = {}
              for (const [field, min, max] of intervalBounds) {
                const raw = update[field]
                if (raw == null || raw === false || raw === '' || raw === 0 || raw === '0') continue
                const value = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN
                if (!Number.isFinite(value) || value < min || value > max) {
                  // Nothing is saved, so undo the week start this request may have applied above.
                  weekStart = (loadConfig()?.weekStart ?? 1) as 0 | 1
                  json(res, { error: { code: 'INVALID_INTERVAL', message: `${field} must be a number of milliseconds between ${min} and ${max}` } }, 400)
                  return false
                }
                intervals[field] = value
              }

              if ('refreshInterval' in update) {
                if (intervals.refreshInterval == null) {
                  delete existing.refreshInterval
                } else {
                  existing.refreshInterval = intervals.refreshInterval
                }
                // Clean up legacy fields
                delete existing.dashboardPollInterval
                delete existing.parseInterval
              }
              if ('retentionDays' in update) {
                if (!update.retentionDays) delete existing.retentionDays
                else existing.retentionDays = Number(update.retentionDays)
              }
              if ('syncInterval' in update) {
                const si = intervals.syncInterval
                if (si != null) {
                  existing.syncInterval = si
                } else {
                  delete existing.syncInterval
                }
              }

              if ('sync' in update) {
                const syncUpdate = update.sync as Record<string, unknown> | null
                if (!syncUpdate?.backend) {
                  delete existing.sync
                } else {
                  const backendVal = String(syncUpdate.backend)
                  if (backendVal !== 'github' && backendVal !== 's3' && backendVal !== 'cloud') {
                    json(res, { error: { code: 'INVALID_BACKEND', message: 'sync.backend must be cloud, github, or s3' } }, 400)
                    return false
                  }
                  // Merge with existing sync config to preserve fields from other backends
                  const newSync: SyncConfig = { ...existing.sync, backend: backendVal as 'github' | 's3' | 'cloud' }
                  for (const f of ['repo', 'bucket', 'prefix', 'endpoint', 'region', 'credentialRef'] as const) {
                    if (syncUpdate[f] != null && syncUpdate[f] !== '') (newSync as any)[f] = String(syncUpdate[f])
                  }
                  if (newSync.repo !== existing.sync?.repo) {
                    delete newSync.githubAuth
                    delete newSync.branch
                    delete newSync.credentialRef
                  }
                  if (newSync.backend === 'github' && newSync.repo) validateRepo(newSync.repo)
                  if (newSync.backend === 'github' && !newSync.repo) {
                    json(res, { error: { code: 'INVALID_SYNC_CONFIG', message: 'sync.repo is required for GitHub sync' } }, 400)
                    return false
                  }
                  if (newSync.backend === 's3' && !newSync.bucket) {
                    json(res, { error: { code: 'INVALID_SYNC_CONFIG', message: 'sync.bucket is required for S3 sync' } }, 400)
                    return false
                  }
                  existing.sync = newSync
                }
              }

              if (update.credentials && typeof update.credentials === 'object') {
                const creds = update.credentials as Record<string, unknown>
                const c: Record<string, string> = existing.credentials ?? {}
                for (const [key, val] of Object.entries(creds)) {
                  if (val !== '' && val !== null && val !== undefined) {
                    c[key] = String(val)
                  }
                }
                if (Object.keys(c).length) existing.credentials = c
                else delete existing.credentials
              }

              if (syncCredentials) setSyncCredentials(existing, syncCredentials, storedTokenId)

              saveConfig(existing)
              configSaved = true
              storedTokenKept = storedTokenId !== undefined && existing.sync?.githubAuth?.credentialId === storedTokenId
              const consentConfig = buildConsentConfig(existing)
              const syncTarget = getSyncTarget(existing.sync)
              if (consentConfig && syncTarget) {
                setSyncConsent(AIUSAGE_DIR, syncTarget, {
                  syncConsentAt: Date.now(),
                  syncConsentTarget: generateConsentFingerprint(consentConfig),
                })
              }
              return true
            })
            if (!saved) return
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (configSaved) {
              // The settings are in config.json: run with them, and say what failed.
              options?.onConfigUpdated?.()
              json(res, { error: { code: 'CONSENT_NOT_SAVED', message: `The settings were saved, but the sync consent was not: ${message}` } }, 500)
            } else if (error instanceof GitHubAuthError) {
              json(res, { error: { code: 'INVALID_SYNC_CONFIG', message } }, 400)
            } else {
              json(res, { error: { code: error instanceof JsonFileError ? 'SETTINGS_FILE_UNUSABLE' : 'CONFIG_NOT_SAVED', message } }, 500)
            }
            return
          } finally {
            if (storedTokenId && !storedTokenKept) deleteGitHubCredentials(storedTokenId)
          }
          options?.onConfigUpdated?.()
          json(res, { ok: true })
          return
        }
      }

      // ── /api/detected-tools ──────────────────────────────────────
      if (url.pathname === '/api/detected-tools' && req.method === 'GET') {
        const tools = attachManualImportMetadata(discoverTools(), db)
        json(res, { tools })
        return
      }

      // ── /api/import/kelivo ────────────────────────────────────────
      if (url.pathname === '/api/import/kelivo' && req.method === 'POST') {
        let tempDir: string | null = null
        try {
          const upload = await readMultipartFile(req)
          if (!upload) {
            json(res, { error: { code: 'INVALID_UPLOAD', message: 'Missing uploaded file' } }, 400)
            return
          }
          if (!isKelivoBackupFilename(upload.filename)) {
            json(res, { error: { code: 'INVALID_FILE', message: 'Upload a Kelivo .zip backup, chats.json, or Kelivo database (.db/.sqlite)' } }, 400)
            return
          }

          tempDir = mkdtempSync(path.join(tmpdir(), 'aiusage-kelivo-'))
          const tempPath = path.join(tempDir, upload.filename)
          writeFileSync(tempPath, upload.data)

          const cfg = loadConfig()
          const now = Date.now()
          const deviceInstanceId = options?.currentDeviceInstanceId ?? 'unknown'
          // A message imported before this installation had a device id keeps
          // the record it was stored under (see recordIdsForReread), which can
          // fold a copy into it, so the backup is read in the write queue.
          const result = await runDbWrite(() => runParseKelivo({
            filePath: tempPath,
            device: cfg?.device || hostname() || `${platform()}-${process.arch}`,
            deviceInstanceId,
            recordId: recordIdsForReread(db, deviceInstanceId).recordId,
            platform: cfg?.platform ?? platform(),
            now,
            exchangeRate: resolveExchangeRate(cfg ?? {}),
          }))
          if (result.errors.length > 0 && result.records.length === 0) {
            json(res, { error: { code: 'IMPORT_FAILED', message: result.errors[0] }, errors: result.errors }, 400)
            return
          }

          // The upload lives in a temp directory here; report the name the user
          // picked instead of this machine's temp path.
          const forUser = (message: string) => message.split(tempPath).join(upload.filename)

          const existingCount = await runDbWrite(() => {
            const existingCount = countExistingRecordIds(db, result.records.map((record) => record.id))
            // Ignore temp-path-only differences so an unchanged upload is not
            // queued for sync again, while still recording the manual import.
            insertChangedRecords(db, result.records)
            const stampImport = db.prepare('UPDATE records SET ingested_at = ? WHERE id = ?')
            for (const record of result.records) {
              stampImport.run(now, record.id)
            }
            return existingCount
          })
          const imported = result.records.length
          const added = Math.max(0, new Set(result.records.map((record) => record.id)).size - existingCount)
          json(res, {
            imported,
            added,
            lastImportedAt: imported > 0 ? now : undefined,
            errors: result.errors.map(forUser),
            warnings: result.warnings.map(forUser),
          })
        } finally {
          if (tempDir) rmSync(tempDir, { recursive: true, force: true })
        }
        return
      }

      // ── /api/exchange-rate/refresh ────────────────────────────────
      if (url.pathname === '/api/exchange-rate/refresh' && req.method === 'POST') {
        const rate = await fetchExchangeRate()
        if (rate == null) {
          json(res, { error: { code: 'FETCH_FAILED', message: 'Failed to fetch exchange rate' } }, 502)
          return
        }
        const exchangeRateCache = { CNY_USD: rate, fetchedAt: Date.now() }
        updateConfig((cfg) => { cfg.exchangeRateCache = exchangeRateCache })
        json(res, { rate, fetchedAt: exchangeRateCache.fetchedAt })
        return
      }

      // ── 404 ───────────────────────────────────────────────────────
      json(res, { error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }, 404)
    } catch (error) {
      if (error instanceof BodyTooLargeError) { bodyTooLarge(res); return }
      console.error('API error:', error)
      json(res, { error: { code: 'INTERNAL', message: 'Internal server error' } }, 500)
    }
  })

  return server
}
