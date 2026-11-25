import { describe, expect, it } from 'vitest'
import { formatTokens } from '../src/format.js'
import { parseTimestamp } from '../src/timestamp.js'
import { convertFromUSD, convertToUSD, FALLBACK_RATE } from '../src/exchange-rate.js'

describe('shared browser-safe formatting and source units', () => {
  it.each([[0, '0'], [999, '999'], [1_000, '1.0K'], [1_500_000, '1.5M'], [2_000_000_000, '2.0B']])
    ('formats %s tokens as %s', (value, expected) => { expect(formatTokens(value as number)).toBe(expected) })

  it('keeps total precision and the chart tooltip small-count rounding option', () => {
    expect(formatTokens(1.6)).toBe('1.6')
    expect(formatTokens(1.6, true)).toBe('2')
  })

  it('uses USD-per-CNY in both conversion directions', () => {
    expect(convertToUSD(100, FALLBACK_RATE)).toBeCloseTo(13.7)
    expect(convertFromUSD(13.7, FALLBACK_RATE)).toBeCloseTo(100)
  })

  it('keeps explicit milliseconds and auto seconds distinct, including zero', () => {
    expect(parseTimestamp(123, 999, 'ms')).toBe(123)
    expect(parseTimestamp(123, 999)).toBe(123_000)
    expect(parseTimestamp('0', 999, 'ms')).toBe(0)
    expect(parseTimestamp('bad', 999, 'ms')).toBe(999)
  })

  it('parses UTC SQL datetimes without changing the default local-date contract', () => {
    const date = '2026-11-22 12:34:56'
    expect(parseTimestamp(date, 0, 'auto', 'utc')).toBe(Date.parse(`${date}Z`))
    expect(parseTimestamp(date, 0)).toBe(new Date(date).getTime())
  })
})
