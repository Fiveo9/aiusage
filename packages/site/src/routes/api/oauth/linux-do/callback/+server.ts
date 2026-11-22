import { redirect, isRedirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { fetchLinuxDoProfile, findOrCreateOAuthUser, bindOAuthIdentity, OAuthAccountError } from '$lib/server/oauth/providers.js'
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
    const context = await consumeOAuthState(state, cookies.get(oauthStateCookie('linux_do')), 'linux_do', existingSid)
    if (!context) return new Response('Invalid OAuth state', { status: 400 })
    cookies.delete(oauthStateCookie('linux_do'), { path: '/' })
    let bindingUserId: string | undefined
    if (context.mode === 'bind') {
      const user = existingSid ? await getSessionUser(existingSid) : null
      if (!user || user.id !== context.userId || user.status === 'banned') return new Response('Invalid binding session', { status: 403 })
      bindingUserId = user.id
    }

    const clientId = env.LINUX_DO_CLIENT_ID
    const clientSecret = env.LINUX_DO_CLIENT_SECRET
    const tokenUrl = env.LINUX_DO_TOKEN_URL
    if (!clientId || !clientSecret || !tokenUrl) return new Response('Linux Do OAuth not configured', { status: 500 })

    const siteUrl = env.SITE_URL || 'http://localhost:5173'
    const redirectUri = `${siteUrl}/api/oauth/linux-do/callback`

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri
      })
    })
    const tokenData = await tokenRes.json() as { access_token?: string; error?: string }
    if (!tokenRes.ok || typeof tokenData.access_token !== 'string' || !tokenData.access_token) {
      return new Response('Linux Do authorization failed', { status: 400 })
    }

    const profile = await fetchLinuxDoProfile(tokenData.access_token)

    if (bindingUserId) {
        const result = await bindOAuthIdentity(bindingUserId, profile)
        if (result.error) {
          throw redirect(302, `/settings?error=${encodeURIComponent(result.error)}`)
        }
        throw redirect(302, '/settings?bound=linux_do')
    }

    const user = await findOrCreateOAuthUser(profile)
    if (user.status === 'banned') return new Response('User banned', { status: 403 })
    const sid = await createSession(user.id)
    await setSessionCookie(cookies, sid)

    throw redirect(302, '/settings')
  } catch (e) {
    if (isRedirect(e)) throw e
    if (e instanceof OAuthAccountError) return new Response(e.code, { status: 400 })
    console.error('Linux Do OAuth callback failed')
    return new Response('OAuth callback failed', { status: 500 })
  }
}
