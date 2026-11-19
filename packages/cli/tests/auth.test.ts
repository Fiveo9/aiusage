import { describe, expect, it } from 'vitest'
import {
  AUTH_COOKIE_NAME,
  buildAuthCookie,
  buildClearAuthCookie,
  isAuthenticated,
  isPublicPath,
  shouldProtectApiPath,
  verifyPassword,
} from '../src/auth.js'

describe('dashboard auth helpers', () => {
  it('does not require auth when dashboard password is unset', () => {
    expect(verifyPassword(undefined, 'anything')).toBe(true)
    expect(verifyPassword('', 'anything')).toBe(true)
  })

  it('verifies submitted password against configured password', () => {
    expect(verifyPassword('secret', 'secret')).toBe(true)
    expect(verifyPassword('secret', 'wrong')).toBe(false)
  })

  it('allows the dashboard home page and auth endpoints without a session', () => {
    expect(isPublicPath('/')).toBe(true)
    expect(isPublicPath('/index.html')).toBe(true)
    expect(isPublicPath('/api/auth/status')).toBe(true)
    expect(isPublicPath('/api/auth/login')).toBe(true)
  })

  it('protects non-home dashboard routes', () => {
    expect(isPublicPath('/overview')).toBe(false)
    expect(isPublicPath('/tokens')).toBe(false)
    expect(isPublicPath('/settings')).toBe(false)
    expect(isPublicPath('/sessions/session-1')).toBe(false)
  })

  it('protects data and mutating API routes while leaving the home totals public', () => {
    expect(shouldProtectApiPath('/api/home-summary')).toBe(false)
    expect(shouldProtectApiPath('/api/summary')).toBe(true)
    expect(shouldProtectApiPath('/api/tokens')).toBe(true)
    expect(shouldProtectApiPath('/api/config')).toBe(true)
    expect(shouldProtectApiPath('/api/sync')).toBe(true)
    expect(shouldProtectApiPath('/api/quotas')).toBe(true)
    expect(shouldProtectApiPath('/api/sessions/session.json')).toBe(true)
  })

  it('recognizes the generated auth cookie', () => {
    const now = Date.parse('2026-11-19T00:00:00Z')
    const cookie = buildAuthCookie('secret', false, now)
    const cookieHeader = cookie.split(';')[0]

    expect(cookieHeader.startsWith(`${AUTH_COOKIE_NAME}=`)).toBe(true)
    expect(isAuthenticated('secret', cookieHeader, now)).toBe(true)
    expect(isAuthenticated('secret', cookieHeader, now + 7 * 24 * 60 * 60 * 1000 - 1)).toBe(true)
    expect(isAuthenticated('secret', cookieHeader, now + 7 * 24 * 60 * 60 * 1000)).toBe(false)
    expect(isAuthenticated('secret', cookieHeader, now + 7 * 24 * 60 * 60 * 1000 + 1)).toBe(false)
    expect(isAuthenticated('secret', cookieHeader, now + 8 * 24 * 60 * 60 * 1000)).toBe(false)
    expect(isAuthenticated('different', cookieHeader, now)).toBe(false)
  })

  it('rejects tampered, future and malformed sessions', () => {
    const now = Date.parse('2026-11-19T00:00:00Z')
    const cookie = buildAuthCookie('secret', false, now).split(';')[0]
    const token = cookie.slice(`${AUTH_COOKIE_NAME}=`.length)
    const changed = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')
    expect(isAuthenticated('secret', `${AUTH_COOKIE_NAME}=${changed}`, now)).toBe(false)
    expect(isAuthenticated('secret', `${AUTH_COOKIE_NAME}=not-a-session`, now)).toBe(false)
    expect(isAuthenticated('secret', cookie, now - 1)).toBe(false)
  })

  it('adds Secure to auth and clear cookies only when requested', () => {
    expect(buildAuthCookie('secret')).not.toContain('; Secure')
    expect(buildClearAuthCookie()).not.toContain('; Secure')
    expect(buildAuthCookie('secret', true)).toContain('; Secure')
    expect(buildClearAuthCookie(true)).toContain('; Secure')
  })
})
