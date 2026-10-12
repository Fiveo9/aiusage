import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createApiServer } from '../../src/api/server.js'
import { initializeDatabase } from '../../src/db/index.js'

const BASE_TS = 1715683200000

function insertRecord(db: Database.Database, overrides: Record<string, unknown> = {}) {
  const defaults = {
    id: 'r1',
    ts: BASE_TS,
    ingested_at: BASE_TS,
    synced_at: null,
    updated_at: BASE_TS,
    line_offset: 0,
    tool: 'claude-code',
    model: 'model-a',
    provider: 'anthropic',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    thinking_tokens: 0,
    cost: 0,
    cost_source: 'pricing',
    session_id: 's1',
    source_file: '/tmp/s1.jsonl',
    device: 'local-device',
    device_instance_id: 'local-uuid-0000',
  }
  db.prepare(`
    INSERT INTO records (id, ts, ingested_at, synced_at, updated_at, line_offset,
      tool, model, provider, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, thinking_tokens, cost, cost_source, session_id,
      source_file, device, device_instance_id)
    VALUES (@id, @ts, @ingested_at, @synced_at, @updated_at, @line_offset,
      @tool, @model, @provider, @input_tokens, @output_tokens, @cache_read_tokens,
      @cache_write_tokens, @thinking_tokens, @cost, @cost_source, @session_id,
      @source_file, @device, @device_instance_id)
  `).run({ ...defaults, ...overrides })
}

function insertToolCalls(db: Database.Database, recordId: string, count: number, tool = 'claude-code') {
  const stmt = db.prepare(`
    INSERT INTO tool_calls (id, record_id, tool, name, ts, call_index)
    VALUES (?, ?, ?, 'Read', ?, ?)
  `)
  for (let i = 0; i < count; i++) {
    stmt.run(`${recordId}-tc${i}`, recordId, tool, BASE_TS + i, i)
  }
}

