import { querySummaryTotals, queryTokens, queryCosts, queryModels, queryTools, type SummaryTotals } from './summary-queries.js'
import { json } from './http-helpers.js'
import { getDateRangeFilter, getToolFilter, parseMcpName, activityDeviceFilter, getDeviceFilter, SUMMARY_RANGES } from './query-helpers.js'
import type { ApiRouteContext } from './context.js'

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

export async function handleSummaryRoute(context: ApiRouteContext): Promise<boolean> {
  const { services, req, res, url, range, from, to } = context
  const { db, options } = services
// ── /api/home-summary ─────────────────────────────────────────
  // Deliberately public when a dashboard password is set (see auth.ts).
  // Only aggregate totals across all devices and tools are returned; the
  // device/tool filters and per-tool, tool-call, and MCP breakdowns are
  // reserved for the authenticated /api/summary route.
  if (url.pathname === '/api/home-summary') {
    if (range && !SUMMARY_RANGES.includes(range)) {
      json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid range' } }, 400)
      return true
    }
    const df = getDeviceFilter(null, options?.currentDeviceInstanceId)
    const dr = getDateRangeFilter(range, from, to, '', services.weekStart)
    const { totals } = querySummaryTotals(db, df, dr, getToolFilter(null), false)
    json(res, summaryTotalsPayload(totals))
    return true
  }

  // ── /api/summary ──────────────────────────────────────────────
  if (url.pathname === '/api/summary') {
    if (range && !SUMMARY_RANGES.includes(range)) {
      json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid range' } }, 400)
      return true
    }
    const device = url.searchParams.get('device')
    const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
    const dr = getDateRangeFilter(range, from, to, '', services.weekStart)
    const tool = url.searchParams.get('tool')
    const tf = getToolFilter(tool)

    const { totals, byToolRows } = querySummaryTotals(db, df, dr, tf, true)

    const byTool: Record<string, { tokens: number; cost: number }> = {}
    for (const row of byToolRows) {
      byTool[row.tool] = { tokens: row.tokens, cost: row.cost }
    }

    const drJoin = getDateRangeFilter(range, from, to, 'tc', services.weekStart)
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
    return true
  }

  // ── /api/tokens ───────────────────────────────────────────────
  if (url.pathname === '/api/tokens') {
    const dr = getDateRangeFilter(range, from, to, '', services.weekStart)
    const device = url.searchParams.get('device')
    const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
    const tool = url.searchParams.get('tool')
    const tf = getToolFilter(tool)
    json(res, queryTokens(db, df, dr, tf))
    return true
  }

  // ── /api/cost ─────────────────────────────────────────────────
  if (url.pathname === '/api/cost') {
    const dr = getDateRangeFilter(range, from, to, '', services.weekStart)
    const device = url.searchParams.get('device')
    const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
    const tool = url.searchParams.get('tool')
    const tf = getToolFilter(tool)
    json(res, queryCosts(db, df, dr, tf))
    return true
  }

  // ── /api/models ───────────────────────────────────────────────
  if (url.pathname === '/api/models') {
    const dr = getDateRangeFilter(range, from, to, '', services.weekStart)
    const device = url.searchParams.get('device')
    const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
    const tool = url.searchParams.get('tool')
    const tf = getToolFilter(tool)
    json(res, queryModels(db, df, dr, tf))
    return true
  }
// ── /api/tools ────────────────────────────────────────────────
  if (url.pathname === '/api/tools' && req.method === 'GET') {
    const device = url.searchParams.get('device')
    const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
    const dr = getDateRangeFilter(range, from, to, '', services.weekStart)
    json(res, queryTools(db, df, dr, getToolFilter(null)))
    return true
  }
  return false
}
