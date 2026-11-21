import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    loadConfig: vi.fn(() => null),
    saveConfig: vi.fn(),
  }
})

import { createApiServer } from '../../src/api/server.js'
import { loadConfig, saveConfig } from '../../src/config.js'

const MAX_TIMER_DELAY = 2 ** 31 - 1

describe('PUT /api/config interval bounds', () => {
  let db: Database.Database
  let server: http.Server
  let baseUrl: string
  let onConfigUpdated: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.mocked(loadConfig).mockReturnValue(null)
    vi.mocked(saveConfig).mockReset()
    onConfigUpdated = vi.fn()
    db = new Database(':memory:')
    initializeDatabase(db)
    server = createApiServer(db, { onConfigUpdated })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number }
        baseUrl = `http://127.0.0.1:${addr.port}`
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
    db.close()
  })

  function put(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('does not expose or accept retired leaderboard settings', async () => {
    const legacy = { leaderboardAutoUpload: true, leaderboardUploadInterval: 3600000 }
    vi.mocked(loadConfig).mockReturnValue(legacy as any)
    const config = await (await fetch(`${baseUrl}/api/config`)).json()
    expect(config).not.toHaveProperty('leaderboardAutoUpload')
    expect(config).not.toHaveProperty('leaderboardUploadInterval')

    vi.mocked(loadConfig).mockReturnValue(null)
    expect((await put({ ...legacy, refreshInterval: 30000 })).status).toBe(200)
    expect(vi.mocked(saveConfig)).toHaveBeenLastCalledWith({ refreshInterval: 30000 })
  })

  it.each([
    ['GET', '/api/leaderboard'],
    ['POST', '/api/leaderboard/upload'],
    ['GET', '/api/leaderboard/auth/status'],
    ['POST', '/api/leaderboard/auth/start'],
    ['POST', '/api/leaderboard/auth/complete'],
    ['POST', '/api/leaderboard/auth/logout'],
  ])('returns 404 for retired %s %s', async (method, endpoint) => {
    const response = await fetch(`${baseUrl}${endpoint}`, { method })
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('NOT_FOUND')
  })

  const rejected: Array<[string, Record<string, unknown>]> = [
    ['refreshInterval in seconds', { refreshInterval: 30 }],
    ['refreshInterval just below the minimum', { refreshInterval: 999 }],
    ['refreshInterval above the timer limit', { refreshInterval: MAX_TIMER_DELAY + 1 }],
    ['negative refreshInterval', { refreshInterval: -1000 }],
    ['non-numeric refreshInterval', { refreshInterval: 'soon' }],
    ['boolean refreshInterval', { refreshInterval: true }],
    ['syncInterval below one minute', { syncInterval: 59999 }],
    ['syncInterval above the timer limit', { syncInterval: 2592000000 }],
    ['negative syncInterval', { syncInterval: -1 }],
    ['non-numeric syncInterval', { syncInterval: 'often' }],
  ]

  for (const [name, body] of rejected) {
    it(`rejects ${name}`, async () => {
      vi.mocked(loadConfig).mockReturnValue({ device: 'kept' } as any)

      const res = await put({ device: 'changed', ...body })
      const data = await res.json()

      expect(res.status).toBe(400)
      expect(data.error.code).toBe('INVALID_INTERVAL')
      expect(data.error.message).toContain(Object.keys(body)[0])
      expect(vi.mocked(saveConfig)).not.toHaveBeenCalled()
      expect(onConfigUpdated).not.toHaveBeenCalled()
    })
  }

  it('does not apply the week start of a save it rejects', async () => {
    // Wednesday noon, local time. The record is on the Sunday before: inside a
    // week that starts on Sunday, outside one that starts on Monday.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 0, 7, 12))
    try {
      vi.mocked(loadConfig).mockImplementation(() => ({ weekStart: 1 }) as any)
      db.prepare(`
        INSERT INTO records (id, ts, ingested_at, synced_at, updated_at, line_offset,
          tool, model, provider, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, thinking_tokens, cost, cost_source, session_id,
          source_file, device, device_instance_id)
        VALUES ('sunday', @ts, @ts, NULL, @ts, 0,
          'claude-code', 'claude-sonnet-4-6', 'anthropic', 7, 0, 0,
          0, 0, 0, 'pricing', 's-sunday',
          '/tmp/session.jsonl', 'local-device', 'local-uuid-0000')
      `).run({ ts: new Date(2026, 0, 4, 12).getTime() })
      const weekTokens = async () => (await (await fetch(`${baseUrl}/api/summary?range=week`)).json()).inputTokens

      expect(await weekTokens()).toBe(0)

      const rejectedSave = await put({ weekStart: 0, refreshInterval: 30 })
      expect(rejectedSave.status).toBe(400)
      expect(await weekTokens()).toBe(0)

      const acceptedSave = await put({ weekStart: 0, refreshInterval: 30000 })
      expect(acceptedSave.status).toBe(200)
      expect(await weekTokens()).toBe(7)
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts the bounds themselves', async () => {
    for (const body of [
      { refreshInterval: 1000, syncInterval: 60000 },
      { refreshInterval: MAX_TIMER_DELAY, syncInterval: MAX_TIMER_DELAY },
    ]) {
      vi.mocked(saveConfig).mockReset()
      const res = await put(body)
      expect(res.status).toBe(200)
      expect(vi.mocked(saveConfig)).toHaveBeenCalledWith(body)
    }
  })

  it('accepts every interval the dashboard offers', async () => {
    const syncMinutes = [5, 15, 30, 60, 120, 360, 720, 1440]

    for (const minutes of syncMinutes) {
      const res = await put({ syncInterval: minutes * 60000 })
      expect(res.status).toBe(200)
      expect(vi.mocked(saveConfig)).toHaveBeenLastCalledWith({ syncInterval: minutes * 60000 })
    }
  })

  it('accepts a numeric string and stores a number', async () => {
    const res = await put({ refreshInterval: '30000' })

    expect(res.status).toBe(200)
    expect(vi.mocked(saveConfig)).toHaveBeenCalledWith({ refreshInterval: 30000 })
  })

  it('still removes an interval that is saved blank', async () => {
    for (const blank of [null, 0, '']) {
      vi.mocked(saveConfig).mockReset()
      vi.mocked(loadConfig).mockReturnValue({
        refreshInterval: 30000,
        syncInterval: 300000,
        parseInterval: 5000,
      } as any)

      const res = await put({ refreshInterval: blank, syncInterval: blank })

      expect(res.status).toBe(200)
      expect(vi.mocked(saveConfig)).toHaveBeenCalledWith({})
    }
  })

  it('leaves a stored interval alone when the save does not mention it', async () => {
    vi.mocked(loadConfig).mockReturnValue({ refreshInterval: 30, syncInterval: 5 } as any)

    const res = await put({ device: 'laptop' })

    expect(res.status).toBe(200)
    expect(vi.mocked(saveConfig)).toHaveBeenCalledWith({
      device: 'laptop',
      refreshInterval: 30,
      syncInterval: 5,
    })
  })
})
