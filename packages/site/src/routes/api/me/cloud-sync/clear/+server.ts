import { isHttpError, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { clearCloudData } from '$lib/server/cloud/sync-state.js'
import { requireUser } from '$lib/server/auth/session.js'

export const POST: RequestHandler = async (event) => {
  const user = await requireUser(event)

  try { return json(await clearCloudData(user.id)) }
  catch (err) {
    if (isHttpError(err)) return json({ error: err.body.message, error_code: err.body.message }, { status: err.status })
    throw err
  }
}
