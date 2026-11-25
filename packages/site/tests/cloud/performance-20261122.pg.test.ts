import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('$lib/server/db/pool.js', async () => ({ sql: (await import('../helpers/pglite-sql.js')).sql }))
vi.mock('$lib/server/auth/device-request.js', () => ({ verifyDeviceRequest: async () => ({ valid: true,
  userId: 'review-user', deviceId: 'review-device', idempotencyKey: `review-${Math.random()}` }) }))
vi.mock('$lib/server/cloud/star-check.js', () => ({ checkCloudSyncAccess: async () => ({ allowed: true }) }))
import { executedStatements, migrateTestDatabase, query, truncate } from '../helpers/pglite-sql.js'
import { POST } from '../../src/routes/api/cli/sync/push/+server.js'
import { syncPricingFromLitellm, getPriceEntries } from '../../src/lib/server/admin/operations.js'

beforeAll(() => migrateTestDatabase())
beforeEach(async () => {
  await truncate('cloud_usage_records', 'cloud_sync_batches', 'cloud_device_instances', 'cloud_sync_resets', 'cloud_sync_state',
    'user_devices', 'model_price_aliases', 'model_prices', 'admin_audit_logs', 'users')
  await query(`INSERT INTO users (id, username, email, display_name, role) VALUES ('review-user', 'review', 'review@example.com', 'Review', 'admin')`)
  await query(`INSERT INTO user_devices (id, user_id, name, secret_encrypted, secret_hash) VALUES ('review-device', 'review-user', 'fixture', 'fixture', 'fixture')`)
  executedStatements.length = 0
})
afterEach(() => vi.unstubAllGlobals())
const record = (id: string, updatedAt = 100, extra: Record<string, unknown> = {}) => ({ id, updatedAt, ts: 1000,
  tool: 'codex', model: 'review-model', inputTokens: 10, outputTokens: 5, ...extra })
async function push(records: unknown[], tombstones: unknown[] = []) {
  const request = new Request('http://localhost/api/cli/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema_version: 1, device_instance_id: 'review-instance', sync_generation: 1, records, tombstones }) })
  const response = await POST({ request } as Parameters<typeof POST>[0])
  expect(response.status).toBe(200)
  return response.json()
}

describe('F20 PostgreSQL batch boundaries', () => {
  it('stores 200 records and applies 200 tombstones with constant write statements', async () => {
    expect(await push(Array.from({ length: 200 }, (_, i) => record(`record-${i}`)))).toMatchObject({ inserted: 200, updated: 0, skipped: 0 })
    expect(executedStatements.filter(text => text.includes('INSERT INTO cloud_usage_records'))).toHaveLength(1)
    executedStatements.length = 0
    await push([], Array.from({ length: 200 }, (_, i) => ({ record_id: `record-${i}`, updatedAt: 200 })))
    expect(executedStatements.filter(text => text.includes('UPDATE cloud_usage_records'))).toHaveLength(1)
    expect(await query(`SELECT COUNT(*)::INTEGER AS count FROM cloud_usage_records WHERE deleted_at IS NOT NULL`)).toEqual([{ count: 200 }])
  })

  it('preserves input-order counters, equal-version precedence and accepted nonempty titles for duplicate ids', async () => {
    const result = await push([record('duplicate', 100, { sessionTitle: 'First title' }), record('duplicate', 90, { sessionTitle: 'Stale title' }),
      record('duplicate', 200, { inputTokens: 20, sessionTitle: '' }), record('duplicate', 200, { inputTokens: 99, sessionTitle: 'Equal title' })])
    expect(result).toMatchObject({ inserted: 1, updated: 1, skipped: 2 })
    expect(await query(`SELECT updated_at, input_tokens, session_title FROM cloud_usage_records`)).toEqual([
      { updated_at: '200', input_tokens: '20', session_title: 'First title' },
    ])
    expect(await push([record('duplicate', 150, { sessionTitle: 'Too old' }), record('duplicate', 300)])).toMatchObject({ inserted: 0, updated: 1, skipped: 1 })
    expect(await query(`SELECT session_title FROM cloud_usage_records`)).toEqual([{ session_title: 'First title' }])
  })

  it('does not resurrect an equal-version tombstone and keeps zero cost and escaped text values', async () => {
    await push([record('escaped', 100, { cost: 0, model: 'review"\\,模型' })])
    await push([], [{ record_id: 'escaped', updatedAt: 150 }])
    expect(await push([record('escaped', 150)])).toMatchObject({ updated: 0, skipped: 1 })
    expect(await query(`SELECT COUNT(*)::INTEGER AS count FROM cloud_usage_records WHERE deleted_at IS NOT NULL`)).toEqual([{ count: 1 }])
    await push([record('escaped', 151, { cost: 0, model: 'review"\\,模型' })])
    expect(await query(`SELECT model, cost, deleted_at FROM cloud_usage_records`)).toEqual([{ model: 'review"\\,模型', cost: '0.00000000', deleted_at: null }])
  })

  it('syncs 200 prices/aliases without a per-model write loop and preserves manual rows', async () => {
    const data = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`review-model-${i}`, {
      mode: 'chat', litellm_provider: 'openai', input_cost_per_token: 0.000002, output_cost_per_token: 0.000008,
    }]))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data))))
    await query(`INSERT INTO model_prices (model_key, provider, input, output, origin, source) VALUES ('review-model-0', 'manual', 5, 9, 'user', 'manual')`)
    const result = await syncPricingFromLitellm('review-user')
    expect(result).toMatchObject({ added: 199, updated: 0, userPreserved: 1 })
    expect(executedStatements.filter(text => text.includes('INSERT INTO model_prices'))).toHaveLength(1)
    expect(executedStatements.filter(text => text.includes('INSERT INTO model_price_aliases') && text.includes('FROM UNNEST'))).toHaveLength(1)
    // Seven curated aliases are a fixed startup/sync compatibility pass, not per-model work.
    expect(executedStatements.filter(text => text.includes('INSERT INTO model_price_aliases')).length).toBeLessThanOrEqual(8)
    expect(await query(`SELECT input, origin FROM model_prices WHERE model_key = 'review-model-0'`)).toEqual([{ input: '5.00000000', origin: 'user' }])
  })

  it('counts only live cloud usage in pricing statistics', async () => {
    await query(`INSERT INTO model_prices (model_key, input, output) VALUES ('review-model', 2, 8)`)
    await push([record('live'), record('deleted')])
    await push([], [{ record_id: 'deleted', updatedAt: 200 }])
    const { entries } = await getPriceEntries('review-user')
    expect(entries.find(entry => entry.model_key === 'review-model')?.usage_count).toBe(1)
  })

  it('adds the nine target indexes in a new versioned migration', async () => {
    const indexes = await query<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`)
    for (const name of ['idx_cloud_usage_generation_seq', 'idx_cloud_usage_active_device', 'idx_cloud_usage_tombstone_retention',
      'idx_cloud_sync_batches_created', 'idx_sessions_user', 'idx_admin_audit_created_desc', 'idx_device_auth_expiry', 'idx_users_created_desc', 'idx_cloud_usage_active_model']) {
      expect(indexes.find(index => index.indexname === name)).toBeDefined()
    }
    expect(await query(`SELECT version FROM schema_migrations WHERE version = 22`)).toEqual([{ version: 22 }])
  })
})