describe('sessions endpoints', () => {
  let dir: string
  let db: Database.Database
  let server: http.Server
  let baseUrl: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiusage-sessions-endpoints-'))
    db = new Database(join(dir, 'cache.db'))
    initializeDatabase(db)
    server = createApiServer(db)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as any
        baseUrl = `http://127.0.0.1:${address.port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function getJson(path: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${path}`)
    return { status: res.status, body: await res.json() }
  }

  describe('GET /api/sessions totals (#94)', () => {
    it('counts each record once however many tool calls it has', async () => {
      insertRecord(db, {
        id: 'r1', input_tokens: 1000, output_tokens: 100, cache_read_tokens: 10, cache_write_tokens: 20, cost: 1,
      })
      insertRecord(db, {
        id: 'r2', ts: BASE_TS + 60000, input_tokens: 500, output_tokens: 50, cache_read_tokens: 5, cache_write_tokens: 2, cost: 0.5,
      })
      insertToolCalls(db, 'r1', 3)

      const { status, body } = await getJson('/api/sessions?range=all')

      expect(status).toBe(200)
      expect(body.total).toBe(1)
      expect(body.sessions).toHaveLength(1)
      expect(body.sessions[0]).toMatchObject({
        sessionId: 's1',
        tool: 'claude-code',
        model: 'model-a',
        ts: BASE_TS,
        duration: 60000,
        inputTokens: 1500,
        outputTokens: 150,
        cacheReadTokens: 15,
        cacheWriteTokens: 22,
        cost: 1.5,
        toolCallCount: 3,
      })
    })

    it('reports zero tool calls for a session without any', async () => {
      insertRecord(db, { id: 'r1', input_tokens: 7, cost: 0.25 })

      const { body } = await getJson('/api/sessions?range=all')

      expect(body.sessions[0]).toMatchObject({ inputTokens: 7, cost: 0.25, toolCallCount: 0 })
    })

    it('keeps tool-call counts separate per session and orders newest first', async () => {
      insertRecord(db, { id: 'a1', session_id: 'old', ts: BASE_TS, input_tokens: 10, cost: 0.1 })
      insertRecord(db, { id: 'a2', session_id: 'old', ts: BASE_TS + 1000, input_tokens: 20, cost: 0.2 })
      insertRecord(db, { id: 'b1', session_id: 'new', ts: BASE_TS + 5000, input_tokens: 100, cost: 1 })
      insertToolCalls(db, 'a1', 2)
      insertToolCalls(db, 'a2', 4)
      insertToolCalls(db, 'b1', 5)

      const { body } = await getJson('/api/sessions?range=all')

      expect(body.sessions.map((s: any) => [s.sessionId, s.inputTokens, s.toolCallCount])).toEqual([
        ['new', 100, 5],
        ['old', 30, 6],
      ])
      expect(body.sessions[1].cost).toBeCloseTo(0.3)
    })

    it('applies the tool filter to the tool-call count as well as the totals', async () => {
      insertRecord(db, { id: 'c1', tool: 'claude-code', input_tokens: 100, cost: 1 })
      insertRecord(db, { id: 'x1', tool: 'codex', ts: BASE_TS + 1000, input_tokens: 900, cost: 9 })
      insertToolCalls(db, 'c1', 2)
      insertToolCalls(db, 'x1', 7, 'codex')

      const { body } = await getJson('/api/sessions?range=all&tool=claude-code')

      expect(body.total).toBe(1)
      expect(body.sessions[0]).toMatchObject({ sessionId: 's1', tool: 'claude-code', inputTokens: 100, cost: 1, toolCallCount: 2 })
    })

    it('applies the date range to the tool-call count as well as the totals', async () => {
      insertRecord(db, { id: 'd1', ts: Date.UTC(2024, 0, 10, 12), input_tokens: 100, cost: 1 })
      insertRecord(db, { id: 'd2', ts: Date.UTC(2024, 2, 10, 12), input_tokens: 900, cost: 9 })
      insertToolCalls(db, 'd1', 2)
      insertToolCalls(db, 'd2', 7)

      const { body } = await getJson('/api/sessions?from=2024-01-09&to=2024-01-11')

      expect(body.total).toBe(1)
      expect(body.sessions[0]).toMatchObject({ inputTokens: 100, cost: 1, toolCallCount: 2 })
    })

    it('leaves records merged from other devices out of the totals and the tool-call count', async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server = createApiServer(db, { currentDeviceInstanceId: 'local-uuid-0000' })
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
          resolve()
        })
      })
      insertRecord(db, { id: 'l1', input_tokens: 100, cost: 1 })
      insertRecord(db, { id: 'm1', ts: BASE_TS + 1000, input_tokens: 900, cost: 9, device_instance_id: 'other-uuid' })
      db.prepare("UPDATE records SET origin = 'synced' WHERE id = 'm1'").run()
      insertToolCalls(db, 'l1', 2)
      insertToolCalls(db, 'm1', 7)

      for (const query of ['', '&device=local-uuid-0000']) {
        const { body } = await getJson(`/api/sessions?range=all${query}`)

        expect(body.total).toBe(1)
        expect(body.sessions[0]).toMatchObject({ sessionId: 's1', inputTokens: 100, cost: 1, duration: 0, toolCallCount: 2 })
      }
    })

    it('pages over sessions, not over joined tool-call rows', async () => {
      for (let i = 0; i < 5; i++) {
        insertRecord(db, { id: `p${i}`, session_id: `sess-${i}`, ts: BASE_TS + i * 1000, input_tokens: i + 1 })
        insertToolCalls(db, `p${i}`, 3)
      }

      const first = await getJson('/api/sessions?range=all&page=1&pageSize=2')
      const third = await getJson('/api/sessions?range=all&page=3&pageSize=2')

      expect(first.body).toMatchObject({ total: 5, page: 1, pageSize: 2 })
      expect(first.body.sessions.map((s: any) => s.sessionId)).toEqual(['sess-4', 'sess-3'])
      expect(first.body.sessions.map((s: any) => s.inputTokens)).toEqual([5, 4])
      expect(first.body.sessions.map((s: any) => s.toolCallCount)).toEqual([3, 3])
      expect(third.body.sessions.map((s: any) => s.sessionId)).toEqual(['sess-0'])
    })
  })

  describe('GET /api/sessions/:id header (#95)', () => {
    it('covers every model of the session and lists the models', async () => {
      insertRecord(db, { id: 'r1', model: 'model-a', input_tokens: 1000, output_tokens: 10, cost: 1 })
      insertRecord(db, { id: 'r2', model: 'model-b', ts: BASE_TS + 1000, input_tokens: 500, output_tokens: 5, cost: 0.5 })
      insertRecord(db, { id: 'r3', model: 'model-a', ts: BASE_TS + 2000, input_tokens: 1, output_tokens: 1, cost: 0.25 })
      insertToolCalls(db, 'r1', 2)
      insertToolCalls(db, 'r2', 1)

      const { status, body } = await getJson('/api/sessions/s1')

      expect(status).toBe(200)
      expect(body.session).toMatchObject({
        sessionId: 's1',
        tool: 'claude-code',
        model: 'model-a',
        models: ['model-a', 'model-b'],
        firstTs: BASE_TS,
        lastTs: BASE_TS + 2000,
        duration: 2000,
        inputTokens: 1501,
        outputTokens: 16,
        cost: 1.75,
        recordCount: 3,
        toolCallCount: 3,
      })
      expect(body.records).toHaveLength(3)
      expect(body.records.reduce((sum: number, r: any) => sum + r.inputTokens, 0)).toBe(body.session.inputTokens)
    })

    it('names the model of the earliest record first, whatever the insertion order', async () => {
      insertRecord(db, { id: 'r1', model: 'model-late', ts: BASE_TS + 5000, input_tokens: 1 })
      insertRecord(db, { id: 'r2', model: 'model-early', ts: BASE_TS, input_tokens: 2 })

      const { body } = await getJson('/api/sessions/s1')

      expect(body.session.model).toBe('model-early')
      expect(body.session.models).toEqual(['model-early', 'model-late'])
      expect(body.session.recordCount).toBe(2)
    })

    it('keeps a single-model session unchanged apart from the models list', async () => {
      insertRecord(db, { id: 'r1', input_tokens: 1000, cost: 1 })
      insertRecord(db, { id: 'r2', ts: BASE_TS + 60000, input_tokens: 500, cost: 0.5 })

      const { body } = await getJson('/api/sessions/s1')

      expect(body.session).toMatchObject({
        tool: 'claude-code', model: 'model-a', models: ['model-a'], inputTokens: 1500, cost: 1.5, recordCount: 2, duration: 60000,
      })
    })

    it('restricts the header to the requested tool', async () => {
      insertRecord(db, { id: 'r1', tool: 'claude-code', model: 'model-a', input_tokens: 100 })
      insertRecord(db, { id: 'r2', tool: 'codex', model: 'model-x', ts: BASE_TS + 1000, input_tokens: 900 })

      const { body } = await getJson('/api/sessions/s1?tool=codex')

      expect(body.session).toMatchObject({ tool: 'codex', model: 'model-x', models: ['model-x'], inputTokens: 900, recordCount: 1 })
    })

    it('still answers 404 for an unknown session', async () => {
      const { status, body } = await getJson('/api/sessions/nope')

      expect(status).toBe(404)
      expect(body.error.code).toBe('NOT_FOUND')
    })
  })

  describe('GET /api/sessions page and pageSize (#110)', () => {
    beforeEach(() => {
      for (let i = 0; i < 3; i++) {
        insertRecord(db, { id: `p${i}`, session_id: `sess-${i}`, ts: BASE_TS + i * 1000 })
      }
    })

    it.each([
      ['page=abc'],
      ['page=1.5'],
      ['page=2x'],
      ['page=1e3'],
      ['page=0'],
      ['page=-1'],
      ['page=99999999999999999999999'],
      ['page=9007199254740991&pageSize=100'],
      ['pageSize=abc'],
      ['pageSize=0'],
      ['pageSize=-5'],
      ['pageSize=10.5'],
    ])('rejects %s with 400 INVALID_PARAM', async (query) => {
      const { status, body } = await getJson(`/api/sessions?range=all&${query}`)

      expect(status).toBe(400)
      expect(body.error.code).toBe('INVALID_PARAM')
    })

    it.each([
      [''],
      ['&page=&pageSize='],
    ])('defaults to page 1 and pageSize 50 when the parameters are absent or empty (%s)', async (query) => {
      const { status, body } = await getJson(`/api/sessions?range=all${query}`)

      expect(status).toBe(200)
      expect(body).toMatchObject({ total: 3, page: 1, pageSize: 50 })
      expect(body.sessions).toHaveLength(3)
    })

    it('caps pageSize at 100', async () => {
      const { status, body } = await getJson('/api/sessions?range=all&pageSize=5000')

      expect(status).toBe(200)
      expect(body.pageSize).toBe(100)
    })

    it('returns an empty page with the real total past the last page', async () => {
      const { status, body } = await getJson('/api/sessions?range=all&page=3&pageSize=2')

      expect(status).toBe(200)
      expect(body).toMatchObject({ sessions: [], total: 3, page: 3, pageSize: 2 })
    })

    it('validates before the other-device shortcut', async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server = createApiServer(db, { currentDeviceInstanceId: 'local-uuid-0000' })
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
          resolve()
        })
      })

      const bad = await getJson('/api/sessions?range=all&device=other-uuid&page=abc')
      const ok = await getJson('/api/sessions?range=all&device=other-uuid&page=2')

      expect(bad.status).toBe(400)
      expect(ok.body).toEqual({ sessions: [], total: 0, page: 2, pageSize: 50 })
    })
  })
})
