import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { sql } from '$lib/server/db/pool.js'
import { hashPassword, validateUsername, validateEmail, validatePassword } from '$lib/server/auth/password.js'
import {
  checkVerificationEmailRateLimit,
  createEmailVerificationWithPolling,
  sendVerificationEmail
} from '$lib/server/auth/email-verification.js'
import { nanoid } from 'nanoid'
import { readLimitedJson, AUTH_BODY_LIMIT } from '$lib/server/request-body.js'

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  const body = await readLimitedJson(request, AUTH_BODY_LIMIT)
  const username = String(body.username || '').trim()
  const email = String(body.email || '').trim().toLowerCase()
  const password = body.password

  const usernameError = await validateUsername(username)
  if (usernameError) return json({ error: usernameError.code, params: usernameError.params }, { status: 400 })

  const emailError = validateEmail(email)
  if (emailError) return json({ error: emailError.code, params: emailError.params }, { status: 400 })

  const passwordError = await validatePassword(password)
  if (passwordError) return json({ error: passwordError.code, params: passwordError.params }, { status: 400 })

  const ip = getClientAddress()
  const rateLimitError = await checkVerificationEmailRateLimit(ip, email)
  if (rateLimitError) return json({ error: rateLimitError.code }, { status: 429 })

  // Check uniqueness
  const existingUser = await sql`SELECT id FROM users WHERE username = ${username} OR LOWER(email) = ${email}`
  if (existingUser[0]) {
    return json({ error: 'username_taken' }, { status: 409 })
  }

  const userId = nanoid()
  const passwordHash = await hashPassword(password as string)

  try {
  const conflict = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`username:${username}`}))`
    const reserved = await tx`SELECT username FROM reserved_usernames WHERE username = ${username} AND reserved_until > clock_timestamp()`
    if (reserved.length) return true
    await tx`
      INSERT INTO users (id, username, email, email_verified, display_name, password_hash, role, status)
      VALUES (${userId}, ${username}, ${email}, FALSE, ${username}, ${passwordHash}, 'user', 'active')
    `
    return false
  })
  if (conflict) return json({ error: 'username_reserved' }, { status: 409 })
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return json({ error: 'username_taken' }, { status: 409 })
    throw err
  }

  const verification = await createEmailVerificationWithPolling(userId, email)
  try {
    await sendVerificationEmail(email, username, verification.url)
  } catch (err) {
    console.error('Failed to send verification email')
    return json({ error: 'email_delivery_failed', requires_email_verification: true, poll_token: verification.pollToken }, { status: 500 })
  }

  return json({
    success: true,
    requires_email_verification: true,
    poll_token: verification.pollToken,
    message: 'Check your email to verify your account'
  })
}
