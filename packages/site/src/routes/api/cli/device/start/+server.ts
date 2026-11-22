import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { sql } from '$lib/server/db/pool.js'
import { nanoid } from 'nanoid'
import { sha256, generateUserCode } from '$lib/server/crypto/hmac.js'
import { env } from '$env/dynamic/private'
import { getConfigValue, CFG } from '$lib/server/config.js'
import { consumeAuthRateLimit } from '$lib/server/auth/request-rate-limit.js'

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  const limit = await consumeAuthRateLimit('device_auth_start', getClientAddress(), 10, 60)
  if (!limit.allowed) return json({ error: 'Too many device authorization requests', error_code: 'rate_limit_ip' }, {
    status: 429, headers: { 'Retry-After': String(limit.retryAfter) },
  })
  const body = await request.json().catch(() => null)
  const device_name = body?.device_name
  const cli_version = body?.cli_version
  const device_challenge = body?.device_challenge
  if (typeof device_name !== 'string' || !device_name.trim() || device_name.length > 128
    || typeof cli_version !== 'string' || !cli_version.trim() || cli_version.length > 256
    || typeof device_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(device_challenge)) {
    return json({ error: 'Missing required fields' }, { status: 400 })
  }

  const authExpiryMinutes = await getConfigValue(CFG.DEVICE_AUTH_EXPIRY_MINUTES)
  const pollInterval = await getConfigValue(CFG.DEVICE_AUTH_POLL_INTERVAL_SECONDS)
  const id = nanoid()
  const userCode = generateUserCode()
  const siteUrl = env.SITE_URL || 'http://localhost:5173'
  const verificationUrl = `${siteUrl}/cli/authorize?code=${userCode}`
  const expiresAt = new Date(Date.now() + authExpiryMinutes * 60 * 1000)

  await sql`
    INSERT INTO device_auth_requests (id, device_challenge, user_code, verification_url, device_name, cli_version, status, expires_at)
    VALUES (${id}, ${device_challenge}, ${userCode}, ${verificationUrl}, ${device_name.trim()}, ${cli_version.trim()}, 'pending', ${expiresAt})
  `

  return json({
    device_request_id: id,
    user_code: userCode,
    verification_url: verificationUrl,
    expires_at: expiresAt.toISOString(),
    interval: pollInterval
  })
}
