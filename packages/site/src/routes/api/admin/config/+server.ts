import { isHttpError, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireAdmin } from '$lib/server/auth/session.js'
import { getAllConfigs, setConfigsAtomically, isValidConfigValue, getDefaultValue, CONFIG_DESCRIPTIONS, CONFIG_DESCRIPTIONS_ZH, CONFIG_CATEGORIES, CONFIG_UNITS, CONFIG_DISPLAY_MULTIPLIER, CFG } from '$lib/server/config.js'
import { readLimitedJson } from '$lib/server/request-body.js'

const ALL_KEYS: readonly string[] = Object.values(CFG)

export const GET: RequestHandler = async (event) => {
  await requireAdmin(event)

  const stored = await getAllConfigs()
  const configs: Record<string, { value: number; default: number; description: string | null; description_zh: string | null; unit: string | null; unit_zh: string | null; displayMultiplier: number | null }> = {}

  for (const key of ALL_KEYS) {
    const entry = stored[key]
    const unit = CONFIG_UNITS[key]
    const multiplier = CONFIG_DISPLAY_MULTIPLIER[key]
    const rawValue = entry?.value ?? getDefaultValue(key)
    configs[key] = {
      value: multiplier ? rawValue / multiplier : rawValue,
      default: multiplier ? getDefaultValue(key) / multiplier : getDefaultValue(key),
      description: CONFIG_DESCRIPTIONS[key] ?? entry?.description ?? null,
      description_zh: CONFIG_DESCRIPTIONS_ZH[key] ?? null,
      unit: unit?.en ?? null,
      unit_zh: unit?.zh ?? null,
      displayMultiplier: multiplier ?? null,
    }
  }

  const categories = Object.entries(CONFIG_CATEGORIES).map(([id, cat]) => ({
    id,
    label: cat.label,
    label_zh: cat.label_zh,
    keys: cat.keys,
  }))

  return json({ configs, categories })
}

export const PUT: RequestHandler = async (event) => {
  const admin = await requireAdmin(event)
  const body = await readLimitedJson(event.request)
  const entries = body.configs as Record<string, number> | undefined

  if (!entries || typeof entries !== 'object' || Array.isArray(entries) || !Object.keys(entries).length) {
    return json({ error: 'Invalid request body' }, { status: 400 })
  }

  const stored: Record<string, number> = {}
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return json({ error: 'Invalid configuration value' }, { status: 400 })
    const multiplier = CONFIG_DISPLAY_MULTIPLIER[key]
    const storedValue = multiplier ? value * multiplier : value
    if (!isValidConfigValue(key, storedValue)) return json({ error: `Invalid configuration value: ${key}` }, { status: 400 })
    stored[key] = storedValue
  }
  try {
    await setConfigsAtomically(stored, admin.id)
  } catch (err) {
    if (isHttpError(err)) return json({ error: err.body.message }, { status: err.status })
    throw err
  }
  return json({ updated: Object.keys(stored) })
}
