import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireAdmin } from '$lib/server/auth/session.js'
import { runCleanup } from '$lib/server/db/cleanup.js'
import { readLimitedJson } from '$lib/server/request-body.js'

/**
 * POST /api/admin/maintenance/cleanup
 *
 * Cloud sync data maintenance (§12.4):
 * - Clean expired upload nonces
 * - Compact old tombstones
 * - Clean old generation cloud_usage_records
 * - Clean stale sync batches
 */
export const POST: RequestHandler = async (event) => {
  const admin = await requireAdmin(event)
  const body = event.request.body ? await readLimitedJson(event.request) : {}
  if (body.reason != null && (typeof body.reason !== 'string' || body.reason.length > 1000)) return json({ error: 'Invalid cleanup reason' }, { status: 400 })
  const results = await runCleanup(admin.id, body.reason as string | null ?? null)

  return json({ status: 'completed', results })
}
