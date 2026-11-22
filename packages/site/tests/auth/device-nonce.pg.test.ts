import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
vi.mock('../../src/lib/server/db/pool.js', async () => ({ sql: (await import('../helpers/pglite-sql.js')).sql }))
import { verifyDeviceRequest } from '../../src/lib/server/auth/device-request.js'
import { encryptDeviceSecret, sha256 } from '../../src/lib/server/crypto/hmac.js'
import { migrateTestDatabase, query, truncate } from '../helpers/pglite-sql.js'

beforeAll(() => migrateTestDatabase(), 15_000)
beforeEach(async () => {
  await truncate('users', 'upload_nonces')
  await query("INSERT INTO users (id, username, email, display_name) VALUES ('owner', 'owner', 'owner@example.test', 'Owner')")
  await query("INSERT INTO user_devices (id, user_id, name, secret_encrypted, secret_hash) VALUES ('device', 'owner', 'Synthetic', $1, $2)",
    [encryptDeviceSecret('fixture-only'), sha256('fixture-only')])
})
function request() {
  const timestamp = String(Date.now())
  const canonical = ['GET', '/api/cli/sync/pull', createHash('sha256').update('').digest('hex'), timestamp, 'nonce', 'device', 'batch'].join('\n')
  return new Request('https://service.invalid/api/cli/sync/pull', { headers: {
    'X-AIUsage-Device-Id': 'device', 'X-AIUsage-Timestamp': timestamp, 'X-AIUsage-Nonce': 'nonce',
    'X-AIUsage-Idempotency-Key': 'batch', 'X-AIUsage-Signature': `hmac-sha256=${createHmac('sha256', 'fixture-only').update(canonical).digest('hex')}`,
  } })
}

it('handles concurrent identical nonces as one success and one stable rejection', async () => {
  const input = request()
  const outcomes = await Promise.allSettled([verifyDeviceRequest(input, ''), verifyDeviceRequest(input, '')])
  expect(outcomes.every(outcome => outcome.status === 'fulfilled')).toBe(true)
  const values = outcomes.map(outcome => outcome.status === 'fulfilled' ? outcome.value : null)
  expect(values.filter(value => value?.valid)).toHaveLength(1)
  expect(values.filter(value => value?.error_code === 'nonce_reused')).toHaveLength(1)
  expect(await query('SELECT nonce FROM upload_nonces')).toEqual([{ nonce: 'nonce' }])
})
