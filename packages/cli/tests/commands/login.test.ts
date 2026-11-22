import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import { completeDeviceAuth, DeviceAuthApiError, startDeviceAuth } from '../../src/device-auth/api.js'
import { saveCredentials } from '../../src/device-auth/credentials.js'
import { getCliVersion, openBrowser, runLogin } from '../../src/commands/login.js'

vi.mock('node:child_process', () => ({ execSync: vi.fn(() => 'synthetic-host'), execFileSync: vi.fn() }))
vi.mock('../../src/device-auth/credentials.js', () => ({ hasCredentials: vi.fn(() => false), saveCredentials: vi.fn() }))
vi.mock('../../src/site-url.js', () => ({ getSiteUrl: () => 'https://service.invalid' }))
vi.mock('../../src/device-auth/api.js', async original => ({
  ...await original<typeof import('../../src/device-auth/api.js')>(),
  startDeviceAuth: vi.fn(), completeDeviceAuth: vi.fn(),
}))

const previousExitCode = process.exitCode
function startPayload(overrides = {}) {
  return {
    device_request_id: 'synthetic-request', user_code: 'ABCD-EFGH',
    verification_url: 'https://service.invalid/cli/authorize?code=ABCD-EFGH',
    expires_at: new Date(Date.now() + 60_000).toISOString(), interval: 5,
    ...overrides,
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  process.exitCode = undefined
  vi.mocked(startDeviceAuth).mockReset().mockResolvedValue(startPayload())
  vi.mocked(completeDeviceAuth).mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  process.exitCode = previousExitCode
})

describe('safe device login', () => {
  it('opens an HTTP URL with a parameter array and no shell', () => {
    const url = 'https://service.invalid/cli/authorize?code=ABCD-EFGH&mode=login'
    expect(openBrowser(url)).toBe(true)
    expect(execFileSync).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([url]),
      expect.objectContaining({ shell: false, windowsHide: true }))
    expect(execSync).not.toHaveBeenCalled()
  })

  it.each(['javascript:alert(1)', 'https://service.invalid/";echo', 'https://service.invalid/`id`'])
    ('does not invoke a browser command for unsafe URL %s', url => {
      expect(openBrowser(url)).toBe(false)
      expect(execFileSync).not.toHaveBeenCalled()
      expect(execSync).not.toHaveBeenCalled()
    })

  it('reads a real CLI version in ESM source execution', () => {
    expect(getCliVersion()).toMatch(/^\d+\.\d+\.\d+/)
    expect(getCliVersion()).not.toBe('0.0.0')
  })

  it.each(['authorization_expired', 'authorization_declined'])('returns a failing exit code for %s', async code => {
    vi.mocked(completeDeviceAuth).mockRejectedValue(new DeviceAuthApiError('Synthetic failure', code))
    const pending = runLogin()
    await vi.advanceTimersByTimeAsync(5_000)
    await pending
    expect(process.exitCode).toBe(1)
    expect(saveCredentials).not.toHaveBeenCalled()
  })

  it('bounds a zero polling interval and avoids immediate repeated requests', async () => {
    vi.mocked(startDeviceAuth).mockResolvedValue(startPayload({ interval: 0 }))
    vi.mocked(completeDeviceAuth).mockRejectedValue(new DeviceAuthApiError('Synthetic decline', 'authorization_declined'))
    const pending = runLogin()
    await vi.advanceTimersByTimeAsync(999)
    expect(completeDeviceAuth).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4_001)
    await pending
    expect(completeDeviceAuth).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBe(1)
  })

  it('times out without polling after the authorization deadline', async () => {
    vi.mocked(startDeviceAuth).mockResolvedValue(startPayload({ expires_at: new Date(Date.now() + 500).toISOString() }))
    const pending = runLogin()
    await vi.advanceTimersByTimeAsync(5_000)
    await pending
    expect(process.exitCode).toBe(1)
    expect(completeDeviceAuth).not.toHaveBeenCalled()
  })

  it('sets a failing exit code when authorization cannot start', async () => {
    vi.mocked(startDeviceAuth).mockRejectedValue(new Error('Synthetic start failure'))
    await runLogin()
    expect(process.exitCode).toBe(1)
  })

  it('saves credentials once after successful authorization', async () => {
    vi.mocked(completeDeviceAuth).mockResolvedValue({ device_id: 'synthetic-device', device_secret: 'synthetic-test-value' })
    const pending = runLogin()
    await vi.advanceTimersByTimeAsync(5_000)
    await pending
    expect(saveCredentials).toHaveBeenCalledTimes(1)
    expect(process.exitCode).not.toBe(1)
  })
})
