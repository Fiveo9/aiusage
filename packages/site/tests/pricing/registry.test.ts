import { describe, expect, it } from 'vitest'
import { calculateCostForPrice, compileModelPriceMatcher, resolvePriceFromTable } from '@aiusage/core'

describe('pricing registry', () => {
  it('resolves exact aliases before falling back to model keys', () => {
    const registry = {
      priceTable: {
        'gpt-4o': { input: 2, output: 8 },
        'openai/gpt-4o': { input: 99, output: 99 },
      },
      aliases: new Map([
        ['openai/gpt-4o', { input: 1, output: 3 }],
      ]),
    }

    const match = compileModelPriceMatcher({ ...registry.priceTable, ...Object.fromEntries(registry.aliases) }, registry.priceTable)
    expect(match('openai/gpt-4o')?.entry).toEqual({ input: 1, output: 3 })
  })

  it('uses core fallback matching for non-aliased model ids', () => {
    const registry = {
      priceTable: {
        'claude-sonnet-4': { input: 3, output: 15 },
      },
      aliases: new Map(),
    }

    const price = resolvePriceFromTable('claude-sonnet-4-20250514', registry.priceTable)
    expect(price).toEqual({ input: 3, output: 15 })
    expect(calculateCostForPrice(price!, {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
    })).toBe(10.5)
  })
})
