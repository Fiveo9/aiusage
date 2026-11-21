import { sql } from '../db/pool.js'
import { decryptDeviceSecret, sha256, buildCanonicalString } from '../crypto/hmac.js'
import { getConfigValue, CFG } from '../config.js'
import { createHmac, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto'

export async function verifyDeviceRequest(
  request: Request,
  bodyText: string
): Promise<{ valid: boolean; deviceId?: string; userId?: string; idempotencyKey?: string; error?: string; error_code?: string }> {
  const deviceId = request.headers.get('X-AIUsage-Device-Id')
  const timestamp = request.headers.get('X-AIUsage-Timestamp')
  const nonce = request.headers.get('X-AIUsage-Nonce')
  const idempotencyKey = request.headers.get('X-AIUsage-Idempotency-Key')
  const signature = request.headers.get('X-AIUsage-Signature')

  if (!deviceId || !timestamp || !nonce || !idempotencyKey || !signature) {
    return { valid: false, error: 'Missing required headers', error_code: 'invalid_signature' }
  }

  const devices = await sql`
    SELECT d.id, d.user_id, d.secret_encrypted, d.status, u.status as user_status
    FROM user_devices d
    JOIN users u ON u.id = d.user_id
    WHERE d.id = ${deviceId}
  `
  const device = devices[0] as { id: string; user_id: string; secret_encrypted: string; status: string; user_status: string } | undefined

  if (!device) return { valid: false, error: 'Device not found', error_code: 'device_not_found' }
  if (device.status === 'revoked') return { valid: false, error: 'Device revoked', error_code: 'device_revoked' }
  if (device.user_status === 'banned') return { valid: false, error: 'User banned', error_code: 'user_banned' }

  const timestampWindowMs = await getConfigValue(CFG.UPLOAD_TIMESTAMP_WINDOW_MS)
  const ts = parseInt(timestamp, 10)
  if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > timestampWindowMs) {
    return { valid: false, error: 'Timestamp expired', error_code: 'timestamp_expired' }
  }

  const existingNonce = await sql`SELECT nonce FROM upload_nonces WHERE device_id = ${deviceId} AND nonce = ${nonce}`
  if (existingNonce[0]) return { valid: false, error: 'Nonce reused', error_code: 'nonce_reused' }

  let deviceSecret: string
  try {
    deviceSecret = decryptDeviceSecret(device.secret_encrypted)
  } catch {
    return { valid: false, error: 'Failed to decrypt device secret', error_code: 'invalid_signature' }
  }

  const bodyHash = sha256(bodyText)
  const path = new URL(request.url).pathname
  const canonical = buildCanonicalString(request.method, path, bodyHash, timestamp, nonce, deviceId, idempotencyKey)
  const expectedSig = `hmac-sha256=${computeHmacForVerify(canonical, deviceSecret)}`
  if (!timingSafeEqual(expectedSig, signature)) {
    return { valid: false, error: 'Invalid signature', error_code: 'invalid_signature' }
  }

  await sql`INSERT INTO upload_nonces (device_id, nonce) VALUES (${deviceId}, ${nonce})`
  await sql`UPDATE user_devices SET last_used_at = NOW() WHERE id = ${deviceId}`

  return { valid: true, deviceId, userId: device.user_id, idempotencyKey }
}

function computeHmacForVerify(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('hex')
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return cryptoTimingSafeEqual(Buffer.from(a), Buffer.from(b))
}

