import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import type { CurrencyCode } from './currency'

export interface WidgetSettings {
  theme: 'system' | 'light' | 'dark'
  refreshIntervalSec: number
  rangeDays: number
  showCost: boolean
  showHeatmap: boolean
  showTokenBreakdown: boolean
  locale: 'en' | 'zh'
  currency: CurrencyCode
}

const SETTINGS_PATH = join(homedir(), '.aiusage', 'widget-settings.json')

const DEFAULT_SETTINGS: WidgetSettings = {
  theme: 'system',
  refreshIntervalSec: 60,
  rangeDays: 30,
  showCost: true,
  showHeatmap: true,
  showTokenBreakdown: true,
  locale: 'en',
  currency: 'USD',
}

export function normalizeSettings(value: unknown, fallback: WidgetSettings = DEFAULT_SETTINGS): WidgetSettings {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const bounded = (key: 'rangeDays' | 'refreshIntervalSec', min: number, max: number) => {
    const number = raw[key]
    return typeof number === 'number' && Number.isFinite(number)
      ? Math.min(max, Math.max(min, Math.floor(number))) : fallback[key]
  }
  return {
    theme: raw.theme === 'system' || raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : fallback.theme,
    locale: raw.locale === 'en' || raw.locale === 'zh' ? raw.locale : fallback.locale,
    currency: raw.currency === 'USD' || raw.currency === 'CNY' ? raw.currency : fallback.currency,
    rangeDays: bounded('rangeDays', 1, 365),
    // Node timers overflow above this bound and otherwise turn into a tight loop.
    refreshIntervalSec: bounded('refreshIntervalSec', 5, Math.floor(2147483647 / 1000)),
    showCost: typeof raw.showCost === 'boolean' ? raw.showCost : fallback.showCost,
    showHeatmap: typeof raw.showHeatmap === 'boolean' ? raw.showHeatmap : fallback.showHeatmap,
    showTokenBreakdown: typeof raw.showTokenBreakdown === 'boolean' ? raw.showTokenBreakdown : fallback.showTokenBreakdown,
  }
}

export function loadSettings(): WidgetSettings {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
      return normalizeSettings(raw)
    }
  } catch {
    // Fall through to defaults
  }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(settings: WidgetSettings): void {
  const dir = join(homedir(), '.aiusage')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(normalizeSettings(settings), null, 2), 'utf-8')
}

export function getDefaultSettings(): WidgetSettings {
  return { ...DEFAULT_SETTINGS }
}
