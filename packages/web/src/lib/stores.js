import { writable, derived } from 'svelte/store'
import { FALLBACK_RATE, convertFromUSD } from '@aiusage/core/exchange-rate'
export { formatTokens } from '@aiusage/core/format'

/**
* @param {unknown} value
* @param {unknown} defaultValue
*/
function sameStoredType(value, defaultValue) {
  if (defaultValue === null) return value === null
  if (Array.isArray(defaultValue)) return Array.isArray(value)
  if (typeof defaultValue === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  return typeof value === typeof defaultValue && (typeof value !== 'number' || Number.isFinite(value))
}

/**
* @template T
* @param {string} key
* @param {T} defaultValue
* @param {(value: T) => boolean} [validate]
* @returns {import('svelte/store').Writable<T>}
*/
function persisted(key, defaultValue, validate = value => sameStoredType(value, defaultValue)) {
  if (typeof window === 'undefined') return writable(defaultValue)
  let initial = defaultValue
  try {
    const stored = localStorage.getItem(key)
    if (stored !== null) {
      const parsed = JSON.parse(stored)
      if (validate(parsed)) initial = parsed
    }
  } catch {}
  const store = writable(initial)
  store.subscribe(value => {
    try {
      // JSON.stringify already strips undefined properties natively
      localStorage.setItem(key, JSON.stringify(value))
    } catch {}
  })
  return store
}

/** @typedef {{ range?: string, from?: string, to?: string, month?: string }} DateRangeState */
export const dateRange = persisted('aiusage-dateRange', /** @type {DateRangeState} */ ({ range: 'day' }))

export const selectedDevice = persisted('aiusage-selectedDevice', '') // '' = all devices, value = deviceInstanceId

/** @param {string} deviceInstanceId */
export function setDevice(deviceInstanceId) {
  selectedDevice.set(deviceInstanceId)
}

export const selectedTool = persisted('aiusage-selectedTool', '') // '' = all tools, value = tool name

export const modelDisplayMode = persisted('aiusage-modelDisplayMode', 'full', value => value === 'full' || value === 'merged') // 'full' | 'merged'

/** @param {string} tool */
export function setTool(tool) {
  selectedTool.set(tool)
}

// The pricing page still publishes its recalc progress through this store.
export const recalcStatus = writable('idle')

export const displayCurrency = writable('USD')
// External config can be missing or malformed; the derived formatter validates it.
export const exchangeRate = writable(/** @type {unknown} */ (FALLBACK_RATE))

/** @param {string | undefined} range */
export function setRange(range) {
  dateRange.set({ range, month: undefined })
}

/** @param {string} from
 * @param {string} to
 * @param {string} [month]
 */
export function setCustomRange(from, to, month) {
  dateRange.set({ from, to, month: month || undefined })
}

/** @param {string | number} ts */
export function formatDate(ts) {
  return new Date(ts).toLocaleDateString()
}

/** @param {string | number} ts */
export function formatDateTime(ts) {
  return new Date(ts).toLocaleString()
}

/** @param {number} n */
export function formatNumber(n) {
  return n.toLocaleString()
}

export const formatCost = derived([displayCurrency, exchangeRate], ([currency, configuredRate]) => {
  const numericRate = typeof configuredRate === 'number' || typeof configuredRate === 'string' ? Number(configuredRate) : NaN
  const rate = Number.isFinite(numericRate) && numericRate > 0 ? numericRate : FALLBACK_RATE
  return (/** @type {unknown} */ value) => {
    const amount = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN
    if (!Number.isFinite(amount)) return '—'
    const converted = currency === 'CNY' ? convertFromUSD(amount, rate) : amount
    if (!Number.isFinite(converted)) return '—'
    const digits = Math.abs(converted) < 0.01 ? 4 : 2
    return `${currency === 'CNY' ? '¥' : '$'}${converted.toFixed(digits)}`
  }
})
