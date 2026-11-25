import { FALLBACK_RATE, convertToUSD } from './exchange-rate.js'

export interface PriceEntry {
  input: number        // per 1M tokens (in currency unit)
  output: number       // per 1M tokens (in currency unit)
  cacheRead?: number   // per 1M tokens (in currency unit)
  cacheWrite?: number  // per 1M tokens (in currency unit)
  currency?: 'CNY' | 'USD'  // defaults to 'USD' if omitted
}

// Runtime-mutable price table. Hosts such as the CLI and site load this from
// their pricing registry database instead of relying on package-bundled data.
let basePriceTable: Record<string, PriceEntry> = {}
let userOverrides: Record<string, PriceEntry> = {}
let basePrefixPriceTable: Record<string, PriceEntry> = {}
let prefixUserOverrides: Record<string, PriceEntry> = {}
let prefixPriceTable: Record<string, PriceEntry> = {}
const resolvedPriceCache = new Map<string, PriceEntry | undefined>()

export const DEFAULT_PRICE_TABLE: Record<string, PriceEntry> = {}

export let PRICE_TABLE: Record<string, PriceEntry> = {}

export function getPriceTable(): Record<string, PriceEntry> {
  return { ...basePriceTable, ...userOverrides }
}

export function setBasePriceTable(table: Record<string, PriceEntry>): void {
  basePriceTable = { ...table }
  basePrefixPriceTable = { ...table }
  PRICE_TABLE = { ...basePriceTable, ...userOverrides }
  prefixPriceTable = { ...basePrefixPriceTable, ...prefixUserOverrides }
  resolvedPriceCache.clear()
}

export function setRuntimePriceTable(
  base: Record<string, PriceEntry>,
  overrides: Record<string, PriceEntry> = {},
  prefixTables?: { base: Record<string, PriceEntry>; overrides: Record<string, PriceEntry> },
): void {
  basePriceTable = { ...base }
  userOverrides = { ...overrides }
  basePrefixPriceTable = { ...(prefixTables?.base ?? base) }
  prefixUserOverrides = { ...(prefixTables?.overrides ?? overrides) }
  PRICE_TABLE = { ...basePriceTable, ...userOverrides }
  prefixPriceTable = { ...basePrefixPriceTable, ...prefixUserOverrides }
  resolvedPriceCache.clear()
}

export function getBasePriceTable(): Record<string, PriceEntry> {
  return { ...basePriceTable }
}

export function setPriceOverride(model: string, entry: PriceEntry): void {
  userOverrides = { ...userOverrides, [model]: entry }
  prefixUserOverrides = { ...prefixUserOverrides, [model]: entry }
  PRICE_TABLE = { ...basePriceTable, ...userOverrides }
  prefixPriceTable = { ...basePrefixPriceTable, ...prefixUserOverrides }
  resolvedPriceCache.clear()
}

export function removePriceOverride(model: string): void {
  const { [model]: _, ...rest } = userOverrides
  const { [model]: _prefix, ...prefixRest } = prefixUserOverrides
  userOverrides = rest
  prefixUserOverrides = prefixRest
  PRICE_TABLE = { ...basePriceTable, ...userOverrides }
  prefixPriceTable = { ...basePrefixPriceTable, ...prefixUserOverrides }
  resolvedPriceCache.clear()
}

export function getUserOverrides(): Record<string, PriceEntry> {
  return { ...userOverrides }
}

/**
 * Pricing aliases for model names that tools report but that no pricing source
 * lists under that exact key. LiteLLM prices Gemini 3.x Pro only under its
 * `-preview` key, and prefix matching only helps a model name that is *longer*
 * than a registry key, so `gemini-3.1-pro` and Antigravity's effort-qualified
 * `-high`/`-low` variants resolved to nothing and cost $0 (issue #69).
 * Hosts seed these as builtin aliases whenever the target price exists and
 * never override an alias a user or a pricing sync already defined. The
 * record's model name is left untouched; only price resolution follows the alias.
 */
export const CURATED_PRICE_ALIASES: ReadonlyArray<{ alias: string; modelKey: string }> = [
  { alias: 'gemini-3.1-pro', modelKey: 'gemini-3.1-pro-preview' },
  { alias: 'gemini-3.1-pro-high', modelKey: 'gemini-3.1-pro-preview' },
  { alias: 'gemini-3.1-pro-low', modelKey: 'gemini-3.1-pro-preview' },
  { alias: 'gemini-3-pro', modelKey: 'gemini-3-pro-preview' },
  { alias: 'gemini-3-pro-high', modelKey: 'gemini-3-pro-preview' },
  { alias: 'gemini-3-pro-low', modelKey: 'gemini-3-pro-preview' },
  { alias: 'gemini-3-flash', modelKey: 'gemini-3-flash-preview' },
]

