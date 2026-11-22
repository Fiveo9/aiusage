import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { sql } from '$lib/server/db/pool.js'

export const GET: RequestHandler = async ({ url }) => {
  const token = url.searchParams.get('token')
  if (!token || !/^[A-Za-z0-9_-]{48}$/.test(token)) {
    return json({ verified: false })
  }

  const rows = await sql`
    SELECT u.email_verified FROM email_verification_tokens t
    JOIN users u ON u.id = t.user_id AND LOWER(u.email) = LOWER(t.email)
    WHERE t.id = ${token} AND t.expires_at > clock_timestamp() LIMIT 1
  `
  const user = rows[0] as { email_verified: boolean } | undefined
  return json({ verified: user?.email_verified ?? false })
}
