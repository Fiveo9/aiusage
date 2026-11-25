import http from 'node:http'
import { hostname, platform } from 'node:os'
import { fetchExchangeRate } from '@aiusage/core'
import { AIUSAGE_DIR, buildConsentConfig, loadConfig, saveConfig, updateConfig } from '../config.js'
import { withSettingsLock } from '../settings-lock.js'
import { JsonFileError } from '../json-file.js'
import { GitHubAuthError } from '../github/errors.js'
import { deleteGitHubCredentials, saveGitHubCredentials } from '../github/credentials.js'
import { credentialStatus, publicSyncConfig, setSyncCredentials } from './credential-settings.js'
import { createGitHubDeviceSessions } from '../github/device-sessions.js'
import { safeGitHubError, validateRepo } from '../github/auth.js'
import type { Config, SyncConfig } from '../config.js'
import { setSyncConsent } from '../init.js'
import { generateConsentFingerprint } from '../sync/consent.js'
import { getSyncTarget } from '../sync/target.js'
import { queryAllQuotas } from '../quota.js'
import { getSiteUrl } from '../site-url.js'
import { hasCredentials } from '../device-auth/credentials.js'
import { LOCAL_RECORDS_WHERE } from '../db/records.js'
import { BodyTooLargeError, readJsonBody } from './request-body.js'
import { json, bodyTooLarge, isDatabaseLockedError, databaseBusy } from './http-helpers.js'
import type { ApiRouteContext, ApiServices } from './context.js'

