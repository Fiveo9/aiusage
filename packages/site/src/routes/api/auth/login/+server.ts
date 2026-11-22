import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { sql } from '$lib/server/db/pool.js'
import { verifyPassword, passwordInputError, DUMMY_PASSWORD_HASH } from '$lib/server/auth/password.js'
import { createSession, setSessionCookie } from '$lib/server/auth/session.js'
import { maybeGrantAdmin } from '$lib/server/oauth/providers.js'
import { readLimitedJson, AUTH_BODY_LIMIT } from '$lib/server/request-body.js'
import { consumeAuthRateLimit } from '$lib/server/auth/request-rate-limit.js'

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
  const body = await readLimitedJson(request, AUTH_BODY_LIMIT)
  const { login, password } = body

  if (typeof login !== 'string' || !login.trim() || login.length > 256 || !password) {
    return json({ error: 'missing_fields' }, { status: 400 })
  }
  const inputError = passwordInputError(password)
  if (inputError) return json({ error: inputError.code, params: inputError.params }, { status: 400 })
  const ipLimit = await consumeAuthRateLimit('password_login_ip', getClientAddress(), 20, 60)
  if (!ipLimit.allowed) return json({ error: 'rate_limit_ip' }, { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfter) } })
  const accountLimit = await consumeAuthRateLimit('password_login_account', login.trim().toLowerCase(), 10, 300)
  if (!accountLimit.allowed) return json({ error: 'rate_limit_account' }, { status: 429, headers: { 'Retry-After': String(accountLimit.retryAfter) } })

  // Find user by username or email
  const users = await sql`
    SELECT id, username, email, email_verified, display_name, avatar_url, role, status, password_hash, ban_reason
    FROM users
    WHERE (username = ${login.trim()} OR LOWER(email) = ${login.trim().toLowerCase()}) AND password_hash IS NOT NULL
  `
  const user = users[0] as { id: string; username: string; email: string; email_verified: boolean; display_name: string; avatar_url: string | null; role: string; status: string; password_hash: string; ban_reason: string | null } | undefined

  const passwordValid = await verifyPassword(password as string, user?.password_hash || DUMMY_PASSWORD_HASH)
  if (!user || !passwordValid) {
    return json({ error: 'invalid_credentials' }, { status: 401 })
  }

  if (!user.email_verified) {
    return json({ error: 'email_not_verified', message: 'Please verify your email before signing in' }, { status: 403 })
  }

  if (user.status === 'banned') {
    return json({ error: 'user_banned', message: 'Your account has been banned', ban_reason: user.ban_reason }, { status: 403 })
  }

  await maybeGrantAdmin(user.id, user.email, user.email_verified)

  // Re-fetch role in case it was just updated
  const updated = await sql`SELECT role FROM users WHERE id = ${user.id}`
  const role = (updated[0] as { role: string } | undefined)?.role ?? user.role

  const sid = await createSession(user.id)
  await setSessionCookie(cookies, sid)

  return json({
    success: true,
    user: { id: user.id, username: user.username, email: user.email, display_name: user.display_name, avatar_url: user.avatar_url, role }
  })
}
