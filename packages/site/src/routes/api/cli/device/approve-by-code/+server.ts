import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { sql } from '$lib/server/db/pool.js'
import { requireUser } from '$lib/server/auth/session.js'
import { readLimitedJson, AUTH_BODY_LIMIT } from '$lib/server/request-body.js'

export const POST: RequestHandler = async (event) => {
  const user = await requireUser(event)
  const body = await readLimitedJson(event.request, AUTH_BODY_LIMIT)
  const user_code = typeof body?.user_code === 'string' ? body.user_code.trim().toUpperCase() : ''
  if (!/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(user_code)) {
    return json({ error: 'Missing user_code' }, { status: 400 })
  }

  return sql.begin(async tx => {
    const candidates = await tx`
      SELECT id FROM device_auth_requests WHERE user_code = ${user_code} AND status = 'pending' AND expires_at > clock_timestamp()
      ORDER BY created_at, id LIMIT 1 FOR UPDATE
    `
    if (!candidates[0]) return json({ error: 'Invalid or expired code' }, { status: 404 })
    const rows = await tx`
      UPDATE device_auth_requests SET user_id = ${user.id}, status = 'approved', approved_at = clock_timestamp()
      WHERE id = ${candidates[0].id} AND status = 'pending' AND expires_at > clock_timestamp() RETURNING id
    `
    if (!rows[0]) return json({ error: 'Invalid or expired code' }, { status: 404 })
    return json({ success: true })
  })
}
