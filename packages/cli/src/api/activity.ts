import { extractProject, extractProjectFromCwd } from './project-extraction.js'
import { getSessionTitle } from '../db/session-titles.js'
import { json } from './http-helpers.js'
import { getDateRangeFilter, getToolFilter, classifyToolCall, parseMcpName, getToolTypeFilter, activityPaging, activityDeviceFilter } from './query-helpers.js'
import type { ApiRouteContext } from './context.js'

export async function handleActivityRoute(context: ApiRouteContext): Promise<boolean> {
  const { services, req, res, url, range, from, to } = context
  const { db, options } = services
// ── /api/tool-calls ───────────────────────────────────────────
  if (url.pathname === '/api/tool-calls' || url.pathname === '/api/tool-calls/events') {
    const device = url.searchParams.get('device')
    const df = activityDeviceFilter(device, options?.currentDeviceInstanceId, 'tc.owner', 'tc.origin')

    const dr = getDateRangeFilter(range, from, to, 'tc', services.weekStart)
    const tool = url.searchParams.get('tool')
    const tfRaw = getToolFilter(tool, 'r')
    const tf = {
      where: tfRaw.where.replaceAll('r.tool', 'COALESCE(r.tool, tc.tool)'),
      params: tfRaw.params,
    }
    const toolType = url.searchParams.get('toolType')
    if (toolType && !['mcp', 'skill', 'builtin'].includes(toolType)) {
      json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid toolType' } }, 400)
      return true
    }
    const ttf = getToolTypeFilter(toolType)

    if (url.pathname.endsWith('/events')) {
      const paging = activityPaging(url)
      const name = url.searchParams.get('name')
      if (!paging || !name) {
        json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid tool name or pagination' } }, 400)
        return true
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
      return true
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
    return true
  }

  // ── /api/sessions/:sessionId ──────────────────────────────────
  if (url.pathname.startsWith('/api/sessions/') && req.method === 'GET') {
    const sessionId = decodeURIComponent(url.pathname.slice('/api/sessions/'.length))
    if (!sessionId) {
      json(res, { error: { code: 'INVALID_PARAM', message: 'Missing sessionId' } }, 400)
      return true
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
      return true
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
    return true
  }

  // ── /api/sessions ─────────────────────────────────────────────
  if (url.pathname === '/api/sessions') {
    const query = (url.searchParams.get('q') || '').trim()
    const sort = url.searchParams.get('sort') || 'newest'
    if (query.length > 200 || !['newest', 'cost', 'tokens'].includes(sort) || query.includes('\0')) {
      json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid session search or sort' } }, 400)
      return true
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
      return true
    }
    const pageSize = Math.min(100, requestedPageSize)
    const offset = (page - 1) * pageSize
    if (!Number.isSafeInteger(offset)) {
      json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid page' } }, 400)
      return true
    }

    const dr = getDateRangeFilter(range, from, to, 'r', services.weekStart)
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
    return true
  }

  // ── /api/projects ─────────────────────────────────────────────
  if (url.pathname === '/api/projects' || url.pathname === '/api/projects/sessions') {
    const dr = getDateRangeFilter(range, from, to, '', services.weekStart)
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
      if (!row.cwd && !row.source_file) continue
      let effectiveCwd: string = row.cwd || ''
      if (!effectiveCwd && row.source_file) {
        const m = (row.source_file as string).replace(/\\/g, '/').match(/\.claude\/projects\/([^/]+)/)
        if (m) effectiveCwd = cwdByEncodedDir.get(JSON.stringify([row.deviceInstanceId, m[1]])) || ''
      }
      const fromCwd = effectiveCwd ? extractProjectFromCwd(effectiveCwd) : null
      const project = (fromCwd && fromCwd !== 'unknown') ? fromCwd : extractProject(row.source_file || '')
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
        return true
      }
      const rows = [...(projectMap.get(name)?.sessions.values() ?? [])].sort((left, right) =>
        right.ts - left.ts || left.deviceInstanceId.localeCompare(right.deviceInstanceId) || left.sessionId.localeCompare(right.sessionId))
      const sessions = rows.slice(paging.offset, paging.offset + paging.pageSize).map(session => ({
        ...session, sessionTitle: getSessionTitle(db, session.sessionId, session.deviceInstanceId, tool || undefined),
      }))
      json(res, { sessions, total: rows.length, page: paging.page, pageSize: paging.pageSize })
      return true
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
    return true
  }
  return false
}
