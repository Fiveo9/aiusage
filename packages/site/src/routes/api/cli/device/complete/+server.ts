import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { sql } from '$lib/server/db/pool.js'
import { nanoid } from 'nanoid'
import { sha256, generateDeviceSecret, encryptDeviceSecret } from '$lib/server/crypto/hmac.js'
import { createHash } from 'node:crypto'
import { readLimitedJson, AUTH_BODY_LIMIT } from '$lib/server/request-body.js'

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export const POST: RequestHandler = async ({ request }) => {
  const body = await readLimitedJson(request, AUTH_BODY_LIMIT)
  const device_request_id = body?.device_request_id
  const device_verifier = body?.device_verifier
  if (typeof device_request_id !== 'string' || !device_request_id.trim() || device_request_id.length > 256
    || typeof device_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(device_verifier)) {
    return json({ error: 'Missing required fields' }, { status: 400 })
  }

  return sql.begin(async tx => {
    const requests = await tx`
      SELECT id, device_challenge, user_id, device_name, status FROM device_auth_requests
      WHERE id = ${device_request_id} FOR UPDATE
    `
    const req = requests[0] as { id: string; device_challenge: string; user_id: string | null; device_name: string; status: string } | undefined
    if (!req) return json({ error: 'Request not found', error_code: 'device_not_found' }, { status: 404 })
    if (req.status === 'completed' || req.status === 'declined') {
      return json({ error: 'Authorization has ended', error_code: `authorization_${req.status}` }, { status: 400 })
    }
    const expires = await tx`SELECT expires_at > clock_timestamp() AS valid FROM device_auth_requests WHERE id = ${device_request_id}`
    if (req.status === 'expired' || expires[0]?.valid !== true) {
      return json({ error: 'Authorization expired', error_code: 'authorization_expired' }, { status: 410 })
    }
    if (req.status === 'pending') return json({ error: 'Request not yet approved', pending: true, error_code: 'authorization_pending' }, { status: 202 })
    if (req.status !== 'approved' || !req.user_id) return json({ error: 'Invalid authorization state', error_code: 'invalid_authorization_state' }, { status: 400 })
    if (pkceChallenge(device_verifier) !== req.device_challenge) return json({ error: 'Invalid verifier' }, { status: 400 })
    const users = await tx`SELECT status FROM users WHERE id = ${req.user_id} FOR UPDATE`
    if (!users[0] || users[0].status !== 'active') return json({ error: 'User banned', error_code: 'user_banned' }, { status: 403 })
    const claimed = await tx`
      UPDATE device_auth_requests SET status = 'completed'
      WHERE id = ${device_request_id} AND status = 'approved' AND expires_at > clock_timestamp() RETURNING id
    `
    if (!claimed[0]) return json({ error: 'Authorization expired', error_code: 'authorization_expired' }, { status: 410 })
    const deviceId = nanoid()
    const deviceSecret = generateDeviceSecret()
    await tx`
      INSERT INTO user_devices (id, user_id, name, secret_encrypted, secret_hash, status)
      VALUES (${deviceId}, ${req.user_id}, ${req.device_name}, ${encryptDeviceSecret(deviceSecret)}, ${sha256(deviceSecret)}, 'active')
    `
    return json({ device_id: deviceId, device_secret: deviceSecret })
  })
}
