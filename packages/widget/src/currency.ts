export type CurrencyCode = 'USD' | 'CNY'

export interface ExchangeRateState {
  // This feed is CNY per USD (USD → CNY), the inverse of Core's CNY_USD cache.
  base: 'USD'
  target: 'CNY'
  rate: number | null
  fetchedAt: number | null
  date?: string
  source: string
  error?: string
}

// Tried in order: the two hosts the currency-api README lists, then a host serving the
// same JSON shape (ECB rates, allratestoday.com).
export const EXCHANGE_RATE_SOURCES = [
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
  'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
  'https://allratestoday.com/api/compat/currency-api/latest/v1/currencies/usd.json',
] as const

export const EXCHANGE_RATE_SOURCE: string = EXCHANGE_RATE_SOURCES[0]
const EXCHANGE_RATE_TIMEOUT_MS = 5_000

export interface UsdCnyRate {
  rate: number
  date?: string
  source: string
}

export async function fetchUsdCnyRate(fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<UsdCnyRate> {
  let lastError: unknown = new Error('USD/CNY rate missing')
  for (const source of EXCHANGE_RATE_SOURCES) {
    if (signal?.aborted) throw signal.reason ?? new Error('Exchange rate request cancelled')
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => {
      controller.abort(new Error('Exchange rate request timed out'))
    }, EXCHANGE_RATE_TIMEOUT_MS)
    try {
      const response = await fetchFn(source, { signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const payload = await response.json() as { date?: string; usd?: { cny?: number } }
      const rate = payload.usd?.cny
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
        throw new Error('USD/CNY rate missing')
      }

      return { rate, date: payload.date, source }
    } catch (error) {
      lastError = error
    } finally {
      // Keep the timeout active until the response body has also been read.
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  throw lastError
}

export const currencies: Array<{ code: CurrencyCode; label: string }> = [
  { code: 'USD', label: 'USD' },
  { code: 'CNY', label: 'CNY' },
]

export function convertUsdCost(
  value: number,
  currency: CurrencyCode,
  exchangeRate: ExchangeRateState | null
): number | null {
  if (!Number.isFinite(value)) return null
  if (currency === 'USD') return value
  if (exchangeRate?.rate && Number.isFinite(exchangeRate.rate) && exchangeRate.rate > 0) {
    // Unlike Core's USD-per-CNY rate, this USD-base feed is multiplied.
    const converted = value * exchangeRate.rate
    return Number.isFinite(converted) ? converted : null
  }
  return null
}

export function formatUsdCost(
  value: number,
  currency: CurrencyCode,
  locale: string,
  exchangeRate: ExchangeRateState | null,
  compact = false
): string {
  const converted = convertUsdCost(value, currency, exchangeRate)
  return converted === null ? '--' : formatCurrency(converted, currency, locale, compact)
}

export function formatCurrency(
  value: number,
  currency: CurrencyCode,
  locale: string,
  compact = false
): string {
  const notation = compact && Math.abs(value) >= 1_000 ? 'compact' : 'standard'
  const fractionDigits = value >= 100 || notation === 'compact'
    ? 0
    : value >= 1
      ? 2
      : value > 0
        ? 3
        : 0

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    notation,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}
