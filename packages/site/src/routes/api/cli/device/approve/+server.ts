import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { sql } from '$lib/server/db/pool.js'
import { requireUser } from '$lib/server/auth/session.js'
import { readLimitedJson, AUTH_BODY_LIMIT } from '$lib/server/request-body.js'

export const POST: RequestHandler = async (event) => {
  const user = await requireUser(event)
  const body = await readLimitedJson(event.request, AUTH_BODY_LIMIT)
  const device_request_id = body?.device_request_id
  if (typeof device_request_id !== 'string' || !device_request_id.trim() || device_request_id.length > 256) {
    return json({ error: 'Missing device_request_id' }, { status: 400 })
  }

  return sql.begin(async tx => {
    await tx`SELECT id FROM device_auth_requests WHERE id = ${device_request_id} FOR UPDATE`
    const rows = await tx`
      UPDATE device_auth_requests SET user_id = ${user.id}, status = 'approved', approved_at = clock_timestamp()
      WHERE id = ${device_request_id} AND status = 'pending' AND expires_at > clock_timestamp() RETURNING id
    `
    if (!rows[0]) return json({ error: 'Invalid or expired request' }, { status: 404 })
    return json({ success: true })
  })
}
