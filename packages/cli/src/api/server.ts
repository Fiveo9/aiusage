import http from 'node:http'
import type Database from 'better-sqlite3'
import { TOOLS } from '@aiusage/core'
import { loadConfig } from '../config.js'
import { isTrustedApiRequest } from './trust.js'
import { getDashboardPassword, isAuthenticated, shouldProtectApiPath } from '../auth.js'
import { AsyncTaskQueue } from '../db/write-queue.js'
import { BodyTooLargeError } from './request-body.js'
import { json, bodyTooLarge } from './http-helpers.js'
import { registerLocalDayFunction, getDateRangeBounds } from './query-helpers.js'
import type { ApiServerOptions, ApiServices, ApiRouteContext } from './context.js'
import { createAuthRoutes } from './auth.js'
import { handleSummaryRoute } from './summary.js'
import { handleActivityRoute } from './activity.js'
import { createPricingRoutes } from './pricing.js'
import { createConfigSyncRoutes, proxyCloudSyncStatus } from './config-sync.js'
import { handleImportRoute } from './import.js'

export function createApiServer(db: Database.Database, options?: ApiServerOptions): http.Server {
  registerLocalDayFunction(db)

  const cfg = loadConfig()
  let weekStart: 0 | 1 = (cfg?.weekStart ?? 1) as 0 | 1
  const dashboardPassword = getDashboardPassword()
  const localWriteQueue = new AsyncTaskQueue()
  const runDbWrite = options?.runDbWrite ?? (<T>(task: () => T | Promise<T>) => localWriteQueue.run(task))
  const getDbWriteQueueStatus = options?.getDbWriteQueueStatus ?? (() => localWriteQueue.getStatus())
  const services: ApiServices = {
    db, options, runDbWrite, getDbWriteQueueStatus,
    get weekStart() { return weekStart },
    set weekStart(value) { weekStart = value },
  }
  const handleAuth = createAuthRoutes(dashboardPassword)
  const handlePricing = createPricingRoutes(services)
  const handleConfigSync = createConfigSyncRoutes(services)



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
    if (await handleAuth({ req, res, url })) return


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
    try { getDateRangeBounds(range, from, to, weekStart) } catch {
      json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid range, from or to' } }, 400)
      return
    }

    // Validate tool parameter early — same style as range validation
    const toolParam = url.searchParams.get('tool')
    if (toolParam && !(TOOLS as readonly string[]).includes(toolParam)) {
      json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid tool' } }, 400)
      return
    }

    try {
      const context: ApiRouteContext = { services, req, res, url, range, from, to }
      if (await handleSummaryRoute(context)) return
      if (await handleActivityRoute(context)) return
      if (await handlePricing(context)) return
      if (await handleConfigSync(context)) return
      if (await handleImportRoute(context)) return


      // ── 404 ───────────────────────────────────────────────────────
      json(res, { error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }, 404)
    } catch (error) {
      if (error instanceof BodyTooLargeError) { bodyTooLarge(res); return }
      if (error instanceof URIError) { json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid encoded path' } }, 400); return }
      console.error('API error:', error)
      json(res, { error: { code: 'INTERNAL', message: 'Internal server error' } }, 500)
    }
  })

  return server
}

export { getDateRangeBounds } from './query-helpers.js'
export type { ApiServerOptions } from './context.js'