export async function proxyCloudSyncStatus(res: http.ServerResponse): Promise<void> {
  try {
    const upstream = new URL('/api/cli/sync/status', getSiteUrl())
    const response = await fetch(upstream, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    const contentType = response.headers.get('content-type') || ''
    if (!response.ok || !contentType.includes('application/json')) {
      json(res, { enabled: false })
      return
    }

    const data = await response.json().catch(() => null)
    json(res, data && typeof data.enabled === 'boolean' ? data : { enabled: false })
  } catch {
    json(res, { enabled: false })
  }
}

export function createConfigSyncRoutes(services: ApiServices) {
  const { db, options, runDbWrite } = services
  const githubDeviceAction = createGitHubDeviceSessions()
  return async (context: ApiRouteContext): Promise<boolean> => {
    const { req, res, url, range, from, to } = context
// ── /api/sync ──────────────────────────────────────────────────
  if (url.pathname === '/api/sync') {
    if (req.method === 'POST') {
      if (!options?.onSyncStart) {
        json(res, { error: { code: 'NOT_AVAILABLE', message: 'Sync not configured' } }, 501)
        return true
      }
      const result = options.onSyncStart()
      json(res, result, result.accepted ? 202 : 200)
      return true
    }
    // GET: sync status
    const status = options?.getSyncStatus?.() ?? null
    json(res, { status })
    return true
  }

  // ── /api/refresh ────────────────────────────────────────────────
  if (url.pathname === '/api/refresh') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      json(res, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST to refresh' } }, 405)
      return true
    }
    if (!options?.onRefresh) {
      json(res, { error: { code: 'NOT_AVAILABLE', message: 'Refresh not available' } }, 501)
      return true
    }
    try {
      const result = await runDbWrite(() => options.onRefresh!())
      json(res, result)
    } catch (error) {
      if (isDatabaseLockedError(error)) {
        databaseBusy(res)
        return true
      }
      throw error
    }
    return true
  }

  // ── /api/quotas ───────────────────────────────────────────────
  if (url.pathname === '/api/quotas' && req.method === 'GET') {
    const results = await queryAllQuotas()
    json(res, { quotas: results })
    return true
  }

  // ── /api/devices ──────────────────────────────────────────────
  if (url.pathname === '/api/devices') {
    const currentId = options?.currentDeviceInstanceId
    if (!currentId) {
      json(res, { currentDeviceInstanceId: null, devices: [] })
      return true
    }

    const config = loadConfig()
    const currentDeviceAlias = config?.device || hostname()

    // Current device: only local records (not merged from synced)
    const localRows = db.prepare(`
      SELECT device, device_instance_id AS deviceInstanceId, COUNT(*) AS recordCount
      FROM records
      WHERE device_instance_id = @currentId AND ${LOCAL_RECORDS_WHERE}
      GROUP BY device_instance_id
    `).all({ currentId }) as any[]

    // Other devices from synced_records (exclude current device's copy)
    const syncedRows = db.prepare(`
      SELECT device, device_instance_id AS deviceInstanceId, platform, COUNT(*) AS recordCount
      FROM synced_records
      WHERE device_instance_id != @currentId
      GROUP BY device_instance_id
    `).all({ currentId }) as any[]

    function getDisplayName(device: string, deviceInstanceId: string): string {
      if (deviceInstanceId === currentId) return currentDeviceAlias
      if (device && device !== 'unknown' && !/^[0-9a-f]{8}$/.test(device)) return device
      if (/^[0-9a-f]{8}-/.test(deviceInstanceId)) return deviceInstanceId.slice(0, 8)
      if (device && device !== 'unknown') return device
      return 'Unknown Device'
    }

    function getPlatformLabel(p: string | undefined): string {
      if (p === 'win32') return 'Windows'
      if (p === 'darwin') return 'macOS'
      if (p === 'linux') return 'Linux'
      return ''
    }

    // Infer platform from device name when sync record has no platform field
    function inferPlatform(device: string, deviceInstanceId: string): string {
      const name = (device || '').toLowerCase()
      const id = (deviceInstanceId || '').toLowerCase()
      // Windows hostnames: DESKTOP-XXXXX, LAPTOP-XXXXX
      if (/^(desktop|laptop)-/.test(name)) return 'Windows'
      // macOS: .local suffix, "macbook", "imac", "mac-mini"
      if (name.endsWith('.local') || /macbook|imac|mac\s*mini|mac\s*pro|mac\s*studio/.test(name)) return 'macOS'
      // Linux common hostnames
      if (/^(ubuntu|debian|centos|fedora|arch|linux|server|node|prod|dev|staging)/.test(name)) return 'Linux'
      // If displayName is just a UUID prefix (8 hex chars), platform is unknown
      return ''
    }

    // Current platform
    const currentPlatform = config?.platform || platform()

    // Merge and deduplicate
    const deviceMap = new Map<string, { device: string; deviceInstanceId: string; displayName: string; platform: string; recordCount: number }>()
    for (const row of localRows) {
      const displayName = getDisplayName(row.device, row.deviceInstanceId)
      deviceMap.set(row.deviceInstanceId, { device: row.device, deviceInstanceId: row.deviceInstanceId, displayName, platform: getPlatformLabel(currentPlatform), recordCount: row.recordCount })
    }
    for (const row of syncedRows) {
      const displayName = getDisplayName(row.device, row.deviceInstanceId)
      const platformLabel = getPlatformLabel(row.platform) || inferPlatform(row.device, row.deviceInstanceId)
      const existing = deviceMap.get(row.deviceInstanceId)
      if (existing) {
        existing.recordCount += row.recordCount
      } else {
        deviceMap.set(row.deviceInstanceId, { device: row.device, deviceInstanceId: row.deviceInstanceId, displayName, platform: platformLabel, recordCount: row.recordCount })
      }
    }

    const devices = [...deviceMap.values()].sort((a, b) => b.recordCount - a.recordCount)
    json(res, { currentDeviceInstanceId: currentId, devices })
    return true
  }
// Only configured state for a sync target is exposed, never keys or values.
  if (url.pathname.startsWith('/api/github/') && req.method === 'POST') {
    try {
      const body = await readJsonBody(req, 4096)
      const action = url.pathname.slice('/api/github/'.length)
      const result = await githubDeviceAction(action, body)
      if (action === 'connect' && result.ok) options?.onConfigUpdated?.()
      json(res, result)
    } catch (error) {
      if (error instanceof BodyTooLargeError) { bodyTooLarge(res); return true }
      json(res, { error: { code: 'GITHUB_AUTH_FAILED', message: safeGitHubError(error) } }, 400)
    }
    return true
  }

  if (url.pathname === '/api/config/credentials/status' && req.method === 'GET') {
    const backend = url.searchParams.get('backend')
    const sync = backend === 'github' || backend === 's3'
      ? { backend, repo: url.searchParams.get('repo') ?? '', bucket: url.searchParams.get('bucket') ?? '' } as SyncConfig
      : undefined
    json(res, sync ? credentialStatus(loadConfig() ?? {}, sync) : {})
    return true
  }

  // ── /api/config ───────────────────────────────────────────────
  if (url.pathname === '/api/config') {
    if (req.method === 'GET') {
      const currentCfg = loadConfig() ?? {}
      const osPlatform = platform()
      const { credentials, priceOverrides, platform: _cfgPlatform, sources: _legacySources, ...rest } = currentCfg
      json(res, {
        device: rest.device ?? null,
        weekStart: rest.weekStart ?? 1,
        refreshInterval: rest.refreshInterval ?? rest.dashboardPollInterval ?? rest.parseInterval ?? null,
        retentionDays: rest.retentionDays ?? null,
        sync: publicSyncConfig(rest.sync),
        syncInterval: rest.syncInterval ?? null,
        loggedIn: hasCredentials(),
        displayCurrency: rest.displayCurrency ?? 'USD',
        exchangeRate: rest.exchangeRate ?? null,
        exchangeRateCache: rest.exchangeRateCache ?? null,
        siteUrl: getSiteUrl(),
        credentialStatus: credentialStatus(currentCfg),
        hostname: hostname(),
        platform: osPlatform,
      })
      return true
    }

    if (req.method === 'PUT') {
      let update: Record<string, unknown>
      try {
        update = await readJsonBody(req)
      } catch (error) {
        if (error instanceof BodyTooLargeError) { bodyTooLarge(res); return true }
        json(res, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400)
        return true
      }
      for (const field of ['credentials', 'syncCredentials'] as const) {
        const values = update[field]
        if (values == null) continue
        if (typeof values !== 'object' || Array.isArray(values)
          || Object.values(values).some(value => value != null && typeof value !== 'string')) {
          json(res, { error: { code: 'INVALID_CREDENTIALS', message: `${field} must be an object of string values` } }, 400)
          return true
        }
      }
      let retentionDays: number | undefined
      if ('retentionDays' in update) {
        const raw = update.retentionDays
        if (!(raw == null || raw === false || raw === '' || raw === 0 || raw === '0')) {
          const value = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN
          if (!Number.isSafeInteger(value) || value <= 0) {
            json(res, { error: { code: 'INVALID_RETENTION_DAYS', message: 'retentionDays must be a positive safe integer or explicitly disabled' } }, 400)
            return true
          }
          retentionDays = value
        }
      }
      // Set once config.json is written: a failure after that point (the
      // consent in state.json) must not be reported as nothing saved.
      let configSaved = false
      const syncCredentials = update.syncCredentials && typeof update.syncCredentials === 'object'
        ? update.syncCredentials as Record<string, unknown> : undefined
      // A new GitHub token goes to the OS keychain first, outside the
      // settings lock: the keychain can wait on the user (an access
      // prompt), and other processes must not wait on that to save
      // state.json or config.json. It is removed again unless the saved
      // config refers to it.
      let storedTokenId: string | undefined
      let storedTokenKept = false
      let retiredTokenId: string | undefined
      try {
        const githubToken = syncCredentials?.githubToken
        if (typeof githubToken === 'string' && githubToken) {
          storedTokenId = saveGitHubCredentials({ method: 'pat', accessToken: githubToken })
        }
        // Read, change and save under the settings lock, so that a change
        // another process saves meanwhile (`aiusage init`, a login, a
        // sync) is not written over with the copy read here.
        const saved = withSettingsLock(AIUSAGE_DIR, (): boolean => {
          const existing: Config = loadConfig() ?? {}
          const oldTokenId = existing.sync?.githubAuth?.credentialId
          const requestedSync = update.sync && typeof update.sync === 'object' ? update.sync as Record<string, unknown> : undefined
          const githubRef = requestedSync?.backend === 'github'
            ? requestedSync.credentialRef ?? existing.sync?.credentialRef
            : existing.sync?.backend === 'github' ? existing.sync.credentialRef : undefined
          if (update.credentials && Object.entries(update.credentials).some(([key, value]) => typeof value === 'string' && value
            && (/^(?:AIUSAGE_)?GITHUB_?TOKEN$/i.test(key) || /^github\/.+\/token$/i.test(key)
              || key === githubRef || /^(?:gh[pousr]_|github_pat_)/.test(value)))) {
            json(res, { error: { code: 'INVALID_CREDENTIALS', message: 'Use write-only syncCredentials.githubToken for GitHub credentials' } }, 400)
            return false
          }

          if ('device' in update) {
            if (!update.device) delete existing.device
            else existing.device = String(update.device)
          }
          if ('weekStart' in update) {
            const ws = Number(update.weekStart)
            if (ws === 0 || ws === 1) {
              existing.weekStart = ws as 0 | 1
            } else {
              delete existing.weekStart
            }
          }
          if ('displayCurrency' in update) {
            const dc = update.displayCurrency
            if (dc === 'USD' || dc === 'CNY') {
              existing.displayCurrency = dc
            } else {
              delete existing.displayCurrency
            }
          }
          if ('exchangeRate' in update) {
            const er = update.exchangeRate
            if (er != null && typeof er === 'number' && er > 0) {
              existing.exchangeRate = er
            } else {
              delete existing.exchangeRate
            }
          }

          // Milliseconds. A delay above 2^31 - 1 overflows a Node timer, which then
          // fires every 1 ms, and a value typed in seconds runs back to back.
          // A blank or zero value still clears the setting.
          const intervalBounds: Array<[string, number, number]> = [
            ['refreshInterval', 1000, 2147483647],
            ['syncInterval', 60000, 2147483647],
          ]
          const intervals: Record<string, number | undefined> = {}
          for (const [field, min, max] of intervalBounds) {
            const raw = update[field]
            if (raw == null || raw === false || raw === '' || raw === 0 || raw === '0') continue
            const value = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN
            if (!Number.isFinite(value) || value < min || value > max) {
              json(res, { error: { code: 'INVALID_INTERVAL', message: `${field} must be a number of milliseconds between ${min} and ${max}` } }, 400)
              return false
            }
            intervals[field] = value
          }

          if ('refreshInterval' in update) {
            if (intervals.refreshInterval == null) {
              delete existing.refreshInterval
            } else {
              existing.refreshInterval = intervals.refreshInterval
            }
            // Clean up legacy fields
            delete existing.dashboardPollInterval
            delete existing.parseInterval
          }
          if ('retentionDays' in update) {
            if (retentionDays == null) delete existing.retentionDays
            else existing.retentionDays = retentionDays
          }
          if ('syncInterval' in update) {
            const si = intervals.syncInterval
            if (si != null) {
              existing.syncInterval = si
            } else {
              delete existing.syncInterval
            }
          }

          if ('sync' in update) {
            const syncUpdate = update.sync as Record<string, unknown> | null
            if (!syncUpdate?.backend) {
              delete existing.sync
            } else {
              const backendVal = String(syncUpdate.backend)
              if (backendVal !== 'github' && backendVal !== 's3' && backendVal !== 'cloud') {
                json(res, { error: { code: 'INVALID_BACKEND', message: 'sync.backend must be cloud, github, or s3' } }, 400)
                return false
              }
              // Merge with existing sync config to preserve fields from other backends
              const newSync: SyncConfig = { ...existing.sync, backend: backendVal as 'github' | 's3' | 'cloud' }
              for (const f of ['repo', 'bucket', 'prefix', 'endpoint', 'region', 'credentialRef'] as const) {
                if (syncUpdate[f] === '' && ['prefix', 'endpoint', 'region', 'credentialRef'].includes(f)) {
                  if (f === 'prefix') newSync.prefix = '' // Explicit root, not the default aiusage/ prefix.
                  else delete newSync[f]
                } else if (syncUpdate[f] != null && syncUpdate[f] !== '') (newSync as any)[f] = String(syncUpdate[f])
              }
              if (newSync.repo !== existing.sync?.repo) {
                delete newSync.githubAuth
                delete newSync.branch
                delete newSync.credentialRef
              }
              if (newSync.backend === 'github' && newSync.repo) validateRepo(newSync.repo)
              if (newSync.backend === 'github' && !newSync.repo) {
                json(res, { error: { code: 'INVALID_SYNC_CONFIG', message: 'sync.repo is required for GitHub sync' } }, 400)
                return false
              }
              if (newSync.backend === 's3' && !newSync.bucket) {
                json(res, { error: { code: 'INVALID_SYNC_CONFIG', message: 'sync.bucket is required for S3 sync' } }, 400)
                return false
              }
              existing.sync = newSync
            }
          }

          if (update.credentials && typeof update.credentials === 'object') {
            const creds = update.credentials as Record<string, unknown>
            const c: Record<string, string> = { ...existing.credentials }
            for (const [key, val] of Object.entries(creds)) {
              if (typeof val === 'string' && val !== '') {
                c[key] = val
              }
            }
            if (Object.keys(c).length) existing.credentials = c
            else delete existing.credentials
          }

          if (syncCredentials) setSyncCredentials(existing, syncCredentials, storedTokenId)

          saveConfig(existing)
          configSaved = true
          services.weekStart = (existing.weekStart ?? 1) as 0 | 1
          storedTokenKept = storedTokenId !== undefined && existing.sync?.githubAuth?.credentialId === storedTokenId
          if (oldTokenId && oldTokenId !== existing.sync?.githubAuth?.credentialId) retiredTokenId = oldTokenId
          const consentConfig = buildConsentConfig(existing)
          const syncTarget = getSyncTarget(existing.sync)
          if (consentConfig && syncTarget) {
            setSyncConsent(AIUSAGE_DIR, syncTarget, {
              syncConsentAt: Date.now(),
              syncConsentTarget: generateConsentFingerprint(consentConfig),
            })
          }
          return true
        })
        if (!saved) return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (configSaved) {
          // The settings are in config.json: run with them, and say what failed.
          options?.onConfigUpdated?.()
          json(res, { error: { code: 'CONSENT_NOT_SAVED', message: `The settings were saved, but the sync consent was not: ${message}` } }, 500)
        } else if (error instanceof GitHubAuthError) {
          json(res, { error: { code: 'INVALID_SYNC_CONFIG', message } }, 400)
        } else {
          json(res, { error: { code: error instanceof JsonFileError ? 'SETTINGS_FILE_UNUSABLE' : 'CONFIG_NOT_SAVED', message } }, 500)
        }
        return true
      } finally {
        if (storedTokenId && !storedTokenKept) deleteGitHubCredentials(storedTokenId)
        if (retiredTokenId) deleteGitHubCredentials(retiredTokenId)
      }
      options?.onConfigUpdated?.()
      json(res, { ok: true })
      return true
    }
  }
// ── /api/exchange-rate/refresh ────────────────────────────────
  if (url.pathname === '/api/exchange-rate/refresh' && req.method === 'POST') {
    const rate = await fetchExchangeRate()
    if (rate == null) {
      json(res, { error: { code: 'FETCH_FAILED', message: 'Failed to fetch exchange rate' } }, 502)
      return true
    }
    const exchangeRateCache = { CNY_USD: rate, fetchedAt: Date.now() }
    updateConfig((cfg) => { cfg.exchangeRateCache = exchangeRateCache })
    json(res, { rate, fetchedAt: exchangeRateCache.fetchedAt })
    return true
  }
    return false
  }
}
