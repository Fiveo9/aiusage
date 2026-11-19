import { describe, expect, it } from 'vitest'
import { groupModelCosts, groupModels, modelDisplayName } from '../src/lib/model-display.js'

const rows = Object.freeze([
  Object.freeze({
    model: 'provider-1/gpt-6-astra', provider: 'provider-1',
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40,
    thinkingTokens: 10, totalTokens: 200, totalCost: 0.25, callCount: 2, percentage: 20,
  }),
  Object.freeze({
    model: 'provider-2/gpt-6-astra', provider: 'provider-2',
    inputTokens: 200, outputTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 80,
    thinkingTokens: 20, totalTokens: 400, totalCost: 0.5, callCount: 3, percentage: 40,
  }),
  Object.freeze({
    model: 'gpt-6-astra', provider: 'provider-1',
    inputTokens: 50, outputTokens: 10, cacheReadTokens: 15, cacheWriteTokens: 20,
    thinkingTokens: 5, totalTokens: 100, totalCost: 0.125, callCount: 1, percentage: 10,
  }),
  Object.freeze({
    model: 'provider-1/other-model', provider: 'provider-1',
    inputTokens: 300, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    thinkingTokens: 0, totalTokens: 300, totalCost: 1, callCount: 4, percentage: 30,
  }),
])

describe('model prefix display', () => {
  it('defaults to separate full names and preserves every original metric', () => {
    expect(groupModels(rows)).toEqual(rows.map(row => ({ ...row, originalModels: [row.model] })))
    expect(modelDisplayName('provider-1/gpt-6-astra')).toBe('provider-1/gpt-6-astra')
  })

  it('merges prefixes and bare names, summing every usage category and recorded cost', () => {
    const merged = groupModels(rows, 'merged')
    expect(merged).toHaveLength(2)
    expect(merged[0]).toEqual({
      model: 'gpt-6-astra', provider: 'provider-1, provider-2',
      originalModels: ['provider-1/gpt-6-astra', 'provider-2/gpt-6-astra', 'gpt-6-astra'],
      inputTokens: 350, outputTokens: 70, cacheReadTokens: 105, cacheWriteTokens: 140,
      thinkingTokens: 35, totalTokens: 700, totalCost: 0.875, callCount: 6, percentage: 70,
    })
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'thinkingTokens', 'totalTokens', 'totalCost', 'callCount']) {
      expect(merged.reduce((sum, row) => sum + row[field], 0))
        .toBe(rows.reduce((sum, row) => sum + row[field], 0))
    }
    // Sorting/displaying a merged result must not replace or reorder the source.
    merged.sort((a, b) => b.totalCost - a.totalCost)
    expect(groupModels(rows, 'full')).toEqual(rows.map(row => ({ ...row, originalModels: [row.model] })))
  })

  it('recomputes shares instead of summing rounded percentages', () => {
    const result = groupModels([
      { model: 'a/x', totalTokens: 1, percentage: 33.3 },
      { model: 'b/x', totalTokens: 1, percentage: 33.3 },
      { model: 'c/y', totalTokens: 1, percentage: 33.3 },
    ], 'merged')
    expect(result.map(row => row.percentage)).toEqual([66.7, 33.3])
  })

  it('keeps distinct providers in full mode and deduplicates names when merging', () => {
    const sameName = [
      { ...rows[0], provider: 'one' },
      { ...rows[0], provider: 'two' },
    ]
    expect(groupModels(sameName, 'full')).toHaveLength(2)
    expect(groupModels(sameName, 'merged')[0]).toMatchObject({
      provider: 'one, two', originalModels: ['provider-1/gpt-6-astra'], totalTokens: 400,
    })
  })

  it('handles empty lists, zero tokens, and missing optional token categories', () => {
    expect(groupModels([], 'merged')).toEqual([])
    expect(groupModelCosts({}, 'merged')).toEqual({})
    expect(groupModels([{ model: 'provider/zero', totalCost: 0.5 }], 'merged')[0]).toMatchObject({
      model: 'zero', totalTokens: 0, thinkingTokens: 0, totalCost: 0.5, percentage: 0,
    })
  })

  it('uses the final slash segment without normalizing versions, suffixes, or case', () => {
    for (const [source, expected] of [
      ['gateway/provider/gpt-6-astra', 'gpt-6-astra'],
      ['provider/gpt-6-astra:thinking', 'gpt-6-astra:thinking'],
      ['provider/GPT-6-astra', 'GPT-6-astra'],
      ['provider/gpt-6-astra-2026-11-19', 'gpt-6-astra-2026-11-19'],
      ['gpt-6-astra', 'gpt-6-astra'],
      ['provider/', 'provider/'],
      ['', ''],
    ]) {
      expect(modelDisplayName(source, 'merged')).toBe(expected)
    }
    expect(modelDisplayName('provider/model', 'invalid')).toBe('provider/model')
  })

  it('merges all costs before ranking and taking the top ten', () => {
    const costs = Object.freeze(Object.fromEntries([
      ...Array.from({ length: 10 }, (_, i) => [`other-${i}`, 10]),
      ['provider-1/gpt-6-astra', 6], ['provider-2/gpt-6-astra', 6], ['gpt-6-astra', 1],
    ]))
    expect(groupModelCosts(costs)).toEqual(costs)
    const merged = groupModelCosts(costs, 'merged')
    const topTen = Object.entries(merged).sort(([, a], [, b]) => b - a).slice(0, 10)
    expect(topTen[0]).toEqual(['gpt-6-astra', 13])
    expect(Object.values(merged).reduce((a, b) => a + b, 0)).toBe(113)
  })

  it('treats names matching object properties as ordinary model names', () => {
    const costs = groupModelCosts({ 'a/__proto__': 2, 'b/__proto__': 3, 'a/constructor': 4 }, 'merged')
    expect(Object.entries(costs)).toEqual([['__proto__', 5], ['constructor', 4]])
    expect(groupModels([{ model: 'a/__proto__', totalTokens: 1 }], 'merged')[0].model).toBe('__proto__')
  })
})
