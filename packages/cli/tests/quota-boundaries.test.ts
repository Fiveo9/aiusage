import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { queryClaudeCodeQuota, queryCodexQuota, queryCopilotQuota } from '../src/quota.js'

vi.mock('node:os', () => ({ homedir: () => '/synthetic-home', platform: () => 'win32' }))
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => true), readFileSync: vi.fn() }))

const queries = [
  [queryClaudeCodeQuota, { claudeAiOauth: { accessToken: 'synthetic-only' } }],
  [queryCodexQuota, { auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-only' } }],
  [queryCopilotQuota, { 'github.com': { oauth_token: 'synthetic-only' } }],
] as const

describe('review quota malformed responses and Windows paths', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(existsSync).mockReturnValue(true) })
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
  it.each([queryClaudeCodeQuota, queryCodexQuota])('treats null credential JSON as parse_error without a request', async query => {
    vi.mocked(readFileSync).mockReturnValue('null')
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(query()).resolves.toMatchObject({ credentialStatus: 'parse_error', success: false })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(queries)('handles a null API response for %s', async (query, credentials) => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(credentials))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('null', { status: 200 })))
    await expect(query()).resolves.toMatchObject({ success: false, error: 'Failed to parse API response' })
  })
  it.each(queries)('cancels an unauthorized response body for %s', async (query, credentials) => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(credentials))
    const cancel = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401, ok: false, body: { cancel } }))
    await expect(query()).resolves.toMatchObject({ credentialStatus: 'expired', success: false })
    expect(cancel).toHaveBeenCalledOnce()
  })
  it.each(['not-a-time', 1e100, -1e100])('ignores an invalid Codex reset_at %j', async reset_at => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(queries[1][1]))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at } } })))
    await expect(queryCodexQuota()).resolves.toMatchObject({ success: true, tiers: [{ utilization: 25, resetsAt: null }] })
  })
  it('falls back to entitlement/remaining for Copilot percent_remaining=null', async () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(queries[2][1]))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 75, percent_remaining: null } } })))
    expect((await queryCopilotQuota()).tiers).toEqual([{ name: 'premium_interactions', utilization: 25, resetsAt: null }])
  })
  it('reads the Windows LOCALAPPDATA Copilot path before the portable fallback', async () => {
    const localRoot = 'C:/synthetic-local'
    vi.stubEnv('LOCALAPPDATA', localRoot)
    const expected = join(localRoot, 'github-copilot', 'apps.json')
    vi.mocked(existsSync).mockImplementation(file => file === expected)
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(queries[2][1]))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ quota_snapshots: {} })))
    expect((await queryCopilotQuota()).success).toBe(true)
    expect(readFileSync).toHaveBeenCalledWith(expected, 'utf-8')
  })
})
