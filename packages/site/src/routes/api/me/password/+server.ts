import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { sql } from '$lib/server/db/pool.js'
import { hashPassword, verifyPassword, validatePassword } from '$lib/server/auth/password.js'
import { requireUser, getSessionCookie } from '$lib/server/auth/session.js'
import { readLimitedJson, AUTH_BODY_LIMIT } from '$lib/server/request-body.js'

export const PUT: RequestHandler = async (event) => {
  const user = await requireUser(event)
  const body = await readLimitedJson(event.request, AUTH_BODY_LIMIT)
  const { current_password, new_password } = body

  const passwordError = await validatePassword(new_password)
  if (passwordError) return json({ error: passwordError.code, params: passwordError.params }, { status: 400 })

  const newHash = await hashPassword(new_password as string)
  return sql.begin(async (tx) => {
  const rows = await tx`SELECT password_hash, status FROM users WHERE id = ${user.id} FOR UPDATE`
  if (!rows.length || rows[0].status !== 'active') return json({ error: 'unauthorized' }, { status: 403 })
  const existing = rows[0] as { password_hash: string | null } | undefined
  const hasExistingPassword = existing?.password_hash != null

  if (hasExistingPassword) {
    if (typeof current_password !== 'string' || !current_password) {
      return json({ error: 'current_password_required' }, { status: 400 })
    }
    const valid = await verifyPassword(current_password, existing!.password_hash!)
    if (!valid) {
      return json({ error: 'current_password_incorrect' }, { status: 403 })
    }
  }

  await tx`UPDATE users SET password_hash = ${newHash}, updated_at = NOW() WHERE id = ${user.id}`
  const sid = getSessionCookie(event) || ''
  await tx`DELETE FROM sessions WHERE user_id = ${user.id} AND sid != ${sid}`

  return json({ success: true })
  })
}
