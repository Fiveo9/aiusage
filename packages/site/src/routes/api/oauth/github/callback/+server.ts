import { redirect, isRedirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { fetchGitHubProfile, findOrCreateOAuthUser, bindOAuthIdentity, OAuthAccountError } from '$lib/server/oauth/providers.js'
import { createSession, getSessionUser, setSessionCookie } from '$lib/server/auth/session.js'
import { consumeOAuthState, oauthStateCookie } from '$lib/server/oauth/state-store.js'
import { env } from '$env/dynamic/private'

export const GET: RequestHandler = async ({ url, cookies }) => {
  try {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) {
    return new Response('Invalid OAuth state', { status: 400 })
  }
  const existingSid = cookies.get('ai_session')
  const context = await consumeOAuthState(state, cookies.get(oauthStateCookie('github')), 'github', existingSid)
  if (!context) return new Response('Invalid OAuth state', { status: 400 })
  cookies.delete(oauthStateCookie('github'), { path: '/' })
  let bindingUserId: string | undefined
  if (context.mode === 'bind') {
    const user = existingSid ? await getSessionUser(existingSid) : null
    if (!user || user.id !== context.userId || user.status === 'banned') return new Response('Invalid binding session', { status: 403 })
    bindingUserId = user.id
  }

  const clientId = env.GITHUB_CLIENT_ID
  const clientSecret = env.GITHUB_CLIENT_SECRET
  if (!clientId || !clientSecret) return new Response('GitHub OAuth not configured', { status: 500 })

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code })
  })
  const tokenData = await tokenRes.json() as { access_token?: string; error?: string }
  if (!tokenRes.ok || typeof tokenData.access_token !== 'string' || !tokenData.access_token) {
    return new Response('GitHub authorization failed', { status: 400 })
  }

  const profile = await fetchGitHubProfile(tokenData.access_token)

  if (bindingUserId) {
      const result = await bindOAuthIdentity(bindingUserId, profile, tokenData.access_token)
      if (result.error) {
        throw redirect(302, `/settings?error=${encodeURIComponent(result.error)}`)
      }
      throw redirect(302, '/settings?bound=github')
  }

  const user = await findOrCreateOAuthUser(profile, tokenData.access_token)
  if (user.status === 'banned') return new Response('User banned', { status: 403 })
  const sid = await createSession(user.id)
  await setSessionCookie(cookies, sid)

  throw redirect(302, '/settings')
  } catch (error) {
    if (isRedirect(error)) throw error
    if (error instanceof OAuthAccountError) return new Response(error.code, { status: 400 })
    console.error('GitHub OAuth callback failed')
    return new Response('OAuth callback failed', { status: 500 })
  }
}
