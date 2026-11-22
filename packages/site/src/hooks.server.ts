import type { Handle } from '@sveltejs/kit'
import { runMigrations } from '$lib/server/db/schema.js'
import { getUserFromEvent } from '$lib/server/auth/session.js'
import { startCleanupCron } from '$lib/server/db/cleanup.js'
import { generateCsrfToken, validateCsrfToken, setCsrfCookie, getCsrfTokenFromCookie, isValidCsrfToken } from '$lib/server/auth/csrf.js'
import { isHttpError } from '@sveltejs/kit'
import { getConfigValue, CFG } from '$lib/server/config.js'
import { readLimitedBuffer, parseJsonObject, AUTH_BODY_LIMIT, DEFAULT_JSON_BODY_LIMIT } from '$lib/server/request-body.js'

let initializationPromise: Promise<void> | null = null

const CLI_SYNC_STATUS_PATH = '/api/cli/sync/status'

function applyCliSyncStatusCors(response: Response) {
  response.headers.set('Access-Control-Allow-Origin', '*')
  response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type')
  response.headers.set('Access-Control-Max-Age', '86400')
}

function ensureInitialized(): Promise<void> {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      await runMigrations()
      startCleanupCron()
    })().catch((error) => {
      initializationPromise = null
      throw error
    })
  }
  return initializationPromise
}

export const handle: Handle = async ({ event, resolve }) => {
  const isCliSyncStatus = event.url.pathname === CLI_SYNC_STATUS_PATH

  if (isCliSyncStatus && event.request.method === 'OPTIONS') {
    const response = new Response(null, { status: 204 })
    applyCliSyncStatusCors(response)
    return response
  }

  try {
    await ensureInitialized()
  } catch {
    console.error('Site initialization failed; request rejected and initialization will be retried.')
    const response = new Response('Service temporarily unavailable', {
      status: 503,
      headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' },
    })
    if (isCliSyncStatus) applyCliSyncStatusCors(response)
    return response
  }

  // Set user in locals
  const user = await getUserFromEvent(event)
  event.locals.user = user

  // Validate CSRF for state-changing requests
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(event.request.method)) {
    const url = event.url.pathname

    // Only validate CSRF for browser form submissions (not API endpoints with HMAC auth)
    if (!url.startsWith('/api/cli/sync/') &&
        !url.startsWith('/api/cli/device/start') &&
        !url.startsWith('/api/cli/device/complete') &&
        !(url.startsWith('/api/oauth/') && url.endsWith('/callback'))) {
      if (!validateCsrfToken(event.request)) {
        return new Response('CSRF token validation failed', { status: 403 })
      }
    }
  }

  // Bound all state-changing request bodies before a route can deserialize them.
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(event.request.method) && event.request.body) {
    let maxBytes = DEFAULT_JSON_BODY_LIMIT
    if (event.url.pathname.startsWith('/api/auth/') || event.url.pathname.startsWith('/api/cli/device/')) maxBytes = AUTH_BODY_LIMIT
    if (event.url.pathname === '/api/cli/sync/push') maxBytes = await getConfigValue(CFG.SYNC_BODY_MAX_SIZE)
    if (event.url.pathname === '/api/me/avatar') maxBytes = await getConfigValue(CFG.AVATAR_MAX_FILE_SIZE) + 64 * 1024
    try {
      const buffer = await readLimitedBuffer(event.request, maxBytes)
      if (buffer.length && event.request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        parseJsonObject(buffer.toString('utf8'))
      }
      event.request = new Request(event.request, { body: new Uint8Array(buffer) })
    } catch (error) {
      if (isHttpError(error)) return new Response(JSON.stringify({ error: error.body.message }), {
        status: error.status, headers: { 'Content-Type': 'application/json', ...(error.status === 413 ? { Connection: 'close' } : {}) },
      })
      throw error
    }
  }

  // Security headers
  const response = await resolve(event)

  // Fix: SvelteKit adapter-node may not set content-type for .ico files.
  // With X-Content-Type-Options: nosniff, browsers/crawlers need the header to detect the favicon.
  if (event.url.pathname === '/favicon.ico' && !response.headers.get('content-type')) {
    response.headers.set('content-type', 'image/x-icon')
  }

  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')

  // Prevent CDNs from caching dynamic API responses
  if (event.url.pathname.startsWith('/api/')) {
    response.headers.set('Cache-Control', 'no-store')
  } else {
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'")
  }

  if (isCliSyncStatus) {
    applyCliSyncStatusCors(response)
  }

  const isPrefetch = ['purpose', 'sec-purpose'].some(name =>
    event.request.headers.get(name)?.toLowerCase().includes('prefetch'))
  const isHtmlPage = event.request.method === 'GET'
    && response.headers.get('content-type')?.toLowerCase().includes('text/html')
    && !event.url.pathname.startsWith('/api/') && !event.url.pathname.startsWith('/_app/')
    && event.url.pathname !== '/favicon.ico' && !event.isDataRequest && !isPrefetch
  if (isHtmlPage && !isValidCsrfToken(getCsrfTokenFromCookie(event.request.headers.get('cookie')))) {
    await setCsrfCookie(response, generateCsrfToken())
  }

  return response
}