export interface CuratedPrice {
  modelKey: string
  provider: string
  price: PriceEntry
  sourceUrl: string
}

const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'
const OPENAI_PRICING_URL = 'https://developers.openai.com/api/docs/pricing'

/**
 * Prices for models that hosts should know without waiting for a LiteLLM sync.
 * A registry synced before a model launched has no row for it, and prefix
 * matching then prices it as an older sibling: `claude-opus-5-5` resolved to
 * `claude-opus-5` and showed $5/$25 instead of $4/$20. Hosts seed these as
 * builtin prices when no row exists for the key; a later LiteLLM sync or a user
 * price takes over from there. Rates are USD per 1M tokens at the standard
 * (short-context, global) tier; `cacheWrite` is the 5-minute write rate.
 */
export const CURATED_PRICES: ReadonlyArray<CuratedPrice> = [
  {
    modelKey: 'claude-opus-5-5',
    provider: 'anthropic',
    price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, currency: 'USD' },
    sourceUrl: ANTHROPIC_PRICING_URL,
  },
  {
    modelKey: 'gpt-6-sol',
    provider: 'openai',
    price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, currency: 'USD' },
    sourceUrl: OPENAI_PRICING_URL,
  },
  {
    modelKey: 'gpt-6-luna',
    provider: 'openai',
    price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, currency: 'USD' },
    sourceUrl: OPENAI_PRICING_URL,
  },
]

const PROVIDER_PREFIXES = [
  'accounts/fireworks/models/',
  'moonshotai/',
  'z-ai/',
  'zai-org/',
  'frank/',
  'nvidia/',
  'glink/',
  'antchat/',
]

/**
 * Resolve price for a model: exact match first, then prefix match.
 * Strips known provider prefixes before matching.
 * e.g. 'claude-haiku-4-5-20251001' matches 'claude-haiku-4-5'
 *      'z-ai/glm-5-20260211' matches 'glm-5'
 */
export function resolvePrice(model: string): PriceEntry | undefined {
  if (resolvedPriceCache.has(model)) return resolvedPriceCache.get(model)
  const price = resolvePriceFromTable(model, PRICE_TABLE, prefixPriceTable)
  resolvedPriceCache.set(model, price)
  return price
}

export { resolvePriceFromTable }

/** Shared key selection for price values and registry/UI metadata. */
export function resolveModelPriceMatch<T>(
  model: string,
  exactTable: Readonly<Record<string, T>>,
  prefixTable: Readonly<Record<string, T>> = exactTable,
): { key: string; entry: T; matchType: 'exact' | 'prefix' } | undefined {
  // Compatibility calls accept mutable tables/getters. Only the chosen value
  // is read, and no object-identity cache changes their existing semantics.
  const candidates = priceCandidates(model)
  for (const key of candidates) if (Object.hasOwn(exactTable, key)) return { key, entry: exactTable[key], matchType: 'exact' }
  const exactKeys = Object.keys(exactTable).sort()
  for (const candidate of candidates) {
    const key = exactKeys.find(key => key.toLowerCase() === candidate.toLowerCase())
    if (key !== undefined) return { key, entry: exactTable[key], matchType: 'exact' }
  }
  let best: string | undefined
  for (const key of Object.keys(prefixTable).sort()) {
    if (candidates.some(candidate => candidate.toLowerCase().startsWith(key.toLowerCase()))
      && (best === undefined || key.length > best.length)) best = key
  }
  return best === undefined ? undefined : { key: best, entry: prefixTable[best], matchType: 'prefix' }
}

export type ModelPriceMatcher<T> = (model: string) => { key: string; entry: T; matchType: 'exact' | 'prefix' } | undefined

