import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ postgres: vi.fn(), end: vi.fn(), query: vi.fn(), send: vi.fn(), destroy: vi.fn(),
  client: vi.fn(), env: { R2_ACCOUNT_ID: 'fixture-account', R2_ACCESS_KEY_ID: 'fixture-access', R2_SECRET_ACCESS_KEY: 'fixture-secret' } }))
vi.mock('postgres', () => ({ default: mocks.postgres }))
vi.mock('node:fs', () => ({ existsSync: () => false, readFileSync: () => { throw new Error('Environment files must not be read') } }))
vi.mock('$env/dynamic/private', () => ({ env: mocks.env }))
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: mocks.client,
  PutObjectCommand: vi.fn(input => input), DeleteObjectCommand: vi.fn(input => input) }))
import { closeSql, poolMax, sql } from '../../src/lib/server/db/pool.js'
import { closeSiteResources } from '../../src/lib/server/resource-lifecycle.js'
import { uploadFile } from '../../src/lib/server/storage/r2.js'

beforeEach(async () => {
  await closeSiteResources()
  await closeSql()
  vi.clearAllMocks()
  mocks.end.mockResolvedValue(undefined)
  mocks.query.mockResolvedValue([])
  mocks.postgres.mockReturnValue(Object.assign(mocks.query, { end: mocks.end }))
  mocks.send.mockResolvedValue({})
  mocks.client.mockImplementation(() => ({ send: mocks.send, destroy: mocks.destroy }))
  mocks.env.R2_ACCOUNT_ID = 'fixture-account'
  vi.stubEnv('DATABASE_URL', 'postgres://fixture@localhost/fixture')
})
afterEach(async () => { await closeSiteResources(); await closeSql(); vi.unstubAllEnvs() })

describe('F20 Site pooled resource lifecycle', () => {
  it.each([undefined, '', 'no-number', '0', '-1', '1.5', '1001'])('uses a bounded default for invalid pool maximum %s', (value) => {
    expect(poolMax(value)).toBe(10)
  })
  it('does not initialize a connection just to close it', async () => {
    await sql.end()
    expect(mocks.postgres).not.toHaveBeenCalled()
  })
  it('reuses the configured pool and closes it once at the resource shutdown boundary', async () => {
    vi.stubEnv('DATABASE_POOL_MAX', '32')
    await sql`SELECT 1`
    await sql`SELECT 2`
    expect(mocks.postgres).toHaveBeenCalledTimes(1)
    expect(mocks.postgres.mock.calls[0][1]).toMatchObject({ max: 32, idle_timeout: 20, connect_timeout: 10 })
    await closeSiteResources()
    await closeSiteResources()
    expect(mocks.end).toHaveBeenCalledTimes(1)
  })
  it('reuses an R2 client for multiple uploads and destroys it at shutdown', async () => {
    await uploadFile('fixture/one', Buffer.from('one'), 'text/plain')
    await uploadFile('fixture/two', Buffer.from('two'), 'text/plain')
    expect(mocks.client).toHaveBeenCalledTimes(1)
    expect(mocks.send).toHaveBeenCalledTimes(2)
    await closeSiteResources()
    expect(mocks.destroy).toHaveBeenCalledTimes(1)
  })
  it('does not reuse a destroyed client after a replacement constructor fails', async () => {
    await uploadFile('fixture/one', Buffer.from('one'), 'text/plain')
    mocks.env.R2_ACCOUNT_ID = 'replacement-account'
    mocks.client.mockImplementationOnce(() => { throw new Error('Constructor unavailable') })
    await expect(uploadFile('fixture/two', Buffer.from('two'), 'text/plain')).rejects.toThrow('Constructor unavailable')
    mocks.env.R2_ACCOUNT_ID = 'fixture-account'
    await uploadFile('fixture/three', Buffer.from('three'), 'text/plain')
    expect(mocks.client).toHaveBeenCalledTimes(3)
    await closeSiteResources()
    expect(mocks.destroy).toHaveBeenCalledTimes(2)
  })
})
