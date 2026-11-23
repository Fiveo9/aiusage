import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const home = mkdtempSync(join(tmpdir(), 'aiusage-api-queue-'))
const site = vi.hoisted(() => ({ url: 'https://synthetic.invalid' }))
vi.mock('node:os', async () => ({ ...await vi.importActual<typeof import('node:os')>('node:os'), homedir: () => home }))
vi.mock('../../src/site-url.js', () => ({ getSiteUrl: () => site.url }))
const { createApiServer } = await import('../../src/api/server.js')
const { initializeDatabase } = await import('../../src/db/index.js')
const { insertRecord } = await import('../../src/db/records.js')
const { AsyncTaskQueue } = await import('../../src/db/write-queue.js')
const { AIUSAGE_DIR } = await import('../../src/config.js')

describe('review API network and write queue boundaries', () => {
  let db: Database.Database
  let server: http.Server
  let base: string
  let queue: InstanceType<typeof AsyncTaskQueue>
  let release: (() => void) | undefined
  let releaseNetwork: (() => void) | undefined
  const pending: Array<Promise<unknown>> = []
  beforeEach(async () => {
    vi.stubEnv('AIUSAGE_DASHBOARD_PASSWORD', '')
    rmSync(AIUSAGE_DIR, { recursive: true, force: true })
    site.url = 'https://synthetic.invalid'
    queue = new AsyncTaskQueue()
    release = undefined
    releaseNetwork = undefined
    db = new Database(':memory:')
    initializeDatabase(db)
    insertRecord(db, { id: 'synthetic', ts: 1000, ingestedAt: 1000, updatedAt: 1000, lineOffset: 0, tool: 'codex',
      model: 'queued-model', provider: 'synthetic', inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      thinkingTokens: 0, cost: 0, costSource: 'unknown', sessionId: 's', sourceFile: 'synthetic.jsonl', device: 'Synthetic', deviceInstanceId: 'own' })
    server = createApiServer(db, { currentDeviceInstanceId: 'own', runDbWrite: task => queue.run(task), getDbWriteQueueStatus: () => queue.getStatus() })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(async () => {
    release?.(); releaseNetwork?.()
    await Promise.allSettled(pending.splice(0))
    for (let step = 0; step < 50 && (queue.getStatus().running || queue.getStatus().pending); step++) await new Promise(resolve => setTimeout(resolve, 10))
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks()
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  function request(path: string, method = 'GET', body?: unknown): Promise<{ status: number; data: any }> {
    const result = new Promise<{ status: number; data: any }>((resolve, reject) => {
      const req = http.request(base + path, { method, headers: { 'Content-Type': 'application/json', Connection: 'close' } }, response => {
        let text = ''
        response.on('data', chunk => text += chunk)
        response.once('end', () => {
          try { resolve({ status: response.statusCode!, data: JSON.parse(text) }) } catch (error) { reject(error) }
        })
      })
      req.once('error', reject)
      req.setTimeout(1500, () => req.destroy(new Error('Synthetic API request timed out')))
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
    pending.push(result)
    return result
  }
  async function blockWrites() {
    const task = queue.run(() => new Promise<void>(resolve => { release = resolve }))
    await new Promise(resolve => setImmediate(resolve))
    return { task }
  }
  async function completedRecalc() {
    for (let step = 0; step < 60; step++) {
      const response = await request('/api/pricing/recalc')
      if (response.data.state === 'done' || response.data.state === 'error') return response.data
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Synthetic recalculation did not complete')
  }

  it('keeps recalculation queued behind an existing database write', async () => {
    const blocked = await blockWrites()
    const response = await request('/api/pricing/recalc', 'POST')
    expect(response.status).toBe(202)
    expect(response.data.status).toMatchObject({ state: 'queued', queueRunning: true, queuePending: 1 })
    expect((await request('/api/pricing/recalc', 'POST')).data.accepted).toBe(false)
    release!(); release = undefined
    await blocked.task
    expect((await completedRecalc()).state).toBe('done')
  })

  it('does not hold the database write queue while fetching LiteLLM', async () => {
    let fetched!: () => void
    const fetching = new Promise<void>(resolve => { fetched = resolve })
    const response = new Promise<any>(resolve => { releaseNetwork = () => resolve({ ok: true, status: 200, json: async () => ({
      'synthetic-network-model': { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
    }) }) })
    vi.stubGlobal('fetch', vi.fn(() => { fetched(); return response }))
    const syncing = request('/api/pricing/sync', 'POST')
    await fetching
    const writing = request('/api/pricing', 'PUT', { model: 'queued-model', input: 1, output: 2 })
    const immediate = await Promise.race([writing, new Promise<null>(resolve => setTimeout(() => resolve(null), 500))])
    expect(immediate?.status).toBe(200)
    releaseNetwork!(); releaseNetwork = undefined
    expect((await syncing).status).toBe(200)
  })

  it('uses the pricing generation at actual queued execution, not at request acceptance', async () => {
    const blocked = await blockWrites()
    const write = request('/api/pricing', 'PUT', { model: 'queued-model', input: 1, output: 2 })
    // Wait until the earlier pricing write has reached the shared queue.
    for (let step = 0; step < 50 && queue.getStatus().pending < 1; step++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(queue.getStatus().pending).toBe(1)
    expect((await request('/api/pricing/recalc', 'POST')).status).toBe(202)
    release!(); release = undefined
    await blocked.task
    expect((await write).status).toBe(200)
    expect(await completedRecalc()).toMatchObject({ state: 'done', needsRecalc: false })
  })

  it('treats a malformed cloud status URL as an unavailable upstream, not a rejected handler', async () => {
    site.url = 'synthetic invalid URL'
    vi.stubGlobal('fetch', vi.fn())
    expect(await request('/api/cli/sync/status')).toMatchObject({ status: 200, data: { enabled: false } })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('uses a deadline for the cloud status proxy without holding the write queue', async () => {
    const upstream = vi.fn(async () => Response.json({ enabled: true }))
    vi.stubGlobal('fetch', upstream)
    expect(await request('/api/cli/sync/status')).toMatchObject({ status: 200, data: { enabled: true } })
    expect((upstream.mock.calls[0] as unknown[])[1]).toMatchObject({ signal: expect.any(AbortSignal) })
    expect(queue.getStatus()).toEqual({ running: false, pending: 0 })
  })
})
