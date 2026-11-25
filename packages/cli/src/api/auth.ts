import http from 'node:http'
import { browserProtocol } from './trust.js'
import { buildAuthCookie, buildClearAuthCookie, isAuthenticated, verifyPassword } from '../auth.js'
import { BodyTooLargeError, readJsonBody } from './request-body.js'
import { json, bodyTooLarge } from './http-helpers.js'
import type { ApiRequestContext } from './context.js'

export function createAuthRoutes(dashboardPassword: string | null) {
const loginAttempts = new Map<string, number[]>()
  function loginRetryAfter(req: http.IncomingMessage): number {
    const now = Date.now()
    const cutoff = now - 60_000
    for (const [key, attempts] of loginAttempts) {
  const recent = attempts.filter(time => time > cutoff)
  if (recent.length) loginAttempts.set(key, recent)
  else loginAttempts.delete(key)
    }
    const key = req.socket.remoteAddress || 'unknown'
    const attempts = loginAttempts.get(key) || []
    if (attempts.length >= 10) return Math.max(1, Math.ceil((attempts[0] + 60_000 - now) / 1000))
    if (!loginAttempts.has(key) && loginAttempts.size >= 1024) return 60
    attempts.push(now)
    loginAttempts.set(key, attempts)
    return 0
  }
  return async (context: ApiRequestContext): Promise<boolean> => {
    const { req, res, url } = context
if (url.pathname === '/api/auth/status' && req.method === 'GET') {
  json(res, {
    enabled: dashboardPassword != null,
    authenticated: isAuthenticated(dashboardPassword, req.headers.cookie),
  })
  return true
    }

    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
  try {
    const body = await readJsonBody(req, 16 * 1024)
    if (body.password !== undefined && typeof body.password !== 'string') {
      json(res, { error: { code: 'INVALID_PARAM', message: 'password must be a string' } }, 400)
      return true
    }
    if (dashboardPassword) {
      const retryAfter = loginRetryAfter(req)
      if (retryAfter) {
        res.setHeader('Retry-After', String(retryAfter))
        json(res, { error: { code: 'RATE_LIMITED', message: 'Too many login attempts' } }, 429)
        return true
      }
    }
    if (!verifyPassword(dashboardPassword, typeof body.password === 'string' ? body.password : null)) {
      json(res, { error: { code: 'UNAUTHORIZED', message: 'Invalid password' } }, 401)
      return true
    }

    if (dashboardPassword) {
      res.setHeader('Set-Cookie', buildAuthCookie(dashboardPassword, browserProtocol(req) === 'https:'))
    }
    json(res, { ok: true })
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      bodyTooLarge(res)
      return true
    }
    json(res, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400)
  }
  return true
    }

    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
  res.setHeader('Set-Cookie', buildClearAuthCookie(browserProtocol(req) === 'https:'))
  json(res, { ok: true })
  return true
    }
    return false
  }
}
