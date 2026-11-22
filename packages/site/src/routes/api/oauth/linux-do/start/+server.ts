import type { RequestHandler } from './$types'
import { nanoid } from 'nanoid'
import { env } from '$env/dynamic/private'
import { saveOAuthState, oauthStateCookie, OAuthStateLimitError } from '$lib/server/oauth/state-store.js'
import { getSessionUser } from '$lib/server/auth/session.js'

export const GET: RequestHandler = async ({ url, cookies }) => {
  const clientId = env.LINUX_DO_CLIENT_ID
  const authorizationUrl = env.LINUX_DO_AUTHORIZATION_URL
  if (!clientId || !authorizationUrl) return new Response('Linux Do OAuth not configured', { status: 500 })

  const mode = url.searchParams.get('mode') || 'login'
  if (mode !== 'login' && mode !== 'bind') return new Response('Invalid OAuth mode', { status: 400 })
  const sessionId = cookies.get('ai_session')
  let userId: string | undefined
  if (mode === 'bind') {
    const user = sessionId ? await getSessionUser(sessionId) : null
    if (!user || user.status === 'banned') return new Response('Valid binding session required', { status: 403 })
    userId = user.id
  }
  const state = nanoid(32)
  const browserNonce = nanoid(32)
  let maxAge: number
  try {
    maxAge = await saveOAuthState(state, browserNonce, { provider: 'linux_do', mode, userId, sessionId })
  } catch (error) {
    if (error instanceof OAuthStateLimitError) return new Response('Too many OAuth requests', { status: 429 })
    throw error
  }
  cookies.set(oauthStateCookie('linux_do'), browserNonce, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge,
  })

  const siteUrl = env.SITE_URL || 'http://localhost:5173'
  const redirectUri = `${siteUrl}/api/oauth/linux-do/callback`
  const authUrl = `${authorizationUrl}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid+profile+email&state=${state}`

  return new Response(null, {
    status: 302,
    headers: { Location: authUrl }
  })
}
