import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
vi.mock('../../src/lib/server/db/pool.js', async () => ({ sql: (await import('../helpers/pglite-sql.js')).sql }))
vi.mock('$env/dynamic/private', () => ({ env: {
  SITE_URL: 'https://service.invalid', IP_HASH_SECRET: 'synthetic-ip-value', DEVICE_SECRET_ENCRYPTION_KEY: 'a'.repeat(64),
} }))
import { POST as complete } from '../../src/routes/api/cli/device/complete/+server.js'
import { POST as approve } from '../../src/routes/api/cli/device/approve/+server.js'
import { POST as approveCode } from '../../src/routes/api/cli/device/approve-by-code/+server.js'
import { POST as start } from '../../src/routes/api/cli/device/start/+server.js'
import { migrateTestDatabase, query, truncate } from '../helpers/pglite-sql.js'

const verifier = 'synthetic-device-verifier-'.repeat(3)
const challenge = createHash('sha256').update(verifier).digest('base64url')
const owner = { id: 'owner', username: 'owner', email: 'owner@example.test', display_name: 'Owner', avatar_url: null, role: 'user', status: 'active' }
beforeAll(() => migrateTestDatabase(), 15_000)
beforeEach(async () => {
  await truncate('users', 'device_auth_requests')
  if ((await query<{ table: string | null }>("SELECT to_regclass('auth_rate_limits') AS table"))[0].table) await truncate('auth_rate_limits')
  await query("INSERT INTO users (id, username, email, display_name) VALUES ('owner', 'owner', 'owner@example.test', 'Owner'), ('other', 'other', 'other@example.test', 'Other')")
})
function event(body: unknown, user = owner) {
  const url = new URL('https://service.invalid/api/cli/device')
  return { url, request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    locals: { user }, getClientAddress: () => '127.0.0.1' } as any
}
async function application(id = 'request-1', status = 'approved', expired = false) {
  await query(`INSERT INTO device_auth_requests (id, device_challenge, user_code, verification_url, device_name, cli_version, user_id, status, expires_at)
    VALUES ($1, $2, 'ABCD-EFGH', 'https://service.invalid/cli/authorize', 'synthetic-device', '1.5.28', $3, $4, NOW() + $5::integer * INTERVAL '1 minute')`,
    [id, challenge, status === 'pending' ? null : 'owner', status, expired ? -1 : 10])
}
const completion = () => event({ device_request_id: 'request-1', device_verifier: verifier })

describe('atomic device authorization', () => {
  it('issues only one device for two concurrent completion requests', async () => {
    await application()
    const responses = await Promise.all([complete(completion()), complete(completion())]) as Response[]
    expect(responses.map(response => response.status).sort()).toEqual([200, 400])
    expect(await query('SELECT id FROM user_devices')).toHaveLength(1)
    expect(await query('SELECT status FROM device_auth_requests')).toEqual([{ status: 'completed' }])
  })

  it('rejects an expired approved application', async () => {
    await application('request-1', 'approved', true)
    expect((await complete(completion()) as Response).status).toBe(410)
    expect(await query('SELECT id FROM user_devices')).toEqual([])
  })

  it.each(['completed', 'declined'])('returns a terminal error instead of pending for %s', async status => {
    await application('request-1', status)
    const response = await complete(completion()) as Response
    expect(response.status).toBe(400)
    expect((await response.json()).error_code).toBe(`authorization_${status}`)
  })

  it('rejects malformed verifier fields without a server exception', async () => {
    await application()
    expect((await complete(event({ device_request_id: 'request-1', device_verifier: { invalid: true } })) as Response).status).toBe(400)
  })

  it('does not issue a device to a user banned after approval', async () => {
    await application()
    await query("UPDATE users SET status = 'banned' WHERE id = 'owner'")
    expect((await complete(completion()) as Response).status).toBe(403)
    expect(await query('SELECT id FROM user_devices')).toEqual([])
  })

  it.each([['id', approve], ['code', approveCode]] as const)('atomically approves one pending application by %s', async (kind, handler) => {
    await application('request-1', 'pending')
    const body = kind === 'id' ? { device_request_id: 'request-1' } : { user_code: 'ABCD-EFGH' }
    const responses = await Promise.all([handler(event(body)), handler(event(body, { ...owner, id: 'other' }))]) as Response[]
    expect(responses.map(response => response.status).sort()).toEqual([200, 404])
  })

  it('never approves multiple records when a legacy duplicate user code exists', async () => {
    await application('request-1', 'pending')
    await application('request-2', 'pending')
    expect((await approveCode(event({ user_code: 'ABCD-EFGH' })) as Response).status).toBe(200)
    expect(await query("SELECT id FROM device_auth_requests WHERE status = 'approved'")).toHaveLength(1)
  })

  it('does not let an expired legacy duplicate code hide the live application', async () => {
    await application('expired', 'pending', true)
    await application('live', 'pending')
    expect((await approveCode(event({ user_code: 'ABCD-EFGH' })) as Response).status).toBe(200)
    expect(await query("SELECT id FROM device_auth_requests WHERE status = 'approved'")).toEqual([{ id: 'live' }])
  })

  it('rolls back the claimed application when credential insertion fails', async () => {
    await application()
    await query(`CREATE FUNCTION reject_device_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic device insert failure'; END $$`)
    await query('CREATE TRIGGER reject_device_insert BEFORE INSERT ON user_devices FOR EACH ROW EXECUTE FUNCTION reject_device_insert()')
    try {
      await expect(complete(completion())).rejects.toThrow('synthetic device insert failure')
      expect(await query('SELECT status FROM device_auth_requests')).toEqual([{ status: 'approved' }])
      expect(await query('SELECT id FROM user_devices')).toEqual([])
    } finally {
      await query('DROP TRIGGER reject_device_insert ON user_devices')
      await query('DROP FUNCTION reject_device_insert()')
    }
  })

  it.each([{ device_name: 'x'.repeat(129) }, { cli_version: 'x'.repeat(257) }, { device_challenge: 'invalid' }])
    ('rejects invalid start fields', async override => {
      expect((await start(event({ device_name: 'synthetic-device', cli_version: '1.5.28', device_challenge: challenge, ...override })) as Response).status).toBe(400)
    })

  it('limits valid device start requests per IP', async () => {
    const body = { device_name: 'synthetic-device', cli_version: '1.5.28', device_challenge: challenge }
    for (let i = 0; i < 10; i++) expect((await start(event(body)) as Response).status).toBe(200)
    const response = await start(event(body)) as Response
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('enforces the same IP limit under concurrent starts', async () => {
    const body = { device_name: 'synthetic-device', cli_version: '1.5.28', device_challenge: challenge }
    const responses = await Promise.all(Array.from({ length: 12 }, () => start(event(body)))) as Response[]
    expect(responses.filter(response => response.status === 200)).toHaveLength(10)
    expect(responses.filter(response => response.status === 429)).toHaveLength(2)
  })
})
