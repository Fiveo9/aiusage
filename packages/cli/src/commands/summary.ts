import type Database from 'better-sqlite3'
import { LOCAL_RECORDS_WHERE } from '../db/records.js'

export interface SummaryOptions {
  device?: string
  tool?: string
  currentDeviceInstanceId?: string
  /** Inclusive lower bound on `ts`, in ms since epoch. */
  startTs?: number
  /** Exclusive upper bound on `ts`, in ms since epoch, as in the dashboard's date ranges. */
  endTs?: number
}

export interface SummaryResult {
  totalTokens: number
  totalCost: number
  recordCount: number
  byTool: Record<string, { tokens: number; cost: number }>
  topToolCalls: Array<{ name: string; count: number }>
  deviceCount: number
  deviceLabel: string | null
}

export function generateSummary(db: Database.Database, options?: SummaryOptions): SummaryResult {
  const currentId = options?.currentDeviceInstanceId
  const device = options?.device

  let totalsSql: string
  let totalsParams: Record<string, unknown> = {}
  let byToolSql: string
  let byToolParams: Record<string, unknown> = {}

  // Rows merged from synced_records carry origin = 'synced'; they are counted via synced_records instead.
  const localOnlyFilter = `AND ${LOCAL_RECORDS_WHERE}`
  const toolWhere = options?.tool ? 'AND tool = @tool' : ''
  const toolParam = options?.tool ? { tool: options.tool } : {}
  const timeWhere = [
    typeof options?.startTs === 'number' ? 'AND ts >= @startTs' : '',
    typeof options?.endTs === 'number' ? 'AND ts < @endTs' : '',
  ].filter(Boolean).join(' ')
  const timeParam = {
    ...(typeof options?.startTs === 'number' ? { startTs: options.startTs } : {}),
    ...(typeof options?.endTs === 'number' ? { endTs: options.endTs } : {}),
  }
  const legacyDeviceWhere = !currentId && device ? 'AND (device_instance_id = @device OR device = @device)' : ''
  const legacyDeviceParam = legacyDeviceWhere ? { device } : {}

  if (currentId && !device) {
    // All devices: UNION (exclude merged synced records from records to avoid double-counting)
    totalsSql = `
      SELECT
        COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens), 0) AS totalTokens,
        COALESCE(SUM(cost), 0) AS totalCost,
        COUNT(*) AS recordCount
      FROM (
        SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, cost FROM records WHERE 1=1 ${localOnlyFilter} ${toolWhere} ${timeWhere}
        UNION ALL
        SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, cost FROM synced_records WHERE device_instance_id != @currentId ${toolWhere} ${timeWhere}
      )`
    totalsParams = { currentId, ...toolParam, ...timeParam }

    byToolSql = `
      SELECT tool,
             SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS tokens,
             SUM(cost) AS cost
      FROM (
        SELECT tool, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, cost FROM records WHERE 1=1 ${localOnlyFilter} ${toolWhere} ${timeWhere}
        UNION ALL
        SELECT tool, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, cost FROM synced_records WHERE device_instance_id != @currentId ${toolWhere} ${timeWhere}
      )
      GROUP BY tool ORDER BY cost DESC`
    byToolParams = { currentId, ...toolParam, ...timeParam }
  } else if (currentId && device && device !== currentId) {
    // Specific other device
    totalsSql = `
      SELECT
        COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens), 0) AS totalTokens,
        COALESCE(SUM(cost), 0) AS totalCost,
        COUNT(*) AS recordCount
      FROM synced_records WHERE device_instance_id = @device ${toolWhere} ${timeWhere}`
    totalsParams = { device, ...toolParam, ...timeParam }

    byToolSql = `
      SELECT tool,
             SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS tokens,
             SUM(cost) AS cost
      FROM synced_records WHERE device_instance_id = @device ${toolWhere} ${timeWhere}
      GROUP BY tool ORDER BY cost DESC`
    byToolParams = { device, ...toolParam, ...timeParam }
  } else {
    // Local only (current device specified or no currentId)
    totalsSql = `
      SELECT
        COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens), 0) AS totalTokens,
        COALESCE(SUM(cost), 0) AS totalCost,
        COUNT(*) AS recordCount
      FROM records WHERE 1=1 ${currentId ? localOnlyFilter : ''} ${legacyDeviceWhere} ${toolWhere} ${timeWhere}`
    totalsParams = { ...legacyDeviceParam, ...toolParam, ...timeParam }

    byToolSql = `
      SELECT tool,
             SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS tokens,
             SUM(cost) AS cost
      FROM records WHERE 1=1 ${currentId ? localOnlyFilter : ''} ${legacyDeviceWhere} ${toolWhere} ${timeWhere}
      GROUP BY tool ORDER BY cost DESC`
    byToolParams = { ...legacyDeviceParam, ...toolParam, ...timeParam }
  }

  const totals = db.prepare(totalsSql).get(totalsParams) as { totalTokens: number; totalCost: number; recordCount: number }

  const byToolRows = db.prepare(byToolSql).all(byToolParams) as Array<{ tool: string; tokens: number; cost: number }>
  const byTool: Record<string, { tokens: number; cost: number }> = {}
  for (const row of byToolRows) {
    byTool[row.tool] = { tokens: row.tokens, cost: row.cost }
  }

  const callParams: Record<string, unknown> = {}
  const callFilters: string[] = []
  if (device === currentId && currentId) callFilters.push("tc.origin = 'local'")
  else if (device) {
    callFilters.push(!currentId ? '(tc.owner = @callDevice OR COALESCE(r.device, sr.device) = @callDevice)' : 'tc.owner = @callDevice')
    callParams.callDevice = device
  } else if (currentId) {
    callFilters.push("(tc.origin = 'local' OR tc.owner != @callDevice)")
    callParams.callDevice = currentId
  }
  if (options?.tool) { callFilters.push('COALESCE(r.tool, sr.tool, tc.tool) = @callTool'); callParams.callTool = options.tool }
  if (typeof options?.startTs === 'number') { callFilters.push('tc.ts >= @callStart'); callParams.callStart = options.startTs }
  if (typeof options?.endTs === 'number') { callFilters.push('tc.ts < @callEnd'); callParams.callEnd = options.endTs }
  const toolCallStats = db.prepare(`SELECT tc.name, COUNT(*) AS count FROM activity_tool_calls tc
    LEFT JOIN records r ON r.id = tc.record_id AND r.device_instance_id = tc.owner
    LEFT JOIN synced_records sr ON sr.id = tc.record_id AND sr.device_instance_id = tc.owner
    ${callFilters.length ? `WHERE ${callFilters.join(' AND ')}` : ''}
    GROUP BY tc.name ORDER BY count DESC, tc.name LIMIT 3`).all(callParams) as Array<{ name: string; count: number }>

  // Count devices
  let deviceCount = 1
  let deviceLabel: string | null = null
  if (currentId) {
    const localDevices = db.prepare('SELECT DISTINCT device_instance_id FROM records').all() as any[]
    const syncedDevices = db.prepare('SELECT DISTINCT device_instance_id FROM synced_records WHERE device_instance_id != ?').all(currentId) as any[]
    const allDeviceIds = new Set([...localDevices.map(d => d.device_instance_id), ...syncedDevices.map(d => d.device_instance_id)])
    deviceCount = allDeviceIds.size
  }
  if (device) {
    const local = db.prepare('SELECT device FROM records WHERE device_instance_id = @device OR device = @device ORDER BY (device_instance_id = @device) DESC LIMIT 1').get({ device }) as { device: string } | undefined
    const remote = local ? undefined : db.prepare('SELECT device FROM synced_records WHERE device_instance_id = ? LIMIT 1').get(device) as { device: string } | undefined
    deviceLabel = local?.device ?? remote?.device ?? device
  }

  return {
    totalTokens: totals.totalTokens,
    totalCost: totals.totalCost,
    recordCount: totals.recordCount,
    byTool,
    topToolCalls: toolCallStats.slice(0, 3),
    deviceCount,
    deviceLabel,
  }
}
