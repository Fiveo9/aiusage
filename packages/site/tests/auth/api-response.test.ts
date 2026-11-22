import { describe, expect, it } from 'vitest'
import { readApiResponse } from '../../src/lib/api-response.js'

describe('site API response parsing', () => {
  it.each([403, 413, 502])('preserves HTTP %s when a proxy returns text instead of JSON', async status => {
    expect(await readApiResponse(new Response('synthetic proxy response', { status }))).toEqual({ error: `HTTP ${status}` })
  })
  it('normalizes framework and nested API errors', async () => {
    expect(await readApiResponse(Response.json({ message: 'synthetic failure' }, { status: 400 }))).toMatchObject({ error: 'synthetic failure' })
    expect(await readApiResponse(Response.json({ error: { code: 'synthetic_code', message: 'synthetic failure' } }, { status: 400 }))).toMatchObject({ error: 'synthetic failure' })
  })
  it('rejects malformed successful responses instead of inventing empty state', async () => {
    await expect(readApiResponse(new Response('not json'))).rejects.toThrow('Invalid server response')
  })
})
