import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { sql } from '$lib/server/db/pool.js'
import { requireUser } from '$lib/server/auth/session.js'
import { getConfigValue, CFG } from '$lib/server/config.js'
import { readLimitedJson } from '$lib/server/request-body.js'

export const PUT: RequestHandler = async (event) => {
  const user = await requireUser(event)
  const body = await readLimitedJson(event.request)

  const usernameCooldownDays = await getConfigValue(CFG.USERNAME_COOLDOWN_DAYS)
  const usernameMinLength = await getConfigValue(CFG.USERNAME_MIN_LENGTH)
  const usernameMaxLength = await getConfigValue(CFG.USERNAME_MAX_LENGTH)
  const displayNameMinLength = await getConfigValue(CFG.DISPLAY_NAME_MIN_LENGTH)
  const displayNameMaxLength = await getConfigValue(CFG.DISPLAY_NAME_MAX_LENGTH)

  const updates: Record<string, string> = {}

  // username
  if (body.username !== undefined) {
    if (typeof body.username !== 'string') return json({ error: 'username_format', error_key: 'username_format' }, { status: 400 })
    const username = body.username.trim()
    if (username.length < usernameMinLength || username.length > usernameMaxLength) {
      return json({ error: 'username_length', error_key: 'username_length' }, { status: 400 })
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return json({ error: 'username_format', error_key: 'username_format' }, { status: 400 })
    }
    updates.username = username
  }

  // display_name
  if (body.display_name !== undefined) {
    if (typeof body.display_name !== 'string') return json({ error: 'display_name_length', error_key: 'display_name_length' }, { status: 400 })
    const displayName = body.display_name.trim()
    if (displayName.length < displayNameMinLength || displayName.length > displayNameMaxLength) {
      return json({ error: 'display_name_length', error_key: 'display_name_length' }, { status: 400 })
    }
    updates.display_name = displayName
  }

  if (Object.keys(updates).length === 0) {
    return json({ message: 'No changes' })
  }

  try {
    return await sql.begin(async (tx) => {
      const rows = await tx`SELECT username, username_changed_at, status FROM users WHERE id = ${user.id} FOR UPDATE`
      const current = rows[0] as { username: string; username_changed_at: string | null; status: string } | undefined
      if (!current || current.status !== 'active') return json({ error: 'unauthorized' }, { status: 403 })
      const usernameChanged = updates.username !== undefined && updates.username !== current.username
      if (usernameChanged) {
        if (current.username_changed_at) {
          const cooldownEnd = new Date(new Date(current.username_changed_at).getTime() + usernameCooldownDays * 86_400_000)
          if (cooldownEnd.getTime() > Date.now()) return json({ error: 'username_cooldown', error_key: 'username_cooldown', cooldown_until: cooldownEnd.toISOString() }, { status: 429 })
        }
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`username:${updates.username}`}))`
        const taken = await tx`SELECT id FROM users WHERE username = ${updates.username} AND id != ${user.id}`
        if (taken.length) return json({ error: 'username_taken', error_key: 'username_taken' }, { status: 409 })
        const reserved = await tx`SELECT username FROM reserved_usernames
          WHERE username = ${updates.username} AND user_id != ${user.id} AND reserved_until > clock_timestamp()`
        if (reserved.length) return json({ error: 'username_reserved', error_key: 'username_reserved' }, { status: 409 })
        await tx`UPDATE users SET username = ${updates.username!}, username_changed_at = NOW(), updated_at = NOW() WHERE id = ${user.id}`
        const reservedUntil = new Date(Date.now() + usernameCooldownDays * 86_400_000)
        await tx`INSERT INTO reserved_usernames (username, user_id, reserved_until)
          VALUES (${current.username}, ${user.id}, ${reservedUntil})
          ON CONFLICT (username) DO UPDATE SET reserved_until = EXCLUDED.reserved_until, user_id = EXCLUDED.user_id`
      }
      if (updates.display_name !== undefined) await tx`UPDATE users SET display_name = ${updates.display_name}, updated_at = NOW() WHERE id = ${user.id}`
      const updated = await tx`SELECT id, username, display_name, username_changed_at FROM users WHERE id = ${user.id}`
      return json(updated[0])
    })
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return json({ error: 'username_taken', error_key: 'username_taken' }, { status: 409 })
    throw err
  }
}
