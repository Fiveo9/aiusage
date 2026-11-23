import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitHubDeviceSessions } from '../../src/github/device-sessions.js'
import { startDeviceAuthorization } from '../../src/github/auth.js'

vi.mock('../../src/github/auth.js', () => ({
  GitHubAuthError: class GitHubAuthError extends Error {},
  appSettings: () => ({ installUrl: 'https://github.example/install' }),
  startDeviceAuthorization: vi.fn(async () => ({ userCode: 'SYNTHETIC', verificationUrl: 'https://github.example/device', expiresAt: Date.now() + 900000 })),
  pollDeviceAuthorization: vi.fn(async () => ({ method: 'github-app', accessToken: 'synthetic-only' })),
  githubApi: vi.fn(async () => ({ login: 'synthetic-user' })),
  installationRepositories: vi.fn(async () => [{ repo: 'owner/data', branch: 'main' }]),
  connectRepository: vi.fn(),
}))
vi.mock('../../src/commands/init.js', () => ({ runInit: vi.fn(() => ({ success: true })) }))

describe('review GitHub device session timer ownership', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks() })
  afterEach(() => vi.useRealTimers())
  it('clears the expiry timer on explicit cancellation', async () => {
    const sessions = createGitHubDeviceSessions()
    const { sessionId } = await sessions('start', {})
    expect(vi.getTimerCount()).toBe(1)
    await sessions('cancel', { sessionId })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('clears the expiry timer after connecting a repository', async () => {
    const sessions = createGitHubDeviceSessions()
    const { sessionId } = await sessions('start', {})
    await sessions('poll', { sessionId })
    await sessions('connect', { sessionId, repo: 'owner/data' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('clears a reserved slot timer after start fails', async () => {
    vi.mocked(startDeviceAuthorization).mockRejectedValueOnce(new Error('synthetic network failure'))
    const sessions = createGitHubDeviceSessions()
    await expect(sessions('start', {})).rejects.toThrow('synthetic network failure')
    expect(vi.getTimerCount()).toBe(0)
  })
})
