import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireUser } from '$lib/server/auth/session.js'
import { sql } from '$lib/server/db/pool.js'

export const GET: RequestHandler = async (event) => {
  const user = await requireUser(event)

  const rows = await sql`
    SELECT provider, provider_username AS username, email, created_at
    FROM user_identities
    WHERE user_id = ${user.id}
    ORDER BY created_at ASC
  `

  return json({ identities: rows })
}
