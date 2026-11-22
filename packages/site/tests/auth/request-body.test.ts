import { describe, expect, it, vi } from 'vitest'
vi.mock('../../src/lib/server/db/schema.js', () => ({ runMigrations: async () => {} }))
vi.mock('../../src/lib/server/db/cleanup.js', () => ({ startCleanupCron: () => {} }))
vi.mock('../../src/lib/server/auth/session.js', () => ({ getUserFromEvent: async () => null, getSessionDurationMs: async () => 604800000 }))
vi.mock('../../src/lib/server/config.js', () => ({ CFG: { SYNC_BODY_MAX_SIZE: 'sync', AVATAR_MAX_FILE_SIZE: 'avatar' }, getConfigValue: async () => 128 }))
import { readLimitedBuffer, readLimitedJson, readLimitedText } from '../../src/lib/server/request-body.js'
import { handle } from '../../src/hooks.server.js'

function input(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request('https://service.invalid/api/me/profile', { method: 'POST', body, headers, duplex: 'half' } as any)
}

describe('bounded request bodies', () => {
  it('assembles split UTF-8 at the exact byte boundary', async () => {
    const bytes = new TextEncoder().encode('{"value":"中文"}')
    const stream = new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
      controller.close()
    } })
    expect(await readLimitedJson(input(stream), bytes.length)).toEqual({ value: '中文' })
  })

  it('rejects declared oversize without starting a read', async () => {
    await expect(readLimitedBuffer(input('{}', { 'content-length': '129' }), 128)).rejects.toMatchObject({ status: 413 })
  })

  it('counts actual UTF-8 bytes instead of string characters', async () => {
    await expect(readLimitedText(input('中'.repeat(10)), 20)).rejects.toMatchObject({ status: 413 })
  })

  it.each(['null', '[]', '1', 'true', '{'])('rejects non-object or malformed JSON %s', async body => {
    await expect(readLimitedJson(input(body))).rejects.toMatchObject({ status: 400 })
  })

  it('preserves the raw JSON body and headers through the global hook', async () => {
    const body = '{ "value": "中文" }'
    const token = 'a'.repeat(64)
    const request = input(body, { 'content-type': 'application/json', cookie: `csrf_token=${token}`, 'x-csrf-token': token, 'x-custom': 'kept' })
    const event = { request, url: new URL(request.url), locals: {} } as any
    const response = await handle({ event, resolve: async (next: typeof event) => {
      expect(await next.request.text()).toBe(body)
      expect(next.request.headers.get('x-custom')).toBe('kept')
      return new Response('ok')
    } } as any)
    expect(response.status).toBe(200)
  })

  it('returns 413 from the global sync body guard before the route runs', async () => {
    const request = new Request('https://service.invalid/api/cli/sync/push', { method: 'POST', body: 'x'.repeat(129) })
    const resolve = vi.fn(async () => new Response('unexpected'))
    const response = await handle({ event: { request, url: new URL(request.url), locals: {} } as any, resolve } as any)
    expect(response.status).toBe(413)
    expect(resolve).not.toHaveBeenCalled()
  })
})
