import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
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

  const result = await consumePasswordResetToken(token, () => hashPassword(password))
  if (!result) {
    return json({ error: 'invalid_reset_token' }, { status: 400 })
  }

  return json({ success: true })
}