/** Compile one request's immutable snapshot. Prefix lookup is O(model length), not O(price count). */
export function compileModelPriceMatcher<T>(
  exactTable: Readonly<Record<string, T>>,
  prefixTable: Readonly<Record<string, T>> = exactTable,
): ModelPriceMatcher<T> {
  const exactKeys = Object.keys(exactTable).sort()
  const exact = new Map(Object.getOwnPropertyNames(exactTable).map(key => [key, exactTable[key]]))
  const folded = new Map<string, string>()
  for (const key of exactKeys) if (!folded.has(key.toLowerCase())) folded.set(key.toLowerCase(), key)
  interface Node { children: Map<string, Node>; match?: { key: string; entry: T } }
  const root: Node = { children: new Map() }
  const prefixKeys = prefixTable === exactTable ? exactKeys : Object.keys(prefixTable).sort()
  for (const key of prefixKeys) {
    let node = root
    for (const character of key.toLowerCase()) {
      let child = node.children.get(character)
      if (!child) { child = { children: new Map() }; node.children.set(character, child) }
      node = child
    }
    if (!node.match || key.length > node.match.key.length) node.match = { key, entry: prefixTable[key] }
  }
  return (model) => {
    const candidates = priceCandidates(model)
    for (const key of candidates) if (exact.has(key)) return { key, entry: exact.get(key)!, matchType: 'exact' }
    for (const candidate of candidates) {
      const key = folded.get(candidate.toLowerCase())
      if (key !== undefined) return { key, entry: exact.get(key)!, matchType: 'exact' }
    }
    let best: { key: string; entry: T } | undefined
    const choose = (match: typeof best) => {
      if (match && (!best || match.key.length > best.key.length || (match.key.length === best.key.length && match.key < best.key))) best = match
    }
    for (const candidate of candidates) {
      let node: Node | undefined = root
      choose(node.match)
      for (const character of candidate.toLowerCase()) {
        node = node.children.get(character)
        if (!node) break
        choose(node.match)
      }
    }
    return best ? { ...best, matchType: 'prefix' } : undefined
  }
}

function priceCandidates(model: string): string[] {
  let stripped = model
  for (const prefix of PROVIDER_PREFIXES) {
    if (stripped.toLowerCase().startsWith(prefix)) {
      stripped = stripped.slice(prefix.length)
      break
    }
  }
  return [...new Set([model, model.toLowerCase(), stripped, stripped.toLowerCase()])]
}

function resolvePriceFromTable(
  model: string,
  table: Record<string, PriceEntry>,
  prefixTable: Record<string, PriceEntry> = table,
): PriceEntry | undefined {
  return resolveModelPriceMatch(model, table, prefixTable)?.entry
}

function calculateCostWithResolver(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    thinkingTokens: number
  },
  exchangeRate: number | undefined,
  resolver: (model: string) => PriceEntry | undefined
): number {
  const price = resolver(model)
  if (!price) return 0

  const inputCost = (tokens.inputTokens / 1_000_000) * price.input
  const outputCost = (tokens.outputTokens / 1_000_000) * price.output
  const cacheReadCost = (tokens.cacheReadTokens / 1_000_000) * (price.cacheRead ?? 0)
  const cacheWriteCost = (tokens.cacheWriteTokens / 1_000_000) * (price.cacheWrite ?? 0)
  const thinkingCost = (tokens.thinkingTokens / 1_000_000) * price.output

  const rawCost = inputCost + outputCost + cacheReadCost + cacheWriteCost + thinkingCost

  if (price.currency === 'CNY') {
    return convertToUSD(rawCost, exchangeRate ?? FALLBACK_RATE)
  }
  return rawCost
}

export function calculateCost(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    thinkingTokens: number
  },
  exchangeRate?: number
): number {
  return calculateCostWithResolver(model, tokens, exchangeRate, resolvePrice)
}

export function calculateCostForPrice(
  price: PriceEntry,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    thinkingTokens: number
  },
  exchangeRate?: number
): number {
  const inputCost = (tokens.inputTokens / 1_000_000) * price.input
  const outputCost = (tokens.outputTokens / 1_000_000) * price.output
  const cacheReadCost = (tokens.cacheReadTokens / 1_000_000) * (price.cacheRead ?? 0)
  const cacheWriteCost = (tokens.cacheWriteTokens / 1_000_000) * (price.cacheWrite ?? 0)
  const thinkingCost = (tokens.thinkingTokens / 1_000_000) * price.output
  const rawCost = inputCost + outputCost + cacheReadCost + cacheWriteCost + thinkingCost
  return price.currency === 'CNY' ? convertToUSD(rawCost, exchangeRate ?? FALLBACK_RATE) : rawCost
}
