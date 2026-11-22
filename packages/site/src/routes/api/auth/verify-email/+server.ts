import { json, type RequestHandler } from '@sveltejs/kit'
import { consumeEmailVerificationToken } from '$lib/server/auth/email-verification.js'
import { maybeGrantAdmin } from '$lib/server/oauth/providers.js'
import { readLimitedJson, AUTH_BODY_LIMIT } from '$lib/server/request-body.js'

export const POST: RequestHandler = async ({ request }) => {
  const body = await readLimitedJson(request, AUTH_BODY_LIMIT)
  if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{48}$/.test(body.token)) return json({ error: 'invalid' }, { status: 400 })
  const result = await consumeEmailVerificationToken(body.token)
  if (!result) return json({ error: 'invalid' }, { status: 400 })
  await maybeGrantAdmin(result.userId, result.email, true)
  return json({ success: true })
}
