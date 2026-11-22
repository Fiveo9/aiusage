import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
vi.mock('../../src/device-auth/credentials.js', () => ({ loadCredentials: () => ({ device_id: 'synthetic-device', device_secret: 'synthetic-test-only' }) }))
vi.mock('../../src/site-url.js', () => ({ getSiteUrl: () => 'https://service.invalid///' }))
import { cloudPush, cloudPull, cloudClear } from '../../src/sync/cloud.js'
const fetchMock = vi.fn()
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => vi.unstubAllGlobals())
describe('signed cloud transport', () => {
  it.each(['failed', 'rejected'])('refuses an explicit %s batch even if a legacy server returns HTTP 200', async status => {
    fetchMock.mockResolvedValue(Response.json({ status, record_count: 1, error_code: 'server_error' }))
    await expect(cloudPush([], [], 'synthetic-instance', 1)).rejects.toMatchObject({ code: 'server_error' })
  })
  it.each(['push', 'pull', 'clear'])('normalizes the server URL and forbids redirects for %s', async operation => {
    const data = operation === 'pull' ? { records: [], tombstones: [], has_more: false, next_cursor: null, sync_generation: 1 }
      : { status: 'accepted', inserted: 0, updated: 0, skipped: 0, sync_generation: 1 }
    fetchMock.mockResolvedValue(Response.json(data))
    if (operation === 'push') await cloudPush([], [], 'synthetic-instance', 1)
    else if (operation === 'pull') await cloudPull()
    else await cloudClear()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/^https:\/\/service\.invalid\/api\//)
    expect(init.redirect).toBe('error')
  })
  it('reports the actual package version when running as source ESM', async () => {
    fetchMock.mockResolvedValue(Response.json({ status: 'accepted', inserted: 0, updated: 0, skipped: 0, sync_generation: 1 }))
    await cloudPush([], [], 'synthetic-instance', 1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    expect(body.client_version).toBe(pkg.version)
  })
})
