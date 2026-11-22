import { sql } from '../db/pool.js'
import { hashIp } from '../crypto/hmac.js'

export async function consumeAuthRateLimit(scope: string, subject: string, maxAttempts: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfter: number }> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error('Invalid authentication rate limit')
  }
  const key = hashIp(`${scope}:${subject}`)
  const rows = await sql`
    INSERT INTO auth_rate_limits AS limits (scope, key_hash, window_start, attempts)
    VALUES (${scope}, ${key}, clock_timestamp(), 1)
    ON CONFLICT (scope, key_hash) DO UPDATE SET
      attempts = CASE WHEN limits.window_start <= EXCLUDED.window_start - ${windowSeconds} * INTERVAL '1 second'
        THEN 1 ELSE LEAST(limits.attempts + 1, ${maxAttempts + 1}) END,
      window_start = CASE WHEN limits.window_start <= EXCLUDED.window_start - ${windowSeconds} * INTERVAL '1 second'
        THEN EXCLUDED.window_start ELSE limits.window_start END
    RETURNING attempts, EXTRACT(EPOCH FROM (window_start + ${windowSeconds} * INTERVAL '1 second' - clock_timestamp())) AS retry_after
  `
  const attempts = Number(rows[0]?.attempts)
  if (!Number.isFinite(attempts)) throw new Error('Authentication rate limit was not persisted')
  return { allowed: attempts <= maxAttempts, retryAfter: Math.max(1, Math.ceil(Number(rows[0].retry_after) || 1)) }
}
