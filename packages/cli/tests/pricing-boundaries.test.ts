import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { getBasePriceTable, getUserOverrides, resolvePrice, setRuntimePriceTable, type StatsRecord } from '@aiusage/core'
import { initializeDatabase } from '../src/db/index.js'
import { insertRecord } from '../src/db/records.js'
import { recalcPricing } from '../src/commands/recalc.js'
import { createRegistryPriceLookup, listLocalModelBindings, listPricingModels, loadPricingRuntime, setUserPricingAlias } from '../src/pricing-registry.js'

const originalBase = getBasePriceTable()
const originalOverrides = getUserOverrides()
function record(id: string, model: string, cost = 0, costSource: StatsRecord['costSource'] = 'unknown'): StatsRecord {
  return { id, model, cost, costSource, ts: 1000, ingestedAt: 1000, updatedAt: 1000, lineOffset: 0,
    tool: 'claude-code', provider: 'synthetic', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, thinkingTokens: 0, sessionId: id, sourceFile: 'synthetic.jsonl', device: 'Synthetic', deviceInstanceId: 'synthetic-instance' }
}

describe('review pricing consistency', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })
  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
    setRuntimePriceTable(originalBase, originalOverrides)
  })
  function price(model: string, input = 2, origin = 'builtin'): void {
    db.prepare(`INSERT INTO model_prices (model_key, provider, input, output, currency, source, origin, status, created_at, updated_at)
      VALUES (?, 'synthetic', ?, 4, 'USD', 'synthetic', ?, 'active', 1, 1)`).run(model, input, origin)
  }
  function copied(id: string, model: string, cost: number, costSource: StatsRecord['costSource']): void {
    insertRecord(db, record(id, model, cost, costSource))
    db.prepare("UPDATE records SET origin = 'synced' WHERE id = ?").run(id)
    db.prepare(`INSERT INTO synced_records (id, ts, tool, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens,
      cost, cost_source, updated_at, session_key, source_file, cwd, device, device_instance_id, platform)
      VALUES (?, 1000, 'claude-code', ?, 'synthetic', 1000000, 0, 0, 0, 0, ?, ?, 1000, ?, 'synthetic.jsonl', '', 'Synthetic', 'synthetic-instance', '')`).run(id, model, cost, costSource, id)
  }
  const costs = (db: Database.Database, table: string) => db.prepare(`SELECT cost, cost_source FROM ${table} ORDER BY id`).all()

  it('preserves synced positive cost when the local registry has no price', async () => {
    copied('remote', 'synthetic-unpriced', 7, 'pricing')
    await recalcPricing(db)
    expect(costs(db, 'records')).toEqual([{ cost: 7, cost_source: 'pricing' }])
    expect(costs(db, 'records')).toEqual(costs(db, 'synced_records'))
  })
  it('preserves synced authoritative logged cost even with a local user price', async () => {
    price('synthetic-model', 2, 'user')
    copied('remote', 'synthetic-model', 7, 'log')
    await recalcPricing(db)
    expect(costs(db, 'records')).toEqual([{ cost: 7, cost_source: 'log' }])
    expect(costs(db, 'records')).toEqual(costs(db, 'synced_records'))
  })
  it('advances a changed local price past every prior acknowledgement', async () => {
    price('synthetic-model')
    insertRecord(db, record('local', 'synthetic-model'))
    db.prepare('UPDATE records SET updated_at = 8000, synced_at = 7000 WHERE id = ?').run('local')
    db.prepare('INSERT INTO sync_record_state (target, record_id, synced_at) VALUES (?, ?, ?)').run('synthetic', 'local', 9000)
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    await recalcPricing(db)
    expect(db.prepare('SELECT updated_at FROM records WHERE id = ?').get('local')).toEqual({ updated_at: 9001 })
  })

  it.each(['glink/synthetic-model-20270101', 'GLINK/SYNTHETIC-MODEL-20270101', 'SYNTHETIC-MODEL'])('uses the same price and binding for %s at all four entry points', model => {
    price('synthetic-model')
    insertRecord(db, record('local', model))
    loadPricingRuntime(db)
    expect(resolvePrice(model)).toMatchObject({ input: 2, output: 4 })
    expect(createRegistryPriceLookup(db).price(model)).toMatchObject({ input: 2, output: 4 })
    expect(listPricingModels(db).find(row => row.model === model)?.price).toMatchObject({ input: 2, output: 4 })
    expect(listLocalModelBindings(db).find(row => row.model === model)).toMatchObject({ modelKey: 'synthetic-model', hasPrice: true })
  })
  it('resolves a prefixed/case-varied exact alias without requiring a fake price row', () => {
    price('synthetic-target', 3)
    setUserPricingAlias(db, 'synthetic-alias', 'synthetic-target')
    const model = 'GLINK/SYNTHETIC-ALIAS'
    insertRecord(db, record('local', model))
    loadPricingRuntime(db)
    expect(resolvePrice(model)).toMatchObject({ input: 3 })
    expect(createRegistryPriceLookup(db).price(model)).toMatchObject({ input: 3 })
    expect(listPricingModels(db).find(row => row.model === model)?.price).toMatchObject({ input: 3 })
    expect(listLocalModelBindings(db).find(row => row.model === model)).toMatchObject({ modelKey: 'synthetic-target', hasPrice: true })
  })
  it('honors exact alias match_type rather than accidentally using it as a prefix', () => {
    price('synthetic-target', 3)
    setUserPricingAlias(db, 'synthetic-alias', 'synthetic-target')
    const model = 'synthetic-alias-suffix'
    insertRecord(db, record('local', model))
    loadPricingRuntime(db)
    expect(resolvePrice(model)).toBeUndefined()
    expect(createRegistryPriceLookup(db).price(model)).toBeUndefined()
    expect(listLocalModelBindings(db).find(row => row.model === model)).toMatchObject({ modelKey: null, hasPrice: false })
  })
  it('honors a prefix alias consistently in runtime, registry and UI', () => {
    price('synthetic-target', 3)
    setUserPricingAlias(db, 'synthetic-alias', 'synthetic-target')
    db.prepare("UPDATE model_price_aliases SET match_type = 'prefix' WHERE alias = ?").run('synthetic-alias')
    const model = 'synthetic-alias-suffix'
    insertRecord(db, record('local', model))
    loadPricingRuntime(db)
    expect(resolvePrice(model)).toMatchObject({ input: 3 })
    expect(createRegistryPriceLookup(db).price(model)).toMatchObject({ input: 3 })
    expect(listPricingModels(db).find(row => row.model === model)?.price).toMatchObject({ input: 3 })
    expect(listLocalModelBindings(db).find(row => row.model === model)).toMatchObject({ modelKey: 'synthetic-target', hasPrice: true })
  })
  it('an exact alias does not hide the original real price for a suffixed model', () => {
    price('synthetic-target', 3)
    price('synthetic-alias', 1)
    setUserPricingAlias(db, 'synthetic-alias', 'synthetic-target')
    const model = 'synthetic-alias-suffix'
    insertRecord(db, record('local', model))
    loadPricingRuntime(db)
    expect(resolvePrice('synthetic-alias')).toMatchObject({ input: 3 })
    expect(resolvePrice(model)).toMatchObject({ input: 1 })
    expect(createRegistryPriceLookup(db).price(model)).toMatchObject({ input: 1 })
    expect(listPricingModels(db).find(row => row.model === model)?.price).toMatchObject({ input: 1 })
    expect(listLocalModelBindings(db).find(row => row.model === model)).toMatchObject({ modelKey: 'synthetic-alias', matchType: 'prefix' })
  })
  it('shows the real direct-user price key when an unused manual alias also exists', () => {
    price('synthetic-target', 3)
    setUserPricingAlias(db, 'synthetic-alias', 'synthetic-target')
    price('synthetic-alias', 5, 'user')
    insertRecord(db, record('local', 'synthetic-alias'))
    loadPricingRuntime(db)
    expect(resolvePrice('synthetic-alias')).toMatchObject({ input: 5 })
    expect(createRegistryPriceLookup(db).price('synthetic-alias')).toMatchObject({ input: 5 })
    expect(listLocalModelBindings(db).find(row => row.model === 'synthetic-alias')).toMatchObject({ modelKey: 'synthetic-alias', bindingType: 'custom' })
  })
})
