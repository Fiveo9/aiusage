import { sql } from '../db/pool.js'
import { getConfigValue, CFG } from '../config.js'
import { env } from '$env/dynamic/private'

const STAR_REPO = 'juliantanx/aiusage'

export interface StarCheckResult {
  allowed: boolean
  error_code?: 'CLOUD_SYNC_DISABLED' | 'USER_CLOUD_BANNED' | 'STAR_REQUIRED' | 'GITHUB_BINDING_REQUIRED' | 'GITHUB_UNAVAILABLE'
  status?: 503
  message?: string
  repo?: string
  url?: string
}

/**
 * Check whether a user is allowed to use Cloud Sync.
 *
 * Decision order:
 * 0. cloud.sync_globally_enabled = 0 → DENY (CLOUD_SYNC_DISABLED)
 * 1. users.cloud_sync_enabled = true → DENY (USER_CLOUD_BANNED, admin banned this user)
 * 2. No GitHub identity → DENY (GITHUB_BINDING_REQUIRED)
 * 3. Cached star check within TTL → use cached value
 * 4. Call GitHub API to verify star → update cache
 */
export async function checkCloudSyncAccess(userId: string): Promise<StarCheckResult> {
  // 0. Check global kill switch
  const globalEnabled = await getConfigValue(CFG.CLOUD_SYNC_GLOBALLY_ENABLED)
  if (!globalEnabled) {
    return {
      allowed: false,
      error_code: 'CLOUD_SYNC_DISABLED',
      message: 'AIUsage Cloud is currently unavailable.',
    }
  }

  // 1. Check if user is banned from cloud
  const userRows = await sql`
    SELECT cloud_sync_enabled, github_starred, github_star_checked_at
    FROM users WHERE id = ${userId}
  `
  if (userRows.length === 0) {
    return { allowed: false, error_code: 'GITHUB_BINDING_REQUIRED', message: 'User not found.' }
  }

  const user = userRows[0] as {
    cloud_sync_enabled: boolean
    github_starred: boolean
    github_star_checked_at: string | null
  }

  if (user.cloud_sync_enabled) {
    return {
      allowed: false,
      error_code: 'USER_CLOUD_BANNED',
      message: 'Your AIUsage Cloud access has been disabled by an administrator.',
    }
  }

  // 2. Check for GitHub identity with access token
  const identityRows = await sql`
    SELECT id, access_token, provider_username
    FROM user_identities
    WHERE user_id = ${userId} AND provider = 'github'
    LIMIT 1
  `
  if (identityRows.length === 0) {
    return {
      allowed: false,
      error_code: 'GITHUB_BINDING_REQUIRED',
      message: 'Please bind your GitHub account to use Cloud Sync.',
      url: `${(env.SITE_URL || 'http://localhost:5173').replace(/\/+$/, '')}/settings`
    }
  }

  const identity = identityRows[0] as { id: string; access_token: string | null; provider_username: string | null }
  const accessToken = identity.access_token

  if (!accessToken) {
    // Has GitHub identity but no stored token — need to re-login via GitHub
    return {
      allowed: false,
      error_code: 'GITHUB_BINDING_REQUIRED',
      message: 'Please re-login via GitHub to refresh your access token.',
      url: `${(env.SITE_URL || 'http://localhost:5173').replace(/\/+$/, '')}/settings`
    }
  }

  // 3. Check cached star status — only cache positive results
  const ttlHours = await getConfigValue(CFG.CLOUD_STAR_CACHE_TTL_HOURS)
  if (user.github_starred && user.github_star_checked_at) {
    const checkedAt = new Date(user.github_star_checked_at).getTime()
    const ttlMs = ttlHours * 60 * 60 * 1000
    const age = Date.now() - checkedAt
    if (age >= 0 && age < ttlMs) {
      return { allowed: true }
    }
  }

  // 4. Call GitHub API
  const result = await checkGitHubStarAPI(accessToken, STAR_REPO)
  if (result === 'reauth') return { allowed: false, error_code: 'GITHUB_BINDING_REQUIRED', message: 'Please rebind GitHub to refresh authorization.', url: `${(env.SITE_URL || 'http://localhost:5173').replace(/\/+$/, '')}/settings` }
  if (result === 'unavailable') return { allowed: false, error_code: 'GITHUB_UNAVAILABLE', status: 503, message: 'GitHub verification is temporarily unavailable. Please retry later.' }
  const starred = result === 'starred'

  // Update cache
  const cached = await sql`
    UPDATE users
    SET github_starred = ${starred}, github_star_checked_at = NOW()
    WHERE id = ${userId}
      AND EXISTS (SELECT 1 FROM user_identities WHERE id = ${identity.id} AND user_id = ${userId} AND access_token = ${accessToken})
    RETURNING id
  `
  if (!cached.length) return { allowed: false, error_code: 'GITHUB_BINDING_REQUIRED', message: 'GitHub identity changed. Please retry.' }

  if (starred) {
    return { allowed: true }
  }

  return {
    allowed: false,
    error_code: 'STAR_REQUIRED',
    message: 'Please star the repository to use Cloud Sync.',
    repo: STAR_REPO,
    url: `https://github.com/${STAR_REPO}`
  }
}

async function checkGitHubStarAPI(accessToken: string, repo: string): Promise<'starred' | 'not-starred' | 'reauth' | 'unavailable'> {
  try {
    const res = await fetch(`https://api.github.com/user/starred/${repo}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json'
      }, signal: AbortSignal.timeout(10_000), redirect: 'error',
    })
    if (res.status === 204) return 'starred'
    if (res.status === 404) return 'not-starred'
    if (res.status === 401) return 'reauth'
    return 'unavailable'
  } catch {
    return 'unavailable'
  }
}
