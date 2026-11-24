import { writable, derived } from 'svelte/store'

function sameStoredType(value, defaultValue) {
  if (defaultValue === null) return value === null
  if (Array.isArray(defaultValue)) return Array.isArray(value)
  if (typeof defaultValue === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  return typeof value === typeof defaultValue && (typeof value !== 'number' || Number.isFinite(value))
}

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

export const dateRange = persisted('aiusage-dateRange', { range: 'day' })

export const selectedDevice = persisted('aiusage-selectedDevice', '') // '' = all devices, value = deviceInstanceId

export function setDevice(deviceInstanceId) {
  selectedDevice.set(deviceInstanceId)
}

export const selectedTool = persisted('aiusage-selectedTool', '') // '' = all tools, value = tool name

export const modelDisplayMode = persisted('aiusage-modelDisplayMode', 'full', value => value === 'full' || value === 'merged') // 'full' | 'merged'

export function setTool(tool) {
  selectedTool.set(tool)
}

// Pricing recalc status: 'idle' | 'updating' | 'done'
export const recalcStatus = writable('idle')

export const pollingInterval = writable(30000) // 30 seconds default

export const displayCurrency = writable('USD')
const FALLBACK_RATE = 0.137 // USD per CNY; must match core/src/exchange-rate.ts.
export const exchangeRate = writable(FALLBACK_RATE)

export function setRange(range) {
  dateRange.set({ range, month: undefined })
}

export function setCustomRange(from, to, month) {
  dateRange.set({ from, to, month: month || undefined })
}

export function formatDate(ts) {
  return new Date(ts).toLocaleDateString()
}

export function formatDateTime(ts) {
  return new Date(ts).toLocaleString()
}

export function formatNumber(n) {
  return n.toLocaleString()
}

export const formatCost = derived([displayCurrency, exchangeRate], ([currency, configuredRate]) => {
  const numericRate = typeof configuredRate === 'number' || typeof configuredRate === 'string' ? Number(configuredRate) : NaN
  const rate = Number.isFinite(numericRate) && numericRate > 0 ? numericRate : FALLBACK_RATE
  return (value) => {
    const amount = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN
    if (!Number.isFinite(amount)) return '—'
    const converted = currency === 'CNY' ? amount / rate : amount
    if (!Number.isFinite(converted)) return '—'
    const digits = Math.abs(converted) < 0.01 ? 4 : 2
    return `${currency === 'CNY' ? '¥' : '$'}${converted.toFixed(digits)}`
  }
})

export function formatTokens(n) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}
