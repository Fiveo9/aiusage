import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireAdmin } from '$lib/server/auth/session.js'
import { setUserRole } from '$lib/server/admin/operations.js'

export const POST: RequestHandler = async (event) => {
  const admin = await requireAdmin(event)
  const targetId = event.params.id
  const body = await event.request.json()

  if (!['user', 'admin'].includes(body.role)) {
    return json({ error: 'Invalid role' }, { status: 400 })
  }

  if (targetId === admin.id) {
    return json({ error: 'Cannot change your own role' }, { status: 403 })
  }

  await setUserRole(admin.id, targetId, body.role)
  return json({ success: true })
}
