import { describe, it, expect, afterEach, vi } from 'vitest'
import { DeviceAuthApiError, startDeviceAuth, completeDeviceAuth } from '../../src/device-auth/api.js'

afterEach(() => vi.unstubAllGlobals())

describe('cloud sync device authorization', () => {
  it('starts authorization at the shared device endpoint', async () => {
    const fetchMock = vi.fn(async () => Response.json({ device_request_id: 'request', interval: 5 }))
    vi.stubGlobal('fetch', fetchMock)
    const request = { device_name: 'test-device', cli_version: 'test', device_challenge: 'test-challenge' }
    await expect(startDeviceAuth('https://sync.test', request)).resolves.toHaveProperty('device_request_id', 'request')
    expect(fetchMock).toHaveBeenCalledWith('https://sync.test/api/cli/device/start', expect.objectContaining({
      method: 'POST', body: JSON.stringify(request),
    }))
  })

  it('keeps pending authorization retryable and validates completed credentials', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ pending: true }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ device_id: 'device' }))
      .mockResolvedValueOnce(Response.json({ device_id: 'device', device_secret: 'fixture-only' }))
    vi.stubGlobal('fetch', fetchMock)
    const request = { device_request_id: 'request', device_verifier: 'test-verifier' }
    await expect(completeDeviceAuth('https://sync.test', request)).rejects.toHaveProperty('code', 'authorization_pending')
    await expect(completeDeviceAuth('https://sync.test', request)).rejects.toHaveProperty('code', 'invalid_response')
    await expect(completeDeviceAuth('https://sync.test', request)).resolves.toHaveProperty('device_id', 'device')
    expect(fetchMock).toHaveBeenLastCalledWith('https://sync.test/api/cli/device/complete', expect.objectContaining({ method: 'POST' }))
  })
})

describe('DeviceAuthApiError', () => {
  it('has correct name', () => {
    const err = new DeviceAuthApiError('test')
    expect(err.name).toBe('DeviceAuthApiError')
  })

  it('stores message, code, and retryAfter', () => {
    const err = new DeviceAuthApiError('rate limited', 'rate_limited', 30)
    expect(err.message).toBe('rate limited')
    expect(err.code).toBe('rate_limited')
    expect(err.retryAfter).toBe(30)
  })

  it('is instanceof Error', () => {
    const err = new DeviceAuthApiError('test')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(DeviceAuthApiError)
  })

  it('works with optional parameters', () => {
    const err = new DeviceAuthApiError('msg')
    expect(err.code).toBeUndefined()
    expect(err.retryAfter).toBeUndefined()
  })
})
