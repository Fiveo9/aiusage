import { isHttpError, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { clearCloudData } from '$lib/server/cloud/sync-state.js'
import { readLimitedText, AUTH_BODY_LIMIT } from '$lib/server/request-body.js'
import { verifyDeviceRequest } from '$lib/server/auth/device-request.js'
import { checkCloudSyncAccess } from '$lib/server/cloud/star-check.js'

export const POST: RequestHandler = async ({ request }) => {
  const bodyText = await readLimitedText(request, AUTH_BODY_LIMIT)

  // Verify HMAC signature
  const verification = await verifyDeviceRequest(request, bodyText)
  if (!verification.valid) {
    const status = verification.error_code === 'rate_limited' ? 429 : 401
    return json({ error: verification.error, error_code: verification.error_code }, { status })
  }

  const userId = verification.userId!

  // Star gate check
  const starCheck = await checkCloudSyncAccess(userId)
  if (!starCheck.allowed) {
    return json({
      error: { code: starCheck.error_code, message: starCheck.message, repo: starCheck.repo, url: starCheck.url }
    }, { status: starCheck.status || 403 })
  }

  try { return json(await clearCloudData(userId, verification.deviceId!)) }
  catch (err) {
    if (isHttpError(err)) return json({ error: err.body.message, error_code: err.body.message }, { status: err.status })
    throw err
  }
}
