import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { ConsentConfig } from './sync/consent.js'
import type { PriceEntry, ExchangeRateCache } from '@aiusage/core'
import { JsonFileError, readJsonObjectFile, writeFileAtomic } from './json-file.js'

export const AIUSAGE_DIR = join(homedir(), '.aiusage')
export const CONFIG_PATH = join(AIUSAGE_DIR, 'config.json')

export const SYNC_FIELDS = [
  'ts', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'thinkingTokens', 'cost', 'costSource', 'tool', 'model', 'provider',
  'sessionKey', 'device', 'deviceInstanceId', 'updatedAt',
]

export interface SyncConfig {
  backend: 'github' | 's3' | 'cloud'
  repo?: string
  bucket?: string
  prefix?: string
  endpoint?: string
  region?: string
  credentialRef?: string
  /** Missing means legacy PAT authentication. Secrets live outside this config. */
  githubAuth?: { method: 'github-app'; credentialId: string; login: string; installationId: number; clientId: string }
    | { method: 'pat'; credentialId?: string }
  branch?: string
}

export interface Config {
  sync?: SyncConfig
  device?: string
  platform?: string                    // 'win32' | 'darwin' | 'linux'
  retentionDays?: number
  refreshInterval?: number
  /** @deprecated Use refreshInterval. Kept for migration only. */
  parseInterval?: number
  /** @deprecated Use refreshInterval. Kept for migration only. */
  dashboardPollInterval?: number
  leaderboardAutoUpload?: boolean
  leaderboardUploadInterval?: number
  credentials?: Record<string, string>
  priceOverrides?: Record<string, PriceEntry>
  /** @deprecated Legacy source paths — use AIUSAGE_*_PATH env vars instead. Kept for migration only. */
  sources?: Record<string, string>
  /** First day of week: 0 = Sunday (Western), 1 = Monday (ISO/Chinese). Defaults to 1. */
  weekStart?: 0 | 1
  /** Display currency for the web UI: 'USD' (default) or 'CNY' */
  displayCurrency?: 'USD' | 'CNY'
  /** Manual exchange rate override (CNY → USD multiplier) */
  exchangeRate?: number
  /** Auto-fetched exchange rate cache */
  exchangeRateCache?: ExchangeRateCache
  /** Auto-sync interval in milliseconds (0 or undefined = disabled) */
  syncInterval?: number
}

/** `config.json` exists but cannot be used; see `JsonFileError`. */
export class ConfigFileError extends JsonFileError {
  constructor(path: string, problem: string) {
    super(path, problem, 'Fix the JSON in it, or move the file aside (rename it) and run "aiusage init" to configure again.')
    this.name = 'ConfigFileError'
  }
}

export type ConfigFileRead =
  | { status: 'missing' }
  | { status: 'ok'; config: Config }
  | { status: 'invalid'; error: ConfigFileError }

/**
 * Read `config.json` without throwing, for a caller that has to tell a
 * missing file from one that exists but cannot be used.
 */
export function readConfigFile(): ConfigFileRead {
  const read = readJsonObjectFile(CONFIG_PATH)
  if (read.status === 'missing') return read
  if (read.status === 'invalid') return { status: 'invalid', error: new ConfigFileError(CONFIG_PATH, read.problem) }
  return { status: 'ok', config: read.value as Config }
}

/**
 * The configuration, or `null` when there is no `config.json`. A file that
 * exists but cannot be used throws `ConfigFileError`: returning `null` for it
 * made every `loadConfig() ?? {}` caller save defaults over the user's file.
 */
export function loadConfig(): Config | null {
  const read = readConfigFile()
  if (read.status === 'invalid') throw read.error
  return read.status === 'ok' ? read.config : null
}

/**
 * Write `config.json` through a temporary file and a rename. Throws
 * `ConfigFileError`, writing nothing, when the file on disk cannot be used:
 * whatever is being saved was not built from it.
 */
export function saveConfig(config: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 })
  const existing = readConfigFile()
  if (existing.status === 'invalid') throw existing.error
  writeFileAtomic(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 })
}

export function buildConsentConfig(config: Config): ConsentConfig | null {
  const sync = config.sync
  if (!sync) return null

  // Cloud sync uses device auth (HMAC), not consent
  if (sync.backend === 'cloud') return null

  const backend = sync.backend
  const target = backend === 'github'
    ? sync.repo ?? ''
    : `${sync.bucket}/${sync.prefix ?? 'aiusage/'}`
  const endpoint = backend === 'github'
    ? 'https://api.github.com'
    : sync.endpoint ?? 'https://s3.amazonaws.com'
  const region = backend === 'github' ? 'global' : (sync.region ?? 'auto')

  return {
    backend,
    target,
    endpoint,
    region,
    fields: SYNC_FIELDS,
    operations: ['read', 'write'],
    schemaVersion: 'v1',
  }
}

export function loadCredential(key: string): string | null {
  const config = loadConfig()
  if (!config?.credentials) return null
  return config.credentials[key] ?? null
}

export function saveCredential(key: string, value: string): void {
  const config = loadConfig() ?? {}
  if (!config.credentials) config.credentials = {}
  config.credentials[key] = value
  saveConfig(config)
}
