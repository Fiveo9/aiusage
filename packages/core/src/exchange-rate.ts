export const FALLBACK_RATE = 0.137  // CNY → USD
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 hours

export interface ExchangeRateCache {
  CNY_USD: number
  fetchedAt: number
}

export function resolveExchangeRate(config: {
  exchangeRate?: number
  exchangeRateCache?: ExchangeRateCache
}): number {
  if (config.exchangeRate != null) return config.exchangeRate

  if (config.exchangeRateCache) {
    const age = Date.now() - config.exchangeRateCache.fetchedAt
    if (age < CACHE_TTL_MS) return config.exchangeRateCache.CNY_USD
  }

  return FALLBACK_RATE
}

export async function fetchExchangeRate(): Promise<number | null> {
  try {
    const response = await fetch('https://open.er-api.com/v6/latest/CNY', {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const data = await response.json()
    const rate = data?.rates?.USD
    if (typeof rate !== 'number' || rate <= 0) return null
    return rate
  } catch {
    return null
  }
}

export function convertToUSD(cny: number, rate: number): number {
  return cny * rate
}

export function convertFromUSD(usd: number, rate: number): number {
  return usd / rate
}
