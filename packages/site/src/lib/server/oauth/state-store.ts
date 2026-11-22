import { createHash } from 'node:crypto'
import { sql } from '../db/pool.js'
import { CFG, getConfigValue } from '../config.js'

export type OAuthProvider = 'github' | 'linux_do'
export interface OAuthState {
  provider: OAuthProvider
  mode: 'login' | 'bind'
  userId?: string
}
export class OAuthStateLimitError extends Error {}
export const MAX_OAUTH_STATES = 10_000
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const oauthStateCookie = (provider: OAuthProvider) => `ai_oauth_${provider}`

export async function saveOAuthState(state: string, browserNonce: string, context: OAuthState & { sessionId?: string }): Promise<number> {
  if (context.mode === 'bind' && (!context.userId || !context.sessionId)) throw new Error('Binding session required')
  const configuredAge = Number(await getConfigValue(CFG.OAUTH_STATE_MAX_AGE_SECONDS))
  const maxAge = Math.max(1, Math.min(3600, Math.floor(configuredAge) || 600))
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(1634304371, 2)`
    await tx`DELETE FROM oauth_states WHERE expires_at <= NOW()`
    const counts = await tx`SELECT COUNT(*) AS count FROM oauth_states`
    if (Number(counts[0]?.count) >= MAX_OAUTH_STATES) throw new OAuthStateLimitError('Too many pending OAuth requests')
    await tx`
      INSERT INTO oauth_states (state_hash, browser_nonce_hash, provider, mode, user_id, session_id_hash, expires_at)
      VALUES (${hash(state)}, ${hash(browserNonce)}, ${context.provider}, ${context.mode},
        ${context.mode === 'bind' ? context.userId! : null},
        ${context.mode === 'bind' ? hash(context.sessionId!) : null}, NOW() + ${maxAge} * INTERVAL '1 second')
    `
  })
  return maxAge
}

export async function consumeOAuthState(state: string, browserNonce: string | undefined, provider: OAuthProvider, sessionId?: string): Promise<OAuthState | null> {
  if (!state || !browserNonce || state.length > 128 || browserNonce.length > 128) return null
  const rows = await sql`
    DELETE FROM oauth_states
    WHERE state_hash = ${hash(state)} AND browser_nonce_hash = ${hash(browserNonce)}
      AND provider = ${provider} AND expires_at > NOW()
      AND (mode = 'login' OR session_id_hash = ${sessionId ? hash(sessionId) : null})
    RETURNING mode, user_id
  `
  const row = rows[0]
  return row ? { provider, mode: row.mode as 'login' | 'bind', ...(row.user_id ? { userId: String(row.user_id) } : {}) } : null
}
