import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, createHmac } from 'node:crypto'

const db = vi.hoisted(() => ({
  revoked: false,
  banned: false,
  absent: false,
  replay: false,
  sql: vi.fn(),
}))
vi.mock('$lib/server/db/pool.js', () => ({ sql: db.sql }))
vi.mock('$lib/server/config.js', () => ({
  CFG: { UPLOAD_TIMESTAMP_WINDOW_MS: 'upload.timestamp_window_ms' },
  getConfigValue: async () => 300000,
}))
vi.mock('$lib/server/crypto/hmac.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/lib/server/crypto/hmac.js')>(),
  decryptDeviceSecret: () => 'fixture-only',
}))

import { verifyDeviceRequest } from '../../src/lib/server/auth/device-request.js'

beforeEach(() => {
  db.revoked = false
  db.banned = false
  db.absent = false
  db.replay = false
  db.sql.mockReset().mockImplementation(async (strings: TemplateStringsArray) => {
    const query = strings.join('?')
    if (query.includes('FROM user_devices')) return db.absent ? [] : [{
      id: 'device', user_id: 'user', secret_encrypted: 'fixture',
      status: db.revoked ? 'revoked' : 'active', user_status: db.banned ? 'banned' : 'active',
    }]
    if (query.includes('INSERT INTO upload_nonces')) return db.replay ? [] : [{ nonce: 'nonce' }]
    return []
  })
})

function signedRequest(path: string, method: string, body: string, timestamp = Date.now()) {
  const digest = createHash('sha256').update(body).digest('hex')
  const canonical = [method, path, digest, String(timestamp), 'nonce', 'device', 'idempotency'].join('\n')
  const signature = createHmac('sha256', 'fixture-only').update(canonical).digest('hex')
  return new Request(`https://sync.test${path}`, {
    method,
    headers: {
      'X-AIUsage-Device-Id': 'device',
      'X-AIUsage-Timestamp': String(timestamp),
      'X-AIUsage-Nonce': 'nonce',
      'X-AIUsage-Idempotency-Key': 'idempotency',
      'X-AIUsage-Signature': `hmac-sha256=${signature}`,
    },
  })
}

describe('shared cloud-sync device authentication', () => {
  it.each([
    ['/api/cli/sync/push', 'POST', '{}'],
    ['/api/cli/sync/pull', 'GET', ''],
    ['/api/cli/sync/clear', 'POST', '{}'],
  ])('accepts signed requests to %s', async (path, method, body) => {
    await expect(verifyDeviceRequest(signedRequest(path, method, body), body)).resolves.toEqual({
      valid: true, deviceId: 'device', userId: 'user', idempotencyKey: 'idempotency',
    })
    expect(db.sql.mock.calls.some(([strings]) => strings.join('?').includes('INSERT INTO upload_nonces'))).toBe(true)
  })

  it('rejects a tampered request body', async () => {
    const request = signedRequest('/api/cli/sync/push', 'POST', '{}')
    await expect(verifyDeviceRequest(request, '{"modified":true}')).resolves.toHaveProperty('error_code', 'invalid_signature')
    expect(db.sql.mock.calls.some(([strings]) => strings.join('?').includes('INSERT'))).toBe(false)
  })

  it('rejects expired signatures', async () => {
    const request = signedRequest('/api/cli/sync/push', 'POST', '{}', Date.now() - 600000)
    await expect(verifyDeviceRequest(request, '{}')).resolves.toHaveProperty('error_code', 'timestamp_expired')
  })

  it('rejects revoked devices', async () => {
    db.revoked = true
    await expect(verifyDeviceRequest(signedRequest('/api/cli/sync/pull', 'GET', ''), '')).resolves.toHaveProperty('error_code', 'device_revoked')
  })

  it('rejects a reused nonce', async () => {
    db.replay = true
    await expect(verifyDeviceRequest(signedRequest('/api/cli/sync/pull', 'GET', ''), '')).resolves.toHaveProperty('error_code', 'nonce_reused')
  })

  it('rejects an equal-character-length multibyte signature without throwing', async () => {
    const request = signedRequest('/api/cli/sync/pull', 'GET', '')
    request.headers.set('X-AIUsage-Signature', 'é'.repeat(76))
    await expect(verifyDeviceRequest(request, '')).resolves.toMatchObject({ valid: false, error_code: 'invalid_signature' })
  })

  it.each(['revoked', 'banned', 'absent'] as const)('does not reveal %s device state before signature verification', async state => {
    db[state] = true
    const request = signedRequest('/api/cli/sync/pull', 'GET', '')
    request.headers.set('X-AIUsage-Signature', 'invalid')
    await expect(verifyDeviceRequest(request, '')).resolves.toMatchObject({ valid: false, error_code: 'invalid_signature' })
  })
})
