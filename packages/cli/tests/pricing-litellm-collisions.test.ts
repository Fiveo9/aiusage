import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { getBasePriceTable, getUserOverrides, resolvePrice, setRuntimePriceTable } from '@aiusage/core'
import { initializeDatabase } from '../src/db/index.js'
import {
  loadPricingRuntime,
  resolvePriceFromRegistry,
  setUserPrice,
  setUserPricingAlias,
  syncPricingFromLitellm,
} from '../src/pricing-registry.js'

type Entry = Record<string, unknown>

/** A LiteLLM chat entry priced in USD per 1M tokens. */
function chat(provider: string, input: number, output: number, extra: Entry = {}): Entry {
  return {
    litellm_provider: provider,
    mode: 'chat',
    input_cost_per_token: input / 1_000_000,
    output_cost_per_token: output / 1_000_000,
    ...extra,
  }
}

describe('LiteLLM price sync key collisions (issue #92)', () => {
  let db: Database.Database
  const runtimeBase = getBasePriceTable()
  const runtimeOverrides = getUserOverrides()

  async function sync(entries: Array<[string, Entry]>) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(Object.fromEntries(entries)), { status: 200 })))
    return syncPricingFromLitellm(db)
  }

  function priceRow(modelKey: string) {
    return db.prepare('SELECT provider, input, output, source_model_id, origin FROM model_prices WHERE model_key = ?').get(modelKey) as
      { provider: string; input: number; output: number; source_model_id: string; origin: string } | undefined
  }

  function aliasTarget(alias: string): string | undefined {
    return (db.prepare('SELECT model_key FROM model_price_aliases WHERE alias = ?').get(alias) as { model_key: string } | undefined)?.model_key
  }

  function snapshot() {
    return {
      prices: db.prepare('SELECT model_key, provider, input, output, cache_read, cache_write, source_model_id FROM model_prices ORDER BY model_key').all(),
      baselines: db.prepare('SELECT model_key, provider, input, output, cache_read, cache_write, source_model_id FROM model_price_sync_baselines ORDER BY model_key').all(),
      aliases: db.prepare('SELECT alias, model_key, provider FROM model_price_aliases ORDER BY alias').all(),
    }
  }

  /** Round to cents of a dollar per 1M so per-token float noise does not matter. */
  function rounded(price: { input: number; output: number } | undefined) {
    return price && { input: Math.round(price.input * 1000) / 1000, output: Math.round(price.output * 1000) / 1000 }
  }

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    // Start from an empty registry so only the entries of each test are in play.
    db.exec('DELETE FROM model_price_aliases; DELETE FROM model_price_sync_baselines; DELETE FROM model_prices;')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    db.close()
    setRuntimePriceTable(runtimeBase, runtimeOverrides)
  })

  it('keeps the un-prefixed price when prefixed entries for the same model follow it', async () => {
    await sync([
      ['claude-haiku-4-5', chat('anthropic', 1, 5)],
      ['vertex_ai/claude-haiku-4-5', chat('vertex_ai-anthropic_models', 1, 5)],
      ['aihubmix/claude-haiku-4-5', chat('aihubmix', 1.1, 5.5)],
    ])

    expect(rounded(resolvePriceFromRegistry(db, 'claude-haiku-4-5'))).toEqual({ input: 1, output: 5 })
    expect(priceRow('claude-haiku-4-5')).toMatchObject({ provider: 'anthropic', source_model_id: 'claude-haiku-4-5' })
    expect(rounded(db.prepare('SELECT input, output FROM model_price_sync_baselines WHERE model_key = ?').get('claude-haiku-4-5') as { input: number; output: number }))
      .toEqual({ input: 1, output: 5 })
  })

  it('keeps a prefixed entry that lost the key as an alias of the key, with no price row of its own', async () => {
    await sync([
      ['claude-haiku-4-5', chat('anthropic', 1, 5)],
      ['aihubmix/claude-haiku-4-5', chat('aihubmix', 1.1, 5.5)],
    ])

    expect(priceRow('aihubmix/claude-haiku-4-5')).toBeUndefined()
    expect(aliasTarget('aihubmix/claude-haiku-4-5')).toBe('claude-haiku-4-5')
    expect(rounded(resolvePriceFromRegistry(db, 'aihubmix/claude-haiku-4-5'))).toEqual({ input: 1, output: 5 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM model_prices').get()).toEqual({ n: 1 })

    loadPricingRuntime(db)
    expect(rounded(resolvePrice('claude-haiku-4-5'))).toEqual({ input: 1, output: 5 })
    expect(rounded(resolvePrice('claude-haiku-4-5-20251001'))).toEqual({ input: 1, output: 5 })
    expect(rounded(resolvePrice('aihubmix/claude-haiku-4-5'))).toEqual({ input: 1, output: 5 })
  })

  it('adds no provider-prefixed key that could win a prefix match over a more specific model', async () => {
    await sync([
      ['glm-5', chat('zai', 1, 2)],
      ['glm-5.1', chat('zai', 3, 4)],
      ['nvidia/glm-5', chat('nvidia', 9, 10)],
    ])

    // core strips `nvidia/` and matches by longest prefix: a `nvidia/glm-5` row would
    // be longer than `glm-5.1` and price the newer model as its older sibling.
    expect(rounded(resolvePriceFromRegistry(db, 'nvidia/glm-5.1-20261001'))).toEqual({ input: 3, output: 4 })
    expect(rounded(resolvePriceFromRegistry(db, 'nvidia/glm-5'))).toEqual({ input: 1, output: 2 })
  })

  it('leaves no stale price behind when the owner of a key changes between syncs', async () => {
    await sync([
      ['mistral/mistral-large-latest', chat('mistral', 0.5, 1.5)],
      ['azure/mistral-large-latest', chat('azure', 8, 24)],
    ])
    expect(priceRow('mistral-large-latest')).toMatchObject({ provider: 'mistral' })

    await sync([
      ['mistral/mistral-large-latest', chat('mistral', 0, 0)],
      ['azure/mistral-large-latest', chat('azure', 2, 6)],
    ])

    expect(priceRow('mistral-large-latest')).toMatchObject({ provider: 'azure', input: 2 })
    for (const model of ['mistral-large-latest', 'mistral-large-latest-20261001', 'azure/mistral-large-latest', 'mistral/mistral-large-latest']) {
      expect(rounded(resolvePriceFromRegistry(db, model))).toEqual({ input: 2, output: 6 })
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM model_prices').get()).toEqual({ n: 1 })
  })

  it('stores the same registry whatever the order of the file', async () => {
    const entries: Array<[string, Entry]> = [
      ['claude-haiku-4-5', chat('anthropic', 1, 5)],
      ['aihubmix/claude-haiku-4-5', chat('aihubmix', 1.1, 5.5)],
      ['snowflake/claude-haiku-4-5', chat('snowflake', 1, 5, { cache_read_input_token_cost: 1e-7 })],
      ['azure/mistral-large-latest', chat('azure', 8, 24)],
      ['mistral/mistral-large-latest', chat('mistral', 0.5, 1.5)],
      ['azure_ai/mistral-large-latest', chat('azure_ai', 2, 6)],
      ['together_ai/meta-llama/Llama-4', chat('together_ai', 0.2, 0.2)],
      ['deepinfra/meta-llama/Llama-4', chat('deepinfra', 0.03, 0.06)],
      ['deepseek/deepseek-r1', chat('deepseek', 0.5, 2)],
      ['novita/deepseek/deepseek-r1', chat('novita', 0.7, 2.5)],
      ['claude-3-5-sonnet-20240620', chat('anthropic', 3, 15)],
      ['claude-3-5-sonnet-20241022', chat('anthropic', 3, 15)],
    ]

    await sync(entries)
    const forward = snapshot()

    db.exec('DELETE FROM model_price_aliases; DELETE FROM model_price_sync_baselines; DELETE FROM model_prices;')
    await sync([...entries].reverse())
    expect(snapshot()).toEqual(forward)

    // A second sync over an existing registry lands on the same state too.
    const again = await sync(entries)
    expect(snapshot()).toEqual(forward)
    expect(again).toMatchObject({ added: 0, updated: 0, aliasesAdded: 0, aliasesUpdated: 0 })
  })

  it('picks the model developer over clouds and hosts when no un-prefixed entry exists', async () => {
    await sync([
      ['azure/mistral-large-latest', chat('azure', 8, 24)],
      ['mistral/mistral-large-latest', chat('mistral', 0.5, 1.5)],
      ['azure_ai/mistral-large-latest', chat('azure_ai', 2, 6)],
    ])

    expect(rounded(resolvePriceFromRegistry(db, 'mistral-large-latest'))).toEqual({ input: 0.5, output: 1.5 })
    expect(priceRow('mistral-large-latest')).toMatchObject({ provider: 'mistral', source_model_id: 'mistral/mistral-large-latest' })
    // Every full id is an alias of the key, as before, and resolves to the owner's price.
    for (const id of ['mistral/mistral-large-latest', 'azure/mistral-large-latest', 'azure_ai/mistral-large-latest']) {
      expect(aliasTarget(id)).toBe('mistral-large-latest')
      expect(priceRow(id)).toBeUndefined()
      expect(rounded(resolvePriceFromRegistry(db, id))).toEqual({ input: 0.5, output: 1.5 })
    }
  })

  it('ranks a reseller with its own rates behind every other provider', async () => {
    await sync([
      ['aihubmix/kimi-k9', chat('aihubmix', 1.1, 4.4, { cache_read_input_token_cost: 1e-7 })],
      ['nebius/kimi-k9', chat('nebius', 1, 4)],
      ['aihubmix/only-resold', chat('aihubmix', 2, 6)],
    ])

    expect(priceRow('kimi-k9')).toMatchObject({ provider: 'nebius' })
    expect(priceRow('only-resold')).toMatchObject({ provider: 'aihubmix' })
  })

  it('prefers an entry that prices cache reads among providers of equal standing', async () => {
    await sync([
      ['deepinfra/anthropic/claude-x', chat('deepinfra', 3.3, 16.5)],
      ['vercel_ai_gateway/anthropic/claude-x', chat('vercel_ai_gateway', 3, 15, { cache_read_input_token_cost: 3e-7 })],
      // The developer still wins without a cache price.
      ['azure_ai/grok-9', chat('azure_ai', 1, 2, { cache_read_input_token_cost: 1e-7 })],
      ['xai/grok-9', chat('xai', 3, 15)],
    ])

    expect(priceRow('anthropic/claude-x')).toMatchObject({ provider: 'vercel_ai_gateway', input: 3 })
    expect(resolvePriceFromRegistry(db, 'anthropic/claude-x')?.cacheRead).toBeCloseTo(0.3)
    expect(priceRow('grok-9')).toMatchObject({ provider: 'xai' })
  })

  it('breaks a tie between providers of equal standing by provider name', async () => {
    await sync([
      ['together_ai/meta-llama/Llama-4', chat('together_ai', 0.2, 0.2)],
      ['nebius/meta-llama/Llama-4', chat('nebius', 0.1, 0.1)],
      ['deepinfra/meta-llama/Llama-4', chat('deepinfra', 0.03, 0.06)],
    ])

    expect(priceRow('meta-llama/Llama-4')).toMatchObject({ provider: 'deepinfra', source_model_id: 'deepinfra/meta-llama/Llama-4' })
    expect(rounded(resolvePriceFromRegistry(db, 'together_ai/meta-llama/Llama-4'))).toEqual({ input: 0.03, output: 0.06 })
  })

  it('does not let an entry priced at zero take a key from an entry with a real price', async () => {
    await sync([
      ['command-a-plus', chat('cohere_chat', 0, 0)],
      ['aihubmix/command-a-plus', chat('aihubmix', 2.5, 10)],
      ['gemini/gemma-9', chat('gemini', 0, 0)],
      ['vertex_ai/gemma-9', chat('vertex_ai', 0.15, 0.6)],
      ['free-everywhere', chat('ollama', 0, 0)],
      ['codestral/free-everywhere', chat('codestral', 0, 0)],
    ])

    expect(rounded(resolvePriceFromRegistry(db, 'command-a-plus'))).toEqual({ input: 2.5, output: 10 })
    expect(priceRow('command-a-plus')).toMatchObject({ provider: 'aihubmix', source_model_id: 'aihubmix/command-a-plus' })
    expect(priceRow('aihubmix/command-a-plus')).toBeUndefined()
    expect(aliasTarget('aihubmix/command-a-plus')).toBe('command-a-plus')
    expect(rounded(resolvePriceFromRegistry(db, 'gemma-9'))).toEqual({ input: 0.15, output: 0.6 })
    expect(rounded(resolvePriceFromRegistry(db, 'gemini/gemma-9'))).toEqual({ input: 0.15, output: 0.6 })
    // With nothing but free entries the un-prefixed one still owns the key.
    expect(priceRow('free-everywhere')).toMatchObject({ provider: 'ollama', input: 0, output: 0 })
  })

  it('lets a full id own its key against entries that only reduce to it', async () => {
    await sync([
      ['novita/deepseek/deepseek-r1', chat('novita', 0.7, 2.5)],
      ['deepseek/deepseek-r1', chat('deepseek', 0.5, 2)],
      ['vercel_ai_gateway/deepseek/deepseek-r1', chat('vercel_ai_gateway', 0.8, 3)],
    ])

    expect(priceRow('deepseek-r1')).toMatchObject({ provider: 'deepseek', input: 0.5 })
    expect(priceRow('deepseek/deepseek-r1')).toMatchObject({ provider: 'deepseek', source_model_id: 'deepseek/deepseek-r1' })
    expect(aliasTarget('deepseek/deepseek-r1')).toBe('deepseek/deepseek-r1')
    expect(rounded(resolvePriceFromRegistry(db, 'deepseek/deepseek-r1'))).toEqual({ input: 0.5, output: 2 })
    expect(aliasTarget('novita/deepseek/deepseek-r1')).toBe('deepseek/deepseek-r1')
    expect(rounded(resolvePriceFromRegistry(db, 'novita/deepseek/deepseek-r1'))).toEqual({ input: 0.5, output: 2 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM model_prices').get()).toEqual({ n: 2 })
  })

  it('leaves an uncontested prefixed entry where it was: one row under the short key', async () => {
    const summary = await sync([
      ['xai/grok-9', chat('xai', 3, 15)],
      ['ignored-image-model', { litellm_provider: 'openai', mode: 'image_generation', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 }],
    ])

    expect(priceRow('grok-9')).toMatchObject({ provider: 'xai', source_model_id: 'xai/grok-9' })
    expect(priceRow('xai/grok-9')).toBeUndefined()
    expect(aliasTarget('xai/grok-9')).toBe('grok-9')
    expect(aliasTarget('grok-9')).toBe('grok-9')
    expect(summary).toMatchObject({ added: 1, updated: 0, unchanged: 0, skipped: 1, aliasesAdded: 2 })
  })

  it('never points the dated Claude shortcut at a dated snapshot when the short name has its own price', async () => {
    await sync([
      ['claude-haiku-4-5', chat('anthropic', 1, 5)],
      ['claude-haiku-4-5-20251001', chat('anthropic', 2, 10)],
      ['claude-3-5-sonnet-20241022', chat('anthropic', 3, 15)],
      ['claude-3-5-sonnet-20240620', chat('anthropic', 4, 20)],
    ])

    expect(aliasTarget('claude-haiku-4-5')).toBe('claude-haiku-4-5')
    expect(rounded(resolvePriceFromRegistry(db, 'claude-haiku-4-5'))).toEqual({ input: 1, output: 5 })
    // Without a price of its own the short name follows the newest snapshot.
    expect(aliasTarget('claude-3-5-sonnet')).toBe('claude-3-5-sonnet-20241022')
    expect(rounded(resolvePriceFromRegistry(db, 'claude-3-5-sonnet'))).toEqual({ input: 3, output: 15 })
  })

  it('keeps the dated Claude shortcut off a name whose price the file does not list', async () => {
    const now = Date.now()
    // A curated price (source 'aiusage') that the LiteLLM file does not list.
    db.prepare(`
      INSERT INTO model_prices (
        model_key, provider, input, output, cache_read, cache_write, currency, source, source_model_id,
        source_url, origin, status, last_synced_at, created_at, updated_at
      ) VALUES ('claude-opus-9', 'anthropic', 4, 20, NULL, NULL, 'USD', 'aiusage', 'claude-opus-9', NULL, 'builtin', 'active', NULL, ?, ?)
    `).run(now, now)
    await sync([['claude-opus-9-20270101', chat('anthropic', 9, 45)]])

    expect(aliasTarget('claude-opus-9')).toBe('claude-opus-9')
    expect(rounded(resolvePriceFromRegistry(db, 'claude-opus-9'))).toEqual({ input: 4, output: 20 })
    expect(rounded(resolvePriceFromRegistry(db, 'claude-opus-9-20270101'))).toEqual({ input: 9, output: 45 })
    loadPricingRuntime(db)
    expect(rounded(resolvePrice('claude-opus-9'))).toEqual({ input: 4, output: 20 })

    // The shortcut an earlier sync wrote over that name is repaired, once.
    db.prepare("UPDATE model_price_aliases SET model_key = 'claude-opus-9-20270101' WHERE alias = 'claude-opus-9'").run()
    expect(rounded(resolvePriceFromRegistry(db, 'claude-opus-9'))).toEqual({ input: 9, output: 45 })
    const repaired = await sync([['claude-opus-9-20270101', chat('anthropic', 9, 45)]])
    expect(repaired.aliasesUpdated).toBe(1)
    expect(rounded(resolvePriceFromRegistry(db, 'claude-opus-9'))).toEqual({ input: 4, output: 20 })
    expect((await sync([['claude-opus-9-20270101', chat('anthropic', 9, 45)]])).aliasesUpdated).toBe(0)
  })

  it('uses one of two ids that differ only in surrounding whitespace, whatever their order', async () => {
    const entries: Array<[string, Entry]> = [
      [' x/model-w', chat('x', 1, 2)],
      ['x/model-w ', chat('x', 3, 4)],
    ]
    const first = await sync(entries)
    const forward = snapshot()
    db.exec('DELETE FROM model_price_aliases; DELETE FROM model_price_sync_baselines; DELETE FROM model_prices;')
    await sync([...entries].reverse())

    expect(snapshot()).toEqual(forward)
    expect(first).toMatchObject({ added: 1, skipped: 1 })
    expect(priceRow('model-w')).toMatchObject({ source_model_id: 'x/model-w', input: 1 })
  })

  it('repairs a registry that an earlier sync left with the reseller price', async () => {
    const now = Date.now()
    db.prepare(`
      INSERT INTO model_prices (
        model_key, provider, input, output, cache_read, cache_write, currency, source, source_model_id,
        source_url, origin, status, last_synced_at, created_at, updated_at
      ) VALUES ('claude-haiku-4-5', 'aihubmix', 1.1, 5.5, NULL, NULL, 'USD', 'litellm', 'aihubmix/claude-haiku-4-5', NULL, 'builtin', 'active', ?, ?, ?)
    `).run(now, now, now)
    db.prepare(`
      INSERT INTO model_price_aliases (alias, model_key, match_type, provider, priority, source, origin, enabled, created_at, updated_at)
      VALUES (?, 'claude-haiku-4-5', 'exact', 'aihubmix', 100, 'litellm', 'builtin', 1, ?, ?)
    `).run('aihubmix/claude-haiku-4-5', now, now)
    expect(rounded(resolvePriceFromRegistry(db, 'claude-haiku-4-5'))).toEqual({ input: 1.1, output: 5.5 })

    const summary = await sync([
      ['claude-haiku-4-5', chat('anthropic', 1, 5)],
      ['aihubmix/claude-haiku-4-5', chat('aihubmix', 1.1, 5.5)],
    ])

    expect(summary).toMatchObject({ added: 0, updated: 1, unchanged: 0 })
    expect(priceRow('claude-haiku-4-5')).toMatchObject({ provider: 'anthropic', source_model_id: 'claude-haiku-4-5' })
    expect(rounded(resolvePriceFromRegistry(db, 'claude-haiku-4-5'))).toEqual({ input: 1, output: 5 })
    expect(aliasTarget('aihubmix/claude-haiku-4-5')).toBe('claude-haiku-4-5')
    expect(rounded(resolvePriceFromRegistry(db, 'aihubmix/claude-haiku-4-5'))).toEqual({ input: 1, output: 5 })
  })

  it('still preserves user prices and user aliases', async () => {
    await sync([
      ['claude-haiku-4-5', chat('anthropic', 1, 5)],
      ['aihubmix/claude-haiku-4-5', chat('aihubmix', 1.1, 5.5)],
      ['gpt-9', chat('openai', 2, 8)],
    ])
    setUserPrice(db, 'claude-haiku-4-5', { input: 9, output: 9, currency: 'USD' })
    setUserPrice(db, 'aihubmix/claude-haiku-4-5', { input: 7, output: 7, currency: 'USD' })
    setUserPricingAlias(db, 'my-gateway/haiku', 'gpt-9')

    const summary = await sync([
      ['claude-haiku-4-5', chat('anthropic', 1, 5)],
      ['aihubmix/claude-haiku-4-5', chat('aihubmix', 1.1, 5.5)],
      ['gpt-9', chat('openai', 2, 8)],
      ['my-gateway/haiku', chat('my-gateway', 4, 4)],
    ])

    expect(priceRow('claude-haiku-4-5')).toMatchObject({ origin: 'user', input: 9 })
    expect(priceRow('aihubmix/claude-haiku-4-5')).toMatchObject({ origin: 'user', input: 7 })
    expect(aliasTarget('my-gateway/haiku')).toBe('gpt-9')
    expect(rounded(resolvePriceFromRegistry(db, 'aihubmix/claude-haiku-4-5'))).toEqual({ input: 7, output: 7 })
    // The user price on the key and the user alias; the sync writes nothing under a full id.
    expect(summary.userPreserved).toBe(2)
    // The synced baseline behind a user price is the owner's price, not the reseller's.
    expect(rounded(db.prepare('SELECT input, output FROM model_price_sync_baselines WHERE model_key = ?').get('claude-haiku-4-5') as { input: number; output: number }))
      .toEqual({ input: 1, output: 5 })
  })
})
