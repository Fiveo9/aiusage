import { describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/db/pool.js', () => ({
  sql: async (strings: TemplateStringsArray) => {
    const query = strings.join('?')
    if (query.includes('FROM cloud_sync_resets')) return [{ sync_generation: 1 }]
    if (query.includes('FROM cloud_usage_records')) return [{
      record_id: 'r1', session_key: 'key', session_title: '远端会话标题',
      device_instance_id: 'other-device', change_seq: 1, updated_at: 10,
    }]
    return []
  },
}))
vi.mock('$lib/server/auth/device-request.js', () => ({ verifyDeviceRequest: async () => ({ valid: true, userId: 'user', deviceId: 'device' }) }))
vi.mock('$lib/server/config.js', () => ({ CFG: {}, getConfigValue: async () => 100 }))
vi.mock('$lib/server/cloud/star-check.js', () => ({ checkCloudSyncAccess: async () => ({ allowed: true }) }))

import { GET } from '../../src/routes/api/cli/sync/pull/+server.js'

describe('cloud pull session titles', () => {
  it('returns the saved title with the session and owning device', async () => {
    const url = new URL('http://localhost/api/cli/sync/pull')
    const response = await GET({ url, request: new Request(url) } as Parameters<typeof GET>[0])
    expect(response.status).toBe(200)
    expect((await response.json()).records[0]).toMatchObject({
      sessionTitle: '远端会话标题', sessionKey: 'key', deviceInstanceId: 'other-device',
    })
  })
})
