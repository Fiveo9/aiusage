import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireUser } from '$lib/server/auth/session.js'
import { sql } from '$lib/server/db/pool.js'

export const DELETE: RequestHandler = async (event) => {
  const user = await requireUser(event)
  const { provider } = event.params
  if (!['github', 'linux_do'].includes(provider)) {
    return json({ error: 'Invalid provider' }, { status: 400 })
  }

  return sql.begin(async tx => {
    const rows = await tx`SELECT password_hash, email_verified, status FROM users WHERE id = ${user.id} FOR UPDATE`
    const account = rows[0] as { password_hash: string | null; email_verified: boolean; status: string } | undefined
    if (!account) return json({ error: 'Not authenticated' }, { status: 401 })
    if (account.status === 'banned') throw error(403, 'user_banned')
    const otherIdentities = await tx`SELECT provider FROM user_identities WHERE user_id = ${user.id} AND provider != ${provider}`
    const hasPasswordLogin = Boolean(account.password_hash) && account.email_verified === true
    if (!hasPasswordLogin && otherIdentities.length === 0) {
      return json({ error: 'cannot_unlink_last' }, { status: 400 })
    }
    const deleted = await tx`
      DELETE FROM user_identities WHERE user_id = ${user.id} AND provider = ${provider} RETURNING provider
    `
    if (deleted.length === 0) return json({ error: 'Identity not found' }, { status: 404 })
    return json({ ok: true, provider })
  })
}
