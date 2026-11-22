import { afterEach, describe, expect, it, vi } from 'vitest'
import { completeDeviceAuth, startDeviceAuth } from '../src/device-auth/api.js'

const server = 'https://service.invalid'
const request = { device_name: 'test-device', cli_version: '1.5.28', device_challenge: 'synthetic-challenge' }
function startResponse(overrides: Record<string, unknown> = {}) {
  return {
    device_request_id: 'request-1', user_code: 'ABCD-EFGH',
    verification_url: `${server}/cli/authorize?code=ABCD-EFGH`,
    expires_at: new Date(Date.now() + 600_000).toISOString(), interval: 5,
    ...overrides,
  }
}
function reply(data: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json' },
  })))
}
afterEach(() => vi.unstubAllGlobals())

describe('device authorization API validation', () => {
  it.each([
    'javascript:alert(1)',
    'https://foreign.invalid/cli/authorize',
    'https://service.invalid/cli/authorize?code=$(id)',
    'https://service.invalid/cli/authorize?code=`id`',
  ])('rejects an unsafe verification URL: %s', async verification_url => {
    reply(startResponse({ verification_url }))
    await expect(startDeviceAuth(server, request)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it.each([
    { user_code: 'wrong' }, { device_request_id: '' }, { expires_at: 'invalid-date' },
  ])('rejects malformed start response fields', async overrides => {
    reply(startResponse(overrides))
    await expect(startDeviceAuth(server, request)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it.each([0, -5, 90])('bounds the polling interval %s', async interval => {
    reply(startResponse({ interval }))
    const result = await startDeviceAuth(server, request)
    expect(result.interval).toBeGreaterThanOrEqual(1)
    expect(result.interval).toBeLessThanOrEqual(60)
  })

  it('refuses HTTP redirects for authorization requests', async () => {
    reply(startResponse())
    await startDeviceAuth(server, request)
    expect(vi.mocked(fetch).mock.calls[0][1]?.redirect).toBe('error')
  })

  it.each(['authorization_expired', 'authorization_declined'])('uses the canonical error_code: %s', async code => {
    reply({ error: 'A descriptive server message', error_code: code }, 400)
    await expect(completeDeviceAuth(server, { device_request_id: 'request-1', device_verifier: 'synthetic-verifier' }))
      .rejects.toMatchObject({ code })
  })

  it('rejects non-string credentials in a successful completion response', async () => {
    reply({ device_id: 1, device_secret: 2 })
    await expect(completeDeviceAuth(server, { device_request_id: 'request-1', device_verifier: 'synthetic-verifier' }))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })
})
