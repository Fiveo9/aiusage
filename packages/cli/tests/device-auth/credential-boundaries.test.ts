import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { loadCredentials, hasCredentials, saveCredentials } from '../../src/device-auth/credentials.js'

vi.mock('../../src/config.js', () => ({ AIUSAGE_DIR: '/synthetic/device-credentials' }))
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => false), mkdirSync: vi.fn(), readFileSync: vi.fn(),
  writeFileSync: vi.fn(), renameSync: vi.fn(), unlinkSync: vi.fn(), chmodSync: vi.fn() }))

const valid = { device_id: 'synthetic-device', device_secret: 'synthetic-only', obtained_at: '2026-01-01T00:00:00Z' }
describe('review device credential shape boundaries', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(existsSync).mockReturnValue(false) })
  it.each([null, [], {}, { ...valid, device_id: '' }, { ...valid, device_id: 'line\nbreak' },
    { ...valid, device_secret: 1 }, { ...valid, obtained_at: 'invalid' }].map(data => [data]))('does not authorize malformed credentials %j', data => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(data))
    expect(loadCredentials()).toBeNull()
    expect(hasCredentials()).toBe(false)
  })
  it('preserves valid historical credential fields', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(valid))
    expect(loadCredentials()).toEqual(valid)
    expect(hasCredentials()).toBe(true)
  })
  it('creates the credential directory with private permissions', () => {
    saveCredentials(valid)
    expect(mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true, mode: 0o700 })
  })
})
