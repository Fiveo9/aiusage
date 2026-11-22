import { afterEach, describe, expect, it, vi } from 'vitest'
import { csrfHeaders } from '../../src/lib/csrf.js'
afterEach(() => vi.unstubAllGlobals())

describe('shared browser CSRF headers', () => {
  it('reads the exact cookie and preserves existing JSON headers', () => {
    const token = 'a'.repeat(64)
    vi.stubGlobal('document', { cookie: `other_csrf_token=${'b'.repeat(64)}; csrf_token=${token}` })
    const headers = csrfHeaders({ 'Content-Type': 'application/json', 'x-custom': 'kept' })
    expect(headers.get('x-csrf-token')).toBe(token)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-custom')).toBe('kept')
  })

  it('reads fresh cookie values for each request and leaves FormData content type unset', () => {
    const document = { cookie: `csrf_token=${'a'.repeat(64)}` }
    vi.stubGlobal('document', document)
    expect(csrfHeaders().get('x-csrf-token')).toBe('a'.repeat(64))
    document.cookie = `csrf_token=${'b'.repeat(64)}`
    expect(csrfHeaders().get('x-csrf-token')).toBe('b'.repeat(64))
    expect(csrfHeaders().get('content-type')).toBeNull()
  })

  it('does not accept a malformed/prefix cookie and works without a browser document', () => {
    vi.stubGlobal('document', { cookie: `other_csrf_token=${'a'.repeat(64)}; csrf_token=malformed` })
    expect(csrfHeaders().get('x-csrf-token')).toBeNull()
    vi.stubGlobal('document', undefined)
    expect(csrfHeaders().get('x-csrf-token')).toBeNull()
  })
})
