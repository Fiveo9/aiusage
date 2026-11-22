import { sql } from '../db/pool.js'
import { nanoid } from 'nanoid'
import type { SessionUser } from '../auth/session.js'
import { env } from '$env/dynamic/private'
import type postgres from 'postgres'

export interface OAuthProfile {
  provider: string
  providerUserId: string
  username: string
  email: string | null
  emailVerified: boolean
  avatarUrl: string | null
  rawProfile: Record<string, unknown>
}

export class OAuthAccountError extends Error {
  constructor(public code: string) { super(code); this.name = 'OAuthAccountError' }
}

async function insertIdentity(tx: postgres.TransactionSql, userId: string, profile: OAuthProfile, accessToken?: string): Promise<void> {
  const bound = await tx`SELECT id FROM user_identities WHERE user_id = ${userId} AND provider = ${profile.provider}`
  if (bound[0]) throw new OAuthAccountError('provider_already_bound')
  const rows = await tx`
    INSERT INTO user_identities (id, user_id, provider, provider_user_id, provider_username, email, email_verified, raw_profile, access_token)
    VALUES (${nanoid()}, ${userId}, ${profile.provider}, ${profile.providerUserId}, ${profile.username}, ${profile.email}, ${profile.emailVerified === true}, ${JSON.stringify(profile.rawProfile)}, ${accessToken || null})
    ON CONFLICT DO NOTHING RETURNING id
  `
  if (!rows[0]) throw new OAuthAccountError('already_linked')
}

export async function findOrCreateOAuthUser(profile: OAuthProfile, accessToken?: string): Promise<SessionUser> {
  const email = profile.email?.trim().toLowerCase() || null
  const verified = profile.emailVerified === true
  const normalized = { ...profile, email, emailVerified: verified }
  return sql.begin(async tx => {
    const existing = await tx`
      SELECT u.id, u.username, u.email, u.display_name, u.avatar_url, u.role, u.status
      FROM user_identities ui JOIN users u ON u.id = ui.user_id
      WHERE ui.provider = ${profile.provider} AND ui.provider_user_id = ${profile.providerUserId}
      FOR UPDATE OF u
    `
    if (existing[0]) {
      const user = existing[0] as SessionUser
      if (user.status === 'banned') return user
      if (accessToken) await tx`
        UPDATE user_identities SET access_token = ${accessToken}
        WHERE provider = ${profile.provider} AND provider_user_id = ${profile.providerUserId}
      `
      if (email) await maybeGrantAdmin(user.id, email, verified, tx)
      return user
    }

    if (email) {
      const matches = await tx`
        SELECT id, username, email, email_verified, display_name, avatar_url, role, status
        FROM users WHERE LOWER(email) = ${email} FOR UPDATE
      `
      if (matches.length > 1) throw new OAuthAccountError('email_ambiguous')
      if (matches[0]) {
        const user = matches[0] as SessionUser & { email_verified: boolean }
        if (!verified || user.email_verified !== true) throw new OAuthAccountError('email_not_verified')
        if (user.status === 'banned') return user
        await insertIdentity(tx, user.id, normalized, accessToken)
        await maybeGrantAdmin(user.id, email, true, tx)
        return user
      }
    }

    const userId = nanoid()
    let username = profile.username
    const existingUsername = await tx`SELECT id FROM users WHERE username = ${username}`
    if (existingUsername[0]) username = `${username}-${nanoid(4)}`
    const userEmail = email || `${username}@placeholder.local`
    await tx`
      INSERT INTO users (id, username, email, email_verified, display_name, avatar_url, role, status)
      VALUES (${userId}, ${username}, ${userEmail}, ${Boolean(email) && verified}, ${profile.username}, ${profile.avatarUrl}, 'user', 'active')
    `
    await insertIdentity(tx, userId, normalized, accessToken)
    if (email) await maybeGrantAdmin(userId, email, verified, tx)
    return { id: userId, username, email: userEmail, display_name: profile.username,
      avatar_url: profile.avatarUrl, role: 'user', status: 'active' }
  })
}

export async function maybeGrantAdmin(userId: string, email: string, providerEmailVerified = false, db: typeof sql | postgres.TransactionSql = sql): Promise<void> {
  if (providerEmailVerified !== true) return
  const normalizedEmail = email.trim().toLowerCase()
  const adminEmails = (env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  if (adminEmails.includes(normalizedEmail)) await db`
    UPDATE users SET role = 'admin'
    WHERE id = ${userId} AND role = 'user' AND status = 'active'
      AND email_verified = TRUE AND LOWER(email) = ${normalizedEmail}
  `
}

export async function bindOAuthIdentity(userId: string, profile: OAuthProfile, accessToken?: string): Promise<{ error?: string }> {
  try {
    return await sql.begin(async tx => {
      const user = await tx`SELECT id, status FROM users WHERE id = ${userId} FOR UPDATE`
      if (!user[0]) return { error: 'user_not_found' }
      if (user[0].status === 'banned') return { error: 'user_banned' }
      await insertIdentity(tx, userId, profile, accessToken)
      return {}
    })
  } catch (error) {
    if (error instanceof OAuthAccountError) return { error: error.code }
    throw error
  }
}

export async function fetchGitHubProfile(accessToken: string): Promise<OAuthProfile> {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`)
  const data = await res.json() as Record<string, unknown>

  let email = data.email as string | null
  let emailVerified = false
  if (!email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' }
    })
    if (emailsRes.ok) {
      const emails = await emailsRes.json() as Array<{ email: string; verified: boolean; primary: boolean }>
      const primary = emails.find(e => e.primary && e.verified)
      if (primary) {
        email = primary.email
        emailVerified = true
      }
    }
  } else {
    emailVerified = true // GitHub public email is verified
  }

  return {
    provider: 'github',
    providerUserId: String(data.id),
    username: (data.login as string) || 'github-user',
    email,
    emailVerified,
    avatarUrl: data.avatar_url as string | null,
    rawProfile: data
  }
}

export async function fetchLinuxDoProfile(accessToken: string): Promise<OAuthProfile> {
  const userInfoUrl = env.LINUX_DO_USERINFO_URL || 'https://connect.linux.do/api/user'
  const res = await fetch(userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) throw new Error(`Linux Do API error: ${res.status}`)
  const data = await res.json() as Record<string, unknown>

  return {
    provider: 'linux_do',
    providerUserId: String(data.sub || data.id),
    username: (data.username || data.preferred_username || data.name || 'linuxdo-user') as string,
    email: (data.email as string) || null,
    emailVerified: data.email_verified === true,
    avatarUrl: (data.picture as string) || null,
    rawProfile: data
  }
}
