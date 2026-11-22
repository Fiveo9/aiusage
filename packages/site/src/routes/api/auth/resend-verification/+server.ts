import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { sql } from '$lib/server/db/pool.js'
import {
  checkVerificationEmailRateLimit,
  createEmailVerification,
  sendVerificationEmail
} from '$lib/server/auth/email-verification.js'
import { readLimitedJson, AUTH_BODY_LIMIT } from '$lib/server/request-body.js'

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  const body = await readLimitedJson(request, AUTH_BODY_LIMIT)
  const email = String(body.email || '').trim().toLowerCase()

  if (!email) {
    return json({ error: 'email_required' }, { status: 400 })
  }

  const ip = getClientAddress()
  const rateLimitError = await checkVerificationEmailRateLimit(ip, email)
  if (rateLimitError) {
    return json({ error: rateLimitError.code }, { status: 429 })
  }

  const users = await sql`
    SELECT id, username, email_verified
    FROM users
    WHERE LOWER(email) = ${email}
  `
  const user = users[0] as { id: string; username: string; email_verified: boolean } | undefined

  if (!user) {
    return json({ success: true, message: 'If an account exists, a verification email has been sent' })
  }

  if (user.email_verified) {
    return json({ success: true, message: 'If an account exists, a verification email has been sent' })
  }

  try {
    const verificationUrl = await createEmailVerification(user.id, email)
    await sendVerificationEmail(email, user.username, verificationUrl)
  } catch (err) {
    console.error('Failed to resend verification email')
  }

  return json({ success: true, message: 'If an account exists, a verification email has been sent' })
}
