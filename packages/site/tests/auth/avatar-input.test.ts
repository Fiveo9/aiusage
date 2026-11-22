import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
vi.mock('../../src/lib/server/db/pool.js', () => ({ sql: vi.fn(async () => []) }))
vi.mock('../../src/lib/server/storage/r2.js', () => ({ uploadFile: vi.fn(), deleteFile: vi.fn(), extractKeyFromUrl: vi.fn() }))
import { POST, _processAvatarImage as processAvatarImage } from '../../src/routes/api/me/avatar/+server.js'

function crc32(input: Buffer): number {
  let crc = 0xffffffff
  for (const byte of input) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

describe('avatar input guards', () => {
  it('rejects spoofed image signatures before decoding', async () => {
    await expect(processAvatarImage(Buffer.from('not an image'), 'image/png', 64, 80)).rejects.toThrow('Invalid image signature')
  })

  it('rejects a large-pixel PNG from a tiny synthetic header', async () => {
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }).png().toBuffer()
    png.writeUInt32BE(5000, 16)
    png.writeUInt32BE(5000, 20)
    png.writeUInt32BE(crc32(png.subarray(12, 29)), 29)
    await expect(processAvatarImage(png, 'image/png', 64, 80)).rejects.toThrow(/pixel limit/i)
  })

  it('prechecks declared multipart body size before form parsing', async () => {
    const user = { id: 'owner', username: 'owner', email: 'owner@example.test', display_name: 'Owner', avatar_url: null, role: 'user', status: 'active' }
    const request = new Request('https://service.invalid/api/me/avatar', { method: 'POST', body: 'small',
      headers: { 'content-type': 'multipart/form-data; boundary=synthetic', 'content-length': '100000000' } })
    const response = await POST({ request, locals: { user } } as any) as Response
    expect(response.status).toBe(413)
  })
})
