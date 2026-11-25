import { removePriceOverride, type PriceEntry } from '@aiusage/core'
import { loadConfig } from '../config.js'
import { recalcPricing } from '../commands/recalc.js'
import { applyLitellmPricing, fetchLitellmPricing, getPricingView, loadPricingRuntime, removeUserPricingAlias, resetUserPriceToSynced, setUserPrice, setUserPricingAlias } from '../pricing-registry.js'
import { BodyTooLargeError, readJsonBody } from './request-body.js'
import { json, bodyTooLarge, isDatabaseLockedError, databaseBusy } from './http-helpers.js'
import type { ApiRequestContext, ApiServices } from './context.js'

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

export function createPricingRoutes(services: ApiServices) {
  const { db, options, runDbWrite, getDbWriteQueueStatus } = services
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

    pricingRecalcStatus = {
  ...emptyPricingRecalcStatus(),
  state: 'queued',
  startedAt,
    }

    const failRecalc = (error: unknown) => {
  pricingRecalcStatus = {
    ...pricingRecalcStatus,
    state: 'error',
    finishedAt: Date.now(),
    error: error instanceof Error ? error.message : String(error),
  }
    }
    const runRecalc = async () => {
  const startedGeneration = pricingRecalcGeneration
  pricingRecalcStatus = {
    ...pricingRecalcStatus,
    state: 'running',
    queueRunning: false,
    queuePending: 0,
    startedAt: Date.now(),
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
    failRecalc(error)
  }
    }

    try { void runDbWrite(runRecalc).catch(failRecalc) } catch (error) { failRecalc(error) }

    return { accepted: true, status: currentPricingRecalcStatus() }
  }
  return async (context: ApiRequestContext): Promise<boolean> => {
    const { req, res, url } = context
// ── /api/pricing ────────────────────────────────────────────────
  if (url.pathname === '/api/pricing') {
    // GET: list all prices from the local pricing registry plus models from DB.
    if (req.method === 'GET') {
      json(res, getPricingView(db))
      return true
    }
    // PUT: set price override
    if (req.method === 'PUT') {
      let data: Record<string, unknown>
      try {
        data = await readJsonBody(req)
      } catch (error) {
        if (error instanceof BodyTooLargeError) { bodyTooLarge(res); return true }
        json(res, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400)
        return true
      }
      const validRate = (rate: unknown): rate is number => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0
      if (typeof data.model !== 'string' || !data.model.trim() || !validRate(data.input) || !validRate(data.output)
        || (data.cacheRead != null && !validRate(data.cacheRead)) || (data.cacheWrite != null && !validRate(data.cacheWrite))) {
        json(res, { error: { code: 'INVALID_PARAM', message: 'A nonempty model and finite nonnegative rates are required' } }, 400)
        return true
      }
      const entry: PriceEntry = {
        input: data.input,
        output: data.output,
        cacheRead: data.cacheRead == null ? undefined : data.cacheRead as number,
        cacheWrite: data.cacheWrite == null ? undefined : data.cacheWrite as number,
      }
      if (data.currency === 'CNY') {
        entry.currency = 'CNY'
      }
      try {
        await runDbWrite(() => {
          setUserPrice(db, data.model as string, entry)
          loadPricingRuntime(db, loadConfig())
        })
      } catch (error) {
        if (isDatabaseLockedError(error)) {
          databaseBusy(res)
          return true
        }
        throw error
      }
      json(res, { ok: true, needsRecalc: true, needsRecalcSince: markPricingNeedsRecalc() })
      return true
    }
    // DELETE: remove price override
    if (req.method === 'DELETE') {
      const model = url.searchParams.get('model')
      if (!model) {
        json(res, { error: { code: 'INVALID_PARAM', message: 'model param required' } }, 400)
        return true
      }
      try {
        await runDbWrite(() => {
          resetUserPriceToSynced(db, model)
          removePriceOverride(model)
          loadPricingRuntime(db, loadConfig())
        })
        json(res, { ok: true, needsRecalc: true, needsRecalcSince: markPricingNeedsRecalc() })
      } catch (error) {
        if (isDatabaseLockedError(error)) {
          databaseBusy(res)
          return true
        }
        throw error
      }
      return true
    }
  }

  if (url.pathname === '/api/pricing/alias' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req)
      if (typeof data.alias !== 'string' || typeof data.modelKey !== 'string') {
        json(res, { error: { code: 'INVALID_PARAM', message: 'alias and modelKey required' } }, 400)
        return true
      }
      const { alias, modelKey } = data
      await runDbWrite(() => {
        setUserPricingAlias(db, alias, modelKey)
        loadPricingRuntime(db, loadConfig())
      })
      json(res, { ok: true, needsRecalc: true, needsRecalcSince: markPricingNeedsRecalc() })
    } catch (error) {
      if (error instanceof BodyTooLargeError) { bodyTooLarge(res); return true }
      if (isDatabaseLockedError(error)) {
        databaseBusy(res)
        return true
      }
      json(res, { error: { code: 'INVALID_PARAM', message: error instanceof Error ? error.message : 'Invalid pricing alias' } }, 400)
    }
    return true
  }

  if (url.pathname === '/api/pricing/alias' && req.method === 'DELETE') {
    const alias = url.searchParams.get('alias')
    if (!alias) {
      json(res, { error: { code: 'INVALID_PARAM', message: 'alias param required' } }, 400)
      return true
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
        return true
      }
      json(res, { error: { code: 'INVALID_PARAM', message: error instanceof Error ? error.message : 'Invalid pricing alias' } }, 400)
    }
    return true
  }

  if (url.pathname === '/api/pricing/sync' && req.method === 'POST') {
    try {
      const prices = await fetchLitellmPricing()
      const summary = await runDbWrite(() => {
        const summary = applyLitellmPricing(db, prices)
        loadPricingRuntime(db, loadConfig())
        return summary
      })
      json(res, { ok: true, summary, needsRecalc: true, needsRecalcSince: markPricingNeedsRecalc() })
    } catch (error) {
      if (isDatabaseLockedError(error)) {
        databaseBusy(res)
        return true
      }
      json(res, { error: { code: 'SYNC_FAILED', message: error instanceof Error ? error.message : 'Pricing sync failed' } }, 502)
    }
    return true
  }

  // ── /api/pricing/recalc ─────────────────────────────────────────
  if (url.pathname === '/api/pricing/recalc' && req.method === 'GET') {
    json(res, currentPricingRecalcStatus())
    return true
  }

  if (url.pathname === '/api/pricing/recalc' && req.method === 'POST') {
    const result = startPricingRecalc()
    json(res, result, result.accepted ? 202 : 200)
    return true
  }
    return false
  }
}
