import { afterEach, describe, expect, it } from 'vitest'
import { calculateCost, getBasePriceTable, getUserOverrides, removePriceOverride, resolvePrice, resolvePriceFromTable, setPriceOverride, setRuntimePriceTable } from '../../src/pricing.js'

const base = getBasePriceTable()
const overrides = getUserOverrides()
afterEach(() => setRuntimePriceTable(base, overrides))

describe('price key boundaries', () => {
  it.each(['constructor', 'toString', '__proto__'])('does not resolve inherited object key %s as a price', model => {
    const table = { 'synthetic-model': { input: 2, output: 4 } }
    expect(resolvePriceFromTable(model, table)).toBeUndefined()
    setRuntimePriceTable(table)
    expect(calculateCost(model, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0 })).toBe(0)
  })
  it('still accepts a real own price whose name is constructor', () => {
    const price = { input: 2, output: 4 }
    expect(resolvePriceFromTable('constructor', { constructor: price })).toBe(price)
  })
  it('strips known routed provider prefixes case-insensitively', () => {
    const price = { input: 2, output: 4 }
    expect(resolvePriceFromTable('GLINK/SYNTHETIC-MODEL-20270101', { 'synthetic-model': price })).toBe(price)
  })
  it('keeps exact aliases distinct from original prefix prices across manual override and removal', () => {
    const exact = { input: 3, output: 4 }
    const prefix = { input: 1, output: 4 }
    setRuntimePriceTable({ 'synthetic-alias': exact }, {}, { base: { 'synthetic-alias': prefix }, overrides: {} })
    expect(resolvePrice('synthetic-alias')).toBe(exact)
    expect(resolvePrice('synthetic-alias-suffix')).toBe(prefix)
    const manual = { input: 5, output: 4 }
    setPriceOverride('synthetic-alias', manual)
    expect(resolvePrice('synthetic-alias-suffix')).toBe(manual)
    removePriceOverride('synthetic-alias')
    expect(resolvePrice('synthetic-alias')).toBe(exact)
    expect(resolvePrice('synthetic-alias-suffix')).toBe(prefix)
  })
})
