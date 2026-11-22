import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireAdmin } from '$lib/server/auth/session.js'
import { sql } from '$lib/server/db/pool.js'
import { parsePagination } from '$lib/server/pagination.js'

export const GET: RequestHandler = async (event) => {
  await requireAdmin(event)
  const q = event.url.searchParams.get('q') || ''
  const { limit, offset } = parsePagination(event.url, 20, 100)

  let users
  let total
  if (q.trim()) {
    const pattern = `%${q.trim().replace(/[\\%_]/g, '\\$&')}%`
    const [u, t] = await Promise.all([
      sql`
        SELECT u.id, u.username, u.display_name, u.email, u.role, u.status,
               u.created_at, u.banned_at, u.ban_reason,
               u.cloud_sync_enabled, u.github_starred,
               (SELECT gi.provider_username FROM user_identities gi WHERE gi.user_id = u.id AND gi.provider = 'github' ORDER BY gi.id LIMIT 1) AS github_username
        FROM users u
        WHERE u.username ILIKE ${pattern} OR u.display_name ILIKE ${pattern} OR u.email ILIKE ${pattern}
        ORDER BY u.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql`SELECT COUNT(*)::INTEGER AS count FROM users WHERE username ILIKE ${pattern} OR display_name ILIKE ${pattern} OR email ILIKE ${pattern}`
    ])
    users = u
    total = (t[0] as { count: number }).count
  } else {
    const [u, t] = await Promise.all([
      sql`
        SELECT u.id, u.username, u.display_name, u.email, u.role, u.status,
               u.created_at, u.banned_at, u.ban_reason,
               u.cloud_sync_enabled, u.github_starred,
               (SELECT gi.provider_username FROM user_identities gi WHERE gi.user_id = u.id AND gi.provider = 'github' ORDER BY gi.id LIMIT 1) AS github_username
        FROM users u
        ORDER BY u.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql`SELECT COUNT(*)::INTEGER AS count FROM users`
    ])
    users = u
    total = (t[0] as { count: number }).count
  }

  return json({ users, total })
}
