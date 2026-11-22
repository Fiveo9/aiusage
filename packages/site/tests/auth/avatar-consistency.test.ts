import { beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
const state = vi.hoisted(() => ({ actions: [] as string[], uploadFailure: false, databaseFailure: false }))
vi.mock('../../src/lib/server/db/pool.js', () => {
  const sql: any = async (strings: TemplateStringsArray) => {
    const text = strings.join('')
    if (text.includes('SELECT avatar_url')) return [{ avatar_url: 'https://cdn.invalid/avatars/owner/old.webp', status: 'active' }]
    if (text.includes('UPDATE users')) {
      state.actions.push('database')
      if (state.databaseFailure) throw new Error('synthetic database failure')
    }
    return []
  }
  sql.begin = (fn: (tx: any) => Promise<unknown>) => fn(sql)
  return { sql }
})
vi.mock('../../src/lib/server/storage/r2.js', () => ({
  uploadFile: async () => { state.actions.push('upload'); if (state.uploadFailure) throw new Error('synthetic upload failure'); return 'https://cdn.invalid/avatars/owner/new.webp' },
  deleteFile: async (key: string) => { state.actions.push(`retire:${key}`) },
  extractKeyFromUrl: (url: string, prefix: string) => { const key = new URL(url).pathname.slice(1); return key.startsWith(prefix) ? key : null },
}))
import { POST, DELETE } from '../../src/routes/api/me/avatar/+server.js'
const user = { id: 'owner', username: 'owner', email: 'owner@example.test', display_name: 'Owner', avatar_url: null, role: 'user', status: 'active' }
async function event() {
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }).png().toBuffer()
  const data = new FormData(); data.set('avatar', new File([new Uint8Array(bytes)], 'synthetic.png', { type: 'image/png' }))
  return { locals: { user }, request: new Request('https://service.invalid/api/me/avatar', { method: 'POST', body: data }) } as any
}
beforeEach(() => { state.actions = []; state.uploadFailure = false; state.databaseFailure = false; vi.spyOn(console, 'error').mockImplementation(() => {}) })
describe('avatar reference consistency', () => {
  it('does not retire the previous avatar if the new upload fails', async () => {
    state.uploadFailure = true
    expect((await POST(await event()) as Response).status).toBe(500)
    expect(state.actions).toEqual(['upload'])
  })
  it('retires only the unreferenced new object if the database update fails', async () => {
    state.databaseFailure = true
    expect((await POST(await event()) as Response).status).toBe(500)
    expect(state.actions.slice(0, 2)).toEqual(['upload', 'database'])
    expect(state.actions[2]).toMatch(/^retire:avatars\/owner\/(?!old\.webp)/)
  })
  it('retires the old avatar only after the new reference is committed', async () => {
    expect((await POST(await event()) as Response).status).toBe(200)
    expect(state.actions).toEqual(['upload', 'database', 'retire:avatars/owner/old.webp'])
  })
  it('clears the reference before retiring an explicitly removed avatar', async () => {
    await DELETE(await event())
    expect(state.actions).toEqual(['database', 'retire:avatars/owner/old.webp'])
  })
})
