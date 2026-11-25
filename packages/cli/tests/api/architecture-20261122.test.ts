import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import Database from 'better-sqlite3'
import { createApiServer } from '../../src/api/server.js'
import { initializeDatabase } from '../../src/db/index.js'
import * as config from '../../src/config.js'

describe('API domain boundaries', () => {
  let db: Database.Database
  let server: http.Server
  let baseUrl: string

  beforeEach(async () => {
    vi.stubEnv('AIUSAGE_DASHBOARD_PASSWORD', '')
    vi.spyOn(config, 'loadConfig').mockReturnValue({ device: 'local', weekStart: 1 })
    vi.spyOn(config, 'updateConfig').mockImplementation((update) => {
      const value: config.Config = { device: 'local', weekStart: 1 }
      update(value)
      return value
    })
    db = new Database(':memory:')
    initializeDatabase(db)
    server = createApiServer(db)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    if (server?.listening) {
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    db?.close()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('stores manual prices only in the registry, not the retired config field', async () => {
    const response = await fetch(`${baseUrl}/api/pricing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'architecture-model', input: 2, output: 3 }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, needsRecalc: true })
    expect(db.prepare('SELECT input, output FROM model_prices WHERE model_key = ?').get('architecture-model'))
      .toMatchObject({ input: 2, output: 3 })
    expect(config.updateConfig).not.toHaveBeenCalled()
  })

  it('resets a price without rewriting the retired config field', async () => {
    const response = await fetch(`${baseUrl}/api/pricing?model=architecture-model`, { method: 'DELETE' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, needsRecalc: true })
    expect(config.updateConfig).not.toHaveBeenCalled()
  })

  it.each(['legacy-id', 'legacy-alias'])('uses records for every legacy device query (%s)', async (device) => {
    db.prepare(`INSERT INTO records (
      id, ts, ingested_at, updated_at, line_offset, tool, model, provider,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens,
      cost, cost_source, session_id, source_file, device, device_instance_id
    ) VALUES ('legacy', 1770000000000, 1770000000000, 1770000000000, 0, 'kelivo', 'gpt-4o', 'openai',
      100, 25, 0, 0, 0, 2, 'log', 'legacy-session', 'fixture/chats.json', 'legacy-alias', 'legacy-id')`).run()
    const query = `range=all&device=${device}`
    const summary = await (await fetch(`${baseUrl}/api/summary?${query}`)).json()
    const tokens = await (await fetch(`${baseUrl}/api/tokens?${query}`)).json()
    const cost = await (await fetch(`${baseUrl}/api/cost?${query}`)).json()
    const models = await (await fetch(`${baseUrl}/api/models?${query}`)).json()
    const tools = await (await fetch(`${baseUrl}/api/tools?${query}`)).json()
    expect(summary).toMatchObject({ totalTokens: 125, totalCost: 2, totalSessions: 1 })
    expect(tokens.data).toHaveLength(1)
    expect(tokens.data[0]).toMatchObject({ inputTokens: 100, outputTokens: 25 })
    expect(cost.byTool).toEqual({ kelivo: 2 })
    expect(models.models[0]).toMatchObject({ model: 'gpt-4o', totalTokens: 125 })
    expect(tools.tools).toEqual([{ tool: 'kelivo', sessionCount: 1 }])
  })
})
