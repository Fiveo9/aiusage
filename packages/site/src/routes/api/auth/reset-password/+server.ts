import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { sql } from '$lib/server/db/pool.js'
import { hashPassword, validatePassword } from '$lib/server/auth/password.js'
import { consumePasswordResetToken } from '$lib/server/auth/email-verification.js'
import { readLimitedJson, AUTH_BODY_LIMIT } from '$lib/server/request-body.js'

export const POST: RequestHandler = async ({ request }) => {
  const body = await readLimitedJson(request, AUTH_BODY_LIMIT)
  const { token, password } = body

  if (typeof token !== 'string' || !token || typeof password !== 'string' || !password) {
    return json({ error: 'missing_fields' }, { status: 400 })
  }

  const passwordError = await validatePassword(password)
  if (passwordError) {
    return json({ error: passwordError.code, params: passwordError.params }, { status: 400 })
  }

  const result = await consumePasswordResetToken(token)
  if (!result) {
    return json({ error: 'invalid_reset_token' }, { status: 400 })
  }

  const passwordHash = await hashPassword(password)
  await sql`UPDATE users SET password_hash = ${passwordHash}, updated_at = NOW() WHERE id = ${result.userId}`

  // Invalidate all existing sessions so the user must log in with the new password
  await sql`DELETE FROM sessions WHERE user_id = ${result.userId}`

  return json({ success: true })
}
