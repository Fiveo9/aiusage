import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
const faults = vi.hoisted(() => ({ insert: false, pauseBegin: false, reached: null as (() => void) | null, resume: null as Promise<void> | null }))
vi.mock('../../src/lib/server/db/pool.js', async () => {
  const { sql } = await import('../helpers/pglite-sql.js')
  function wrap(tag: any): any {
    const wrapped = (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (faults.insert && strings.join('').includes('INSERT INTO cloud_usage_records')) throw new Error('synthetic insert failure')
      return tag(strings, ...values)
    }
    return Object.assign(wrapped, { begin: async (fn: (tx: any) => Promise<unknown>) => {
      if (faults.pauseBegin) { faults.pauseBegin = false; faults.reached?.(); await faults.resume }
      return tag.begin((tx: any) => fn(wrap(tx)))
    } })
  }
  return { sql: wrap(sql) }
})
vi.mock('../../src/lib/server/auth/device-request.js', () => ({ verifyDeviceRequest: async (request: Request) => ({
  valid: true, userId: 'owner', deviceId: request.headers.get('x-test-device') || 'device-one', idempotencyKey: request.headers.get('x-test-key') || request.url,
}) }))
vi.mock('../../src/lib/server/cloud/star-check.js', () => ({ checkCloudSyncAccess: async () => ({ allowed: true }) }))
import { POST as pushRoute } from '../../src/routes/api/cli/sync/push/+server.js'
import { GET as pullRoute } from '../../src/routes/api/cli/sync/pull/+server.js'
import { POST as clearRoute } from '../../src/routes/api/cli/sync/clear/+server.js'
import { POST as browserClear } from '../../src/routes/api/me/cloud-sync/clear/+server.js'
import { DELETE as revoke } from '../../src/routes/api/me/devices/[id]/+server.js'
import { migrateTestDatabase, query, truncate } from '../helpers/pglite-sql.js'
const user = { id: 'owner', username: 'owner', email: 'owner@example.test', display_name: 'Owner', role: 'user', status: 'active', avatar_url: null }
let serial = 0
function record(updatedAt = 100) { return { id: 'one', ts: 1000, tool: 'claude-code', model: 'synthetic-model', inputTokens: 1, outputTokens: 1, updatedAt } }
async function push(records: unknown[] = [], options: { key?: string; instance?: string; device?: string; generation?: number; tombstones?: unknown[] } = {}) {
  const request = new Request('https://service.invalid/api/cli/sync/push', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-key': options.key || `batch-${++serial}`, 'x-test-device': options.device || 'device-one' },
    body: JSON.stringify({ schema_version: 1, device_instance_id: options.instance || 'instance-one', sync_generation: options.generation ?? 1, records, tombstones: options.tombstones || [] }) })
  return await pushRoute({ request } as any) as Response
}
async function pull(params = '') {
  const url = new URL(`https://service.invalid/api/cli/sync/pull${params}`)
  return await pullRoute({ url, request: new Request(url) } as any) as Response
}
async function clear() { return await clearRoute({ request: new Request('https://service.invalid/api/cli/sync/clear', { method: 'POST', body: '{}' }) } as any) as Response }
beforeAll(() => migrateTestDatabase(), 15_000)
beforeEach(async () => {
  faults.insert = false; faults.pauseBegin = false; faults.reached = null; faults.resume = null; serial = 0
  await truncate('users')
  await query("INSERT INTO users (id,username,email,display_name) VALUES ('owner','owner','owner@example.test','Owner')")
  await query("INSERT INTO user_devices (id,user_id,name,secret_encrypted,secret_hash) VALUES ('device-one','owner','same','synthetic','synthetic'),('device-two','owner','same','synthetic','synthetic')")
})
describe('cloud synchronization consistency', () => {
  it('advances change_seq for updates and tombstones', async () => {
    await push([record()])
    const first = BigInt((await query('SELECT change_seq FROM cloud_usage_records'))[0].change_seq as string)
    await push([record(200)])
    const second = BigInt((await query('SELECT change_seq FROM cloud_usage_records'))[0].change_seq as string)
    await push([], { tombstones: [{ record_id: 'one', updatedAt: 300 }] })
    const third = BigInt((await query('SELECT change_seq FROM cloud_usage_records'))[0].change_seq as string)
    expect(second).toBeGreaterThan(first); expect(third).toBeGreaterThan(second)
  })
  it('does not apply an older tombstone to a newer live record', async () => {
    await push([record(300)])
    await push([], { tombstones: [{ record_id: 'one', updatedAt: 200 }] })
    expect((await query('SELECT updated_at,deleted_at FROM cloud_usage_records'))[0]).toEqual({ updated_at: '300', deleted_at: null })
  })
  it('preserves a valid zero updatedAt instead of replacing it with now', async () => {
    await push([record(0)])
    expect((await query('SELECT updated_at FROM cloud_usage_records'))[0].updated_at).toBe('0')
  })
  it('returns the complete accepted receipt on replay, including rejected records', async () => {
    const records = [record(), { ...record(), id: 'invalid', model: '' }]
    const first = await (await push(records, { key: 'same-key' })).json()
    const replay = await (await push(records, { key: 'same-key' })).json()
    expect(replay).toEqual(first)
    expect(replay).toHaveProperty('sync_generation', 1)
    expect(replay).toHaveProperty('server_cursor')
    expect(replay.rejected).toEqual([{ id: 'invalid', reason: 'missing_field' }])
  })
  it('stores and replays rejected NUL identifiers without failing valid records', async () => {
    const records = [record(), { ...record(), id: 'bad\u0000id' }]
    const options = { key: 'nul-key', tombstones: [{ record_id: 'bad\u0000id', updatedAt: 100 }] }
    const response = await push(records, options)
    expect(response.status).toBe(200)
    const first = await response.json()
    expect(first.rejected[0].id).toBe('bad\u0000id')
    expect(first.rejected_tombstones[0].record_id).toBe('bad\u0000id')
    expect(await (await push(records, options)).json()).toEqual(first)
    expect(typeof (await query('SELECT response_summary FROM cloud_sync_batches'))[0].response_summary).toBe('string')
  })
  it('does not invent an acknowledgement for an old accepted receipt without a summary', async () => {
    await query("INSERT INTO cloud_sync_batches (id,user_id,device_id,idempotency_key,direction,record_count,status) VALUES ('legacy','owner','device-one','legacy-key','push',1,'accepted')")
    expect((await push([record()], { key: 'legacy-key' })).status).toBe(500)
    expect(await query('SELECT id FROM cloud_usage_records')).toHaveLength(0)
  })
  it('never acknowledges a failed batch before its records are stored', async () => {
    faults.insert = true
    expect((await push([record()], { key: 'failed-key' })).status).toBe(500)
    faults.insert = false
    const response = await push([record()], { key: 'failed-key' })
    if (response.status === 200) expect(await query('SELECT id FROM cloud_usage_records')).toHaveLength(1)
    else expect(response.status).toBe(500)
  })
  it('serializes two clears so both generations are advanced', async () => {
    const replies = await Promise.all([clear(), clear()])
    expect((await Promise.all(replies.map(reply => reply.json()))).map(reply => reply.sync_generation).sort()).toEqual([2, 3])
  })
  it('uses the same generation lock for browser and CLI clear', async () => {
    const responses = await Promise.all([clear(), browserClear({ locals: { user } } as any) as Promise<Response>])
    expect((await Promise.all(responses.map(response => response.json()))).map(body => body.sync_generation).sort()).toEqual([2, 3])
  })
  it('scopes push and clear cursors to the current generation', async () => {
    await push([record()])
    await clear()
    expect((await (await push([], { generation: 2 })).json()).server_cursor).toBe('0')
    expect(String((await (await clear()).json()).clear_before_change_seq)).toBe('0')
  })
  it('rejects a push whose transaction starts after a clear', async () => {
    let ready!: () => void, resume!: () => void
    const reached = new Promise<void>(r => { ready = r })
    faults.resume = new Promise<void>(r => { resume = r }); faults.reached = ready; faults.pauseBegin = true
    const pending = push([record()])
    await reached
    expect((await clear()).status).toBe(200)
    resume()
    expect((await pending).status).toBe(409)
    expect(await query('SELECT id FROM cloud_usage_records WHERE deleted_at IS NULL')).toHaveLength(0)
  })
  it('updates the one binding when a credential rebuilds its local database', async () => {
    await push([record()])
    expect((await push([record()], { instance: 'instance-rebuilt' })).status).toBe(200)
    expect(await query('SELECT device_instance_id FROM cloud_device_instances')).toEqual([{ device_instance_id: 'instance-rebuilt' }])
  })
  it('continues the same database after the user reauthorizes a device', async () => {
    await push([record()])
    expect((await push([record()], { device: 'device-two' })).status).toBe(200)
    expect(await query('SELECT device_id FROM cloud_device_instances')).toEqual([{ device_id: 'device-two' }])
    expect(await query('SELECT id FROM cloud_usage_records')).toHaveLength(1)
  })
  it('returns a conflict without merging two already-bound independent instances', async () => {
    await push([record()])
    await push([record()], { device: 'device-two', instance: 'instance-two' })
    expect((await push([record()], { instance: 'instance-two' })).status).toBe(409)
    expect(await query('SELECT device_instance_id FROM cloud_device_instances ORDER BY device_id')).toEqual([{ device_instance_id: 'instance-one' }, { device_instance_id: 'instance-two' }])
  })
  it('preserves an exact BigInt cursor beyond the JS safe integer range', async () => {
    await push([record()])
    await query('UPDATE cloud_usage_records SET change_seq=9007199254740993')
    expect((await (await pull('?cursor=9007199254740993')).json()).records).toHaveLength(0)
  })
  it.each(['-1', '1junk', '1.5', '1e3', '9223372036854775808'])('rejects invalid cursor %s', async cursor => {
    expect((await pull(`?cursor=${cursor}`)).status).toBe(400)
  })
  it.each(['NaN', '1junk', '1.5'])('rejects invalid pull limit %s', async limit => {
    expect((await pull(`?limit=${limit}`)).status).toBe(400)
  })
  it('keeps the last observed cursor on the final page and an empty final pull', async () => {
    await push([record()])
    const cursor = String((await query('SELECT change_seq FROM cloud_usage_records'))[0].change_seq)
    expect((await (await pull()).json()).next_cursor).toBeNull()
    expect((await query('SELECT last_server_cursor FROM cloud_sync_state'))[0].last_server_cursor).toBe(cursor)
    await pull(`?cursor=${cursor}`)
    expect((await query('SELECT last_server_cursor FROM cloud_sync_state'))[0].last_server_cursor).toBe(cursor)
  })
  it('advances change_seq when device data is explicitly revoked', async () => {
    await push([record()])
    const before = BigInt((await query('SELECT change_seq FROM cloud_usage_records'))[0].change_seq as string)
    const url = new URL('https://service.invalid/api/me/devices/device-one?delete_data=true')
    expect((await revoke({ url, params: { id: 'device-one' }, locals: { user } } as any) as Response).status).toBe(200)
    expect(BigInt((await query('SELECT change_seq FROM cloud_usage_records'))[0].change_seq as string)).toBeGreaterThan(before)
  })
  it('still permits explicit device revocation when the cloud generation is out of range', async () => {
    await query("INSERT INTO cloud_sync_resets (user_id,sync_generation) VALUES ('owner',9007199254740993)")
    const url = new URL('https://service.invalid/api/me/devices/device-one')
    expect((await revoke({ url, params: { id: 'device-one' }, locals: { user } } as any) as Response).status).toBe(200)
    expect((await query("SELECT status FROM user_devices WHERE id='device-one'"))[0].status).toBe('revoked')
  })
  it('does not let an in-flight push resurrect data after device revocation', async () => {
    let ready!: () => void, resume!: () => void
    const reached = new Promise<void>(r => { ready = r })
    faults.resume = new Promise<void>(r => { resume = r }); faults.reached = ready; faults.pauseBegin = true
    const pending = push([record()])
    await reached
    const url = new URL('https://service.invalid/api/me/devices/device-one?delete_data=true')
    try { expect((await revoke({ url, params: { id: 'device-one' }, locals: { user } } as any) as Response).status).toBe(200) }
    finally { resume() }
    expect((await pending).status).toBe(401)
    expect(await query('SELECT id FROM cloud_usage_records WHERE deleted_at IS NULL')).toHaveLength(0)
  })
})
