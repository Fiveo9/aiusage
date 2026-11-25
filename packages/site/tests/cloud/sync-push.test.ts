import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory stand-in for cloud_usage_records, keyed by record_id -> updated_at.
// The fake mirrors what Postgres returns for the route's two statements:
// INSERT ... ON CONFLICT DO NOTHING RETURNING yields a row only for a new record,
// and the follow-up UPDATE ... RETURNING yields a row only for a newer record.
const db = vi.hoisted(() => ({
  rows: new Map<string, number>(),
  titles: new Map<string, string>(),
  recordQueries: [] as string[],
  recordParams: [] as unknown[][],
}))

vi.mock('$lib/server/db/pool.js', () => {
  // Positions of record_id / updated_at in the INSERT's VALUES list.
  // The UPDATE ends with `record_id = ... AND updated_at < ...`, so they come last.
  const RECORD_ID_PARAM = 5
  const UPDATED_AT_PARAM = 23

  const sql = (strings: TemplateStringsArray, ...params: unknown[]) => {
    const text = strings.join('?')
    if (text.includes('SELECT status FROM users') || text.includes('SELECT status FROM user_devices')) {
      return Promise.resolve([{ status: 'active' }])
    }
    if (text.includes('INSERT INTO cloud_device_instances')) {
      return Promise.resolve([{ id: 'instance_1' }])
    }
    if (text.includes('INSERT INTO cloud_usage_records')) {
      db.recordQueries.push(text)
      db.recordParams.push(params)
      const ids = params[RECORD_ID_PARAM] as string[]
      const versions = params[UPDATED_AT_PARAM] as number[]
      const titles = params[18] as string[]
      for (const [index, id] of ids.entries()) {
        const current = db.rows.get(id)
        if (current !== undefined && current >= versions[index]) continue
        db.rows.set(id, versions[index])
        db.titles.set(id, titles[index] || db.titles.get(id) || '')
      }
      return Promise.resolve([{ id: 'row' }])
    }
    if (text.includes('SELECT record_id, updated_at::text, session_title')) {
      return Promise.resolve([...db.rows].map(([record_id, updated_at]) => ({ record_id, updated_at: String(updated_at), session_title: db.titles.get(record_id) || '' })))
    }
    if (text.includes('UPDATE cloud_usage_records') && text.includes('RETURNING')) {
      db.recordQueries.push(text)
      db.recordParams.push(params)
      const [recordId, updatedAt] = params.slice(-2) as [string, number]
      const current = db.rows.get(recordId)
      if (current === undefined || current >= updatedAt) return Promise.resolve([])
      db.rows.set(recordId, updatedAt)
      return Promise.resolve([{ id: 'row' }])
    }
    if (text.includes('FROM cloud_device_instances')) {
      return Promise.resolve([{ id: 'instance_1', sync_generation: 1 }])
    }
    if (text.includes('MAX(change_seq)')) {
      return Promise.resolve([{ max_seq: db.rows.size }])
    }
    return Promise.resolve([])
  }
  sql.begin = (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql)
  sql.array = (values: unknown[]) => values
  return { sql }
})

vi.mock('$lib/server/auth/device-request.js', () => ({
  verifyDeviceRequest: async () => ({
    valid: true,
    userId: 'user_1',
    deviceId: 'device_1',
    idempotencyKey: 'idem_1',
  }),
}))

vi.mock('$lib/server/config.js', () => ({
  CFG: {
    SYNC_MAX_RECORDS: 'sync_max_records',
    SYNC_MAX_TOMBSTONES: 'sync_max_tombstones',
    SYNC_BODY_MAX_SIZE: 'sync_body_max_size',
  },
  getConfigValue: async () => 1_000_000,
}))

vi.mock('$lib/server/cloud/star-check.js', () => ({
  checkCloudSyncAccess: async () => ({ allowed: true }),
}))

import { POST } from '../../src/routes/api/cli/sync/push/+server.js'

function record(id: string, updatedAt: number, overrides: Record<string, unknown> = {}) {
  return { id, ts: 1_000, tool: 'claude-code', model: 'claude-sonnet-4', updatedAt, ...overrides }
}

async function push(records: unknown[], tombstones: unknown[] = []) {
  const request = new Request('http://localhost/api/cli/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_version: 1,
      device_instance_id: 'instance_a',
      sync_generation: 1,
      records,
      tombstones,
    }),
  })
  const response = await POST({ request } as Parameters<typeof POST>[0])
  return { status: response.status, body: await response.json() }
}

describe('POST /api/cli/sync/push result counters', () => {
  beforeEach(() => {
    db.rows.clear()
    db.titles.clear()
    db.recordQueries.length = 0
    db.recordParams.length = 0
  })

  it('counts newly created rows as inserted', async () => {
    const { status, body } = await push([record('r1', 100), record('r2', 100)])
    expect(status).toBe(200)
    expect(body).toMatchObject({ status: 'accepted', inserted: 2, updated: 0, skipped: 0 })
  })

  it('stores real titles and keeps them when an older client omits the field', async () => {
    const title = '真实标题 / API'
    await push([record('named', 100, { sessionTitle: title })])
    expect(db.recordQueries[0]).toContain('session_title')
    expect(db.titles.get('named')).toBe(title)
    await push([record('named', 200)])
    expect(db.recordQueries.at(-1)).toContain("session_title = COALESCE(NULLIF(EXCLUDED.session_title, ''), cloud_usage_records.session_title)")
    expect(db.titles.get('named')).toBe(title)
  })

  it('rejects a non-text or NUL-containing title before writing it', async () => {
    const { body } = await push([record('bad-type', 100, { sessionTitle: 42 }), record('bad-nul', 100, { sessionTitle: 'a\u0000b' })])
    expect(body.inserted).toBe(0)
    expect(db.recordQueries).toHaveLength(0)
  })

  it('counts a newer record for an existing row as updated', async () => {
    db.rows.set('r1', 100)
    const { body } = await push([record('r1', 200)])
    expect(body).toMatchObject({ inserted: 0, updated: 1, skipped: 0 })
    expect(db.rows.get('r1')).toBe(200)
  })

  it('counts stale and equal records as skipped', async () => {
    db.rows.set('r1', 100)
    db.rows.set('r2', 100)
    const { body } = await push([record('r1', 50), record('r2', 100)])
    expect(body).toMatchObject({ inserted: 0, updated: 0, skipped: 2 })
    expect(db.rows.get('r1')).toBe(100)
  })

  it('classifies a mixed batch per record', async () => {
    db.rows.set('existing-newer', 100)
    db.rows.set('existing-stale', 100)
    const { body } = await push([
      record('fresh', 100),
      record('existing-newer', 200),
      record('existing-stale', 100),
      record('', 100),
      record('no-model', 100, { model: '' }),
    ])
    expect(body).toMatchObject({ inserted: 1, updated: 1, skipped: 3 })
  })

  it('uses one guarded batch upsert for new and newer records', async () => {
    db.rows.set('existing', 100)
    await push([record('fresh', 100), record('existing', 200)])
    expect(db.recordQueries).toHaveLength(1)
    expect(db.recordQueries[0]).toContain('FROM UNNEST(')
    expect(db.recordQueries[0]).toContain('WHERE cloud_usage_records.updated_at < EXCLUDED.updated_at')
  })

  it('does not rely on PostgreSQL system columns', async () => {
    db.rows.set('existing', 100)
    await push([record('fresh', 100), record('existing', 200)])
    expect(db.recordQueries.join(' ')).not.toMatch(/xmax/i)
  })
})
