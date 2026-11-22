import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
const faults = vi.hoisted(() => ({ configAudit: false, alias: false }))
vi.mock('../../src/lib/server/db/pool.js', async () => {
  const { sql } = await import('../helpers/pglite-sql.js')
  function wrap(tag: any): any {
    const wrapped = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('')
      if (faults.configAudit && text.includes('INSERT INTO admin_audit_logs')) throw new Error('synthetic audit failure')
      if (faults.alias && text.includes('INSERT INTO model_price_aliases')) throw new Error('synthetic alias failure')
      return tag(strings, ...values)
    }
    return Object.assign(wrapped, { begin: (fn: (tx: any) => Promise<unknown>) => tag.begin((tx: any) => fn(wrap(tx))) })
  }
  return { sql: wrap(sql) }
})
import { banUser, setUserRole, addPriceEntry, updatePriceEntries, deletePriceEntry } from '../../src/lib/server/admin/operations.js'
import { PUT as saveConfig } from '../../src/routes/api/admin/config/+server.js'
import { GET as users } from '../../src/routes/api/admin/users/+server.js'
import { CFG, CONFIG_BOUNDS, getDefaultValue, isValidConfigValue, invalidateConfigCache } from '../../src/lib/server/config.js'
import { migrateTestDatabase, query, truncate } from '../helpers/pglite-sql.js'

const admin = { id: 'admin-one', username: 'admin-one', email: 'one@example.test', display_name: 'One', avatar_url: null, role: 'admin', status: 'active' }
function event(path: string, body?: unknown) {
  const url = new URL(`https://service.invalid${path}`)
  return { url, locals: { user: admin }, request: new Request(url, body === undefined ? undefined : { method: 'PUT', body: JSON.stringify(body) }) } as any
}
beforeAll(() => migrateTestDatabase(), 15_000)
beforeEach(async () => {
  faults.configAudit = false; faults.alias = false
  invalidateConfigCache()
  await truncate('users', 'site_config', 'model_prices', 'model_price_aliases')
  await query("INSERT INTO users (id,username,email,display_name,role) VALUES ('admin-one','admin-one','one@example.test','One','admin'),('admin-two','admin-two','two@example.test','Two','admin')")
})

describe('admin boundaries', () => {
  it('defines a valid integral range for every supported configuration key', () => {
    expect(Object.keys(CONFIG_BOUNDS).sort()).toEqual(Object.values(CFG).sort())
    for (const key of Object.values(CFG)) expect(isValidConfigValue(key, getDefaultValue(key))).toBe(true)
  })
  it('rejects self-ban before writing', async () => {
    await expect(banUser('admin-one', 'admin-one', 'synthetic')).rejects.toMatchObject({ status: 403 })
    expect((await query("SELECT status FROM users WHERE id='admin-one'"))[0].status).toBe('active')
  })

  it.each(['ban', 'role'])('preserves an active administrator under competing %s operations', async mode => {
    const change = (actor: string, target: string) => mode === 'ban' ? banUser(actor, target, 'synthetic') : setUserRole(actor, target, 'user')
    const results = await Promise.allSettled([change('admin-one', 'admin-two'), change('admin-two', 'admin-one')])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(Number((await query("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND status='active'"))[0].count)).toBe(1)
  })

  it.each([[], { [CFG.AVATAR_QUALITY]: -1 }, { [CFG.CLOUD_SYNC_GLOBALLY_ENABLED]: 2 }, { [CFG.PASSWORD_MIN_LENGTH]: '8' }, { unknown: 1 }])('rejects invalid configuration sets %j', async configs => {
    const response = await saveConfig(event('/api/admin/config', { configs })) as Response
    expect(response.status).toBe(400)
    expect(await query('SELECT key FROM site_config')).toHaveLength(0)
  })

  it('rejects inverted username length bounds without any partial writes', async () => {
    const response = await saveConfig(event('/api/admin/config', { configs: { [CFG.USERNAME_MIN_LENGTH]: 20, [CFG.USERNAME_MAX_LENGTH]: 10 } })) as Response
    expect(response.status).toBe(400)
    expect(await query('SELECT key FROM site_config')).toHaveLength(0)
  })

  it('rolls back the configuration batch if its audit record fails', async () => {
    faults.configAudit = true
    await expect(saveConfig(event('/api/admin/config', { configs: { [CFG.AVATAR_QUALITY]: 85 } }))).rejects.toThrow('synthetic audit failure')
    expect(await query('SELECT key FROM site_config')).toHaveLength(0)
  })

  it.each(['0', '-1', '1junk', '1.5', 'NaN'])('rejects malformed user-list limits %s', async limit => {
    await expect(users(event(`/api/admin/users?limit=${limit}`))).rejects.toMatchObject({ status: 400 })
  })

  it('escapes wildcard characters in user search', async () => {
    const response = await users(event('/api/admin/users?q=%25')) as Response
    expect((await response.json()).total).toBe(0)
  })

  it('rejects negative manual prices before writing', async () => {
    await expect(addPriceEntry('admin-one', { model_key: 'synthetic-model', input: -1, output: 1, cache_read: null, cache_write: null, currency: 'USD' })).rejects.toMatchObject({ status: 400 })
    await expect(updatePriceEntries('admin-one', [{ id: 'synthetic-model', input: 1, output: 1, cache_read: -1, cache_write: null }])).rejects.toMatchObject({ status: 400 })
    expect(await query('SELECT model_key FROM model_prices')).toHaveLength(0)
  })

  it('rolls back a price add if alias creation fails', async () => {
    faults.alias = true
    await expect(addPriceEntry('admin-one', { model_key: 'synthetic-model', input: 1, output: 1, cache_read: null, cache_write: null, currency: 'USD' })).rejects.toThrow('synthetic alias failure')
    expect(await query('SELECT model_key FROM model_prices')).toHaveLength(0)
  })

  it('deletes aliases only for the canonical entry ID, not the caller-supplied name', async () => {
    await addPriceEntry('admin-one', { model_key: 'one', input: 1, output: 1, cache_read: null, cache_write: null, currency: 'USD' })
    await addPriceEntry('admin-one', { model_key: 'two', input: 1, output: 1, cache_read: null, cache_write: null, currency: 'USD' })
    await deletePriceEntry('admin-one', 'one', 'two')
    expect((await query('SELECT model_key FROM model_price_aliases')).map(row => row.model_key)).toEqual(['two'])
  })
})
