import type Database from 'better-sqlite3'
import type { Config } from '../config.js'

export interface RuntimeSettingsControllerOptions {
  db: Database.Database
  loadConfig: () => Config | null
  runParse: (db: Database.Database) => Promise<unknown>
  runCleanup: (db: Database.Database, retentionDays: number) => unknown | Promise<unknown>
  runSync?: () => void
  onSyncScheduleChanged?: (nextSyncAt: number | undefined) => void
  cleanupIntervalMs?: number
}

const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const MIN_PARSE_INTERVAL_MS = 1000
const MIN_SYNC_INTERVAL_MS = 60 * 1000

/** A positive interval raised to `min`; 0, a negative or a non-number stays off (0). */
function atLeast(value: number, min: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(value, min) : 0
}
// Node keeps a timer delay in a 32-bit signed integer. It replaces a longer
// delay with 1 ms, so a 30-day setInterval fires continuously.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

export class RuntimeSettingsController {
  private readonly db: Database.Database
  private readonly loadConfigFn: RuntimeSettingsControllerOptions['loadConfig']
  private readonly runParseFn: RuntimeSettingsControllerOptions['runParse']
  private readonly runCleanupFn: RuntimeSettingsControllerOptions['runCleanup']
  private readonly runSyncFn: RuntimeSettingsControllerOptions['runSync']
  private readonly onSyncScheduleChangedFn: RuntimeSettingsControllerOptions['onSyncScheduleChanged']
  private readonly cleanupIntervalMs: number
  private parseTimer: ReturnType<typeof setInterval> | null = null
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private parseInFlight = false
  private cleanupInFlight = false
  private started = false

  constructor(options: RuntimeSettingsControllerOptions) {
    this.db = options.db
    this.loadConfigFn = options.loadConfig
    this.runParseFn = options.runParse
    this.runCleanupFn = options.runCleanup
    this.runSyncFn = options.runSync
    this.onSyncScheduleChangedFn = options.onSyncScheduleChanged
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS
  }

  start(): void {
    if (this.started) return
    this.started = true
    try { this.applyConfig() } catch (error) { this.started = false; throw error }
  }

  reload(): void {
    if (!this.started) return
    this.applyConfig()
  }

  stop(): void {
    this.started = false
    if (this.parseTimer) clearInterval(this.parseTimer)
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.parseTimer = null
    this.cleanupTimer = null
    this.syncTimer = null
  }

  private applyConfig(): void {
    const config = this.loadConfigFn()
    if (this.parseTimer) clearInterval(this.parseTimer)
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.parseTimer = null
    this.cleanupTimer = null
    this.syncTimer = null

    // The floors PUT /api/config enforces, applied here as well: releases
    // before it saved any value, and a refresh interval of 30 ms parsed back
    // to back.
    const parseInterval = atLeast(Number(config?.refreshInterval ?? config?.parseInterval ?? 0), MIN_PARSE_INTERVAL_MS)
    const rawRetention = config?.retentionDays
    const configuredRetention = typeof rawRetention === 'number' || typeof rawRetention === 'string' ? Number(rawRetention) : NaN
    const retentionDays = Number.isSafeInteger(configuredRetention) && configuredRetention > 0 ? configuredRetention : 0

    if (parseInterval > 0) {
      this.parseTimer = setInterval(() => {
        void this.runParseSafely()
      }, Math.min(parseInterval, MAX_TIMER_DELAY_MS))
    }

    if (retentionDays > 0) {
      this.cleanupTimer = setInterval(() => {
        void this.runCleanupSafely(retentionDays)
      }, this.cleanupIntervalMs)
    }

    // The reported next sync time uses the same clamped delay as the timer.
    const syncInterval = Math.min(atLeast(Number(config?.syncInterval ?? 0), MIN_SYNC_INTERVAL_MS), MAX_TIMER_DELAY_MS)
    if (syncInterval > 0 && config?.sync?.backend && this.runSyncFn) {
      const updateNextSyncAt = () => {
        this.onSyncScheduleChangedFn?.(Date.now() + syncInterval)
      }
      updateNextSyncAt()
      this.syncTimer = setInterval(() => {
        this.runSyncFn!()
        updateNextSyncAt()
      }, syncInterval)
    } else {
      this.onSyncScheduleChangedFn?.(undefined)
    }
  }

  private async runParseSafely(): Promise<void> {
    if (this.parseInFlight) return
    this.parseInFlight = true
    try {
      await this.runParseFn(this.db)
    } catch (err) {
      // Keep scheduling active after individual parse failures.
      console.error('[settings-controller] parse failed:', err)
    } finally {
      this.parseInFlight = false
    }
  }

  private async runCleanupSafely(retentionDays: number): Promise<void> {
    if (this.cleanupInFlight) return
    this.cleanupInFlight = true
    try {
      await this.runCleanupFn(this.db, retentionDays)
    } catch (err) {
      // Keep scheduling active after individual cleanup failures.
      console.error('[settings-controller] cleanup failed:', err)
    } finally {
      this.cleanupInFlight = false
    }
  }

}
