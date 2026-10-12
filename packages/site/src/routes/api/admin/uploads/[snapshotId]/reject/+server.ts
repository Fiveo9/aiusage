import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireAdmin } from '$lib/server/auth/session.js'
import { rejectSnapshot } from '$lib/server/admin/operations.js'

export const POST: RequestHandler = async (event) => {
  const admin = await requireAdmin(event)
  const body = await event.request.json()
  const result = await rejectSnapshot(admin.id, event.params.snapshotId, body.note)
  return json({ success: true, metrics_updated: result.metricsUpdated })
}
