import type { State } from '../init.js'

export type SyncPhase = 'pulling' | 'merging' | 'uploading' | 'finalizing'

export interface SyncProgress {
  phase: SyncPhase
  currentPath?: string
  completedFiles?: number
  totalFiles?: number
  pulledCount?: number
  uploadedCount?: number
}

export interface SyncRuntimeStatus {
  isRunning: boolean
  startedAt?: number
  phase?: SyncPhase
  currentPath?: string
  completedFiles?: number
  totalFiles?: number
  pulledCount?: number
  uploadedCount?: number
}

export interface SyncStatusSnapshot {
  isRunning: boolean
  startedAt?: number
  phase?: SyncPhase
  currentPath?: string
  completedFiles?: number
  totalFiles?: number
  pulledCount?: number
  uploadedCount?: number
  lastSyncAt?: number
  lastSyncStatus?: State['lastSyncStatus']
  lastSyncError?: string
  lastSyncTarget?: string
  lastSyncUploaded?: number
  lastSyncPulled?: number
  lastSyncDurationMs?: number
  nextSyncAt?: number
}

export interface SyncStartResult {
  accepted: boolean
  alreadyRunning: boolean
  status: SyncStatusSnapshot
}

/** How a background run ended, as far as the status needs to know. */
export interface SyncRunOutcome {
  status: NonNullable<State['lastSyncStatus']>
  error?: string
}

interface SyncRuntimeOptions {
  /**
   * Runs one sync. It may return the outcome; a failure is then shown in the
   * status even when it could not be recorded in `state.json`. A throw is
   * caught and shown the same way.
   */
  runSync: (options: {
    onProgress?: (progress: SyncProgress) => void
    /** Call with the target the run actually syncs; without it, the one configured at the start counts. */
    onTarget?: (target: string) => void
  }) => Promise<SyncRunOutcome | void>
  getPersistedState: () => State | null
  getCurrentTarget?: () => string | null
}

/** A background run that did not end well, kept until the next one starts. */
interface FailedRun extends SyncRunOutcome {
  /** The target the run was for; the failure is shown for no other. */
  target: string | null
  startedAt: number
  finishedAt: number
}

export class SyncRuntimeController {
  private readonly runSyncFn: SyncRuntimeOptions['runSync']
  private readonly getPersistedState: SyncRuntimeOptions['getPersistedState']
  private readonly getCurrentTarget?: SyncRuntimeOptions['getCurrentTarget']
  private current: SyncRuntimeStatus = { isRunning: false }
  private lastFailedRun?: FailedRun
  private _nextSyncAt?: number

  constructor(options: SyncRuntimeOptions) {
    this.runSyncFn = options.runSync
    this.getPersistedState = options.getPersistedState
    this.getCurrentTarget = options.getCurrentTarget
  }

  start(): SyncStartResult {
    if (this.current.isRunning) {
      return {
        accepted: false,
        alreadyRunning: true,
        status: this.getStatus(),
      }
    }

    const startedAt = Date.now()
    this.current = {
      isRunning: true,
      startedAt,
    }
    this.lastFailedRun = undefined

    // Yield one tick so the HTTP handler can flush its response before sync work starts.
    const target = this.statusTarget(this.getPersistedState())
    setImmediate(() => {
      void this.runInBackground(startedAt, target)
    })

    return {
      accepted: true,
      alreadyRunning: false,
      status: this.getStatus(),
    }
  }

  setNextSyncAt(ts: number | undefined): void {
    this._nextSyncAt = ts
  }

  getStatus(): SyncStatusSnapshot {
    const persisted = this.getPersistedState()
    const target = this.statusTarget(persisted)
    const targetStatus = target ? persisted?.syncTargets?.[target] : undefined
    const legacyStatus = !target || persisted?.lastSyncTarget === target
      ? {
          lastSyncAt: persisted?.lastSyncAt,
          lastSyncStatus: persisted?.lastSyncStatus,
          lastSyncError: persisted?.lastSyncError,
          lastSyncTarget: persisted?.lastSyncTarget,
          lastSyncUploaded: persisted?.lastSyncUploaded,
          lastSyncPulled: persisted?.lastSyncPulled,
          lastSyncDurationMs: persisted?.lastSyncDurationMs,
        }
      : {}
    const status = { ...(targetStatus ?? legacyStatus) }
    // A run that failed without leaving a newer entry in `state.json` — it
    // threw, or what it returned could not be stored there — would otherwise
    // be invisible: the status would still show the sync before it.
    const failed = this.lastFailedRun
    if (failed && failed.target === (target ?? null)
      && !(status.lastSyncAt !== undefined && status.lastSyncAt >= failed.startedAt)) {
      status.lastSyncAt = failed.finishedAt
      status.lastSyncStatus = failed.status
      status.lastSyncError = failed.error
      status.lastSyncUploaded = undefined
      status.lastSyncPulled = undefined
      status.lastSyncDurationMs = failed.finishedAt - failed.startedAt
    }
    return {
      ...this.current,
      ...status,
      lastSyncTarget: status.lastSyncTarget ?? target ?? undefined,
      nextSyncAt: this._nextSyncAt,
    }
  }

  /**
   * The target the status is about: the configured one or, when there is none
   * or it cannot be read (the status must not throw), the one last synced.
   */
  private statusTarget(persisted: State | null): string | undefined {
    let current: string | null = null
    try {
      current = this.getCurrentTarget?.() ?? null
    } catch {}
    return current ?? persisted?.lastSyncTarget
  }

  /**
   * Never rejects: it is started with `void`, so a rejection would be an
   * unhandled one and end the process. Whatever the sync throws is logged and
   * kept for the status instead.
   */
  private async runInBackground(startedAt: number, target: string | undefined): Promise<void> {
    // The configuration is read again when the sync itself starts, which can
    // be a while after this run was queued; the sync reports what it used.
    let runTarget = target ?? null
    try {
      const outcome = await this.runSyncFn({
        onTarget: (used) => { runTarget = used },
        onProgress: (progress) => {
          this.current = {
            ...this.current,
            isRunning: true,
            phase: progress.phase,
            currentPath: progress.currentPath,
            completedFiles: progress.completedFiles,
            totalFiles: progress.totalFiles,
            pulledCount: progress.pulledCount,
            uploadedCount: progress.uploadedCount,
          }
        },
      })
      if (outcome && outcome.status !== 'ok' && outcome.status !== 'conflict_resolved') {
        this.lastFailedRun = { status: outcome.status, error: outcome.error, target: runTarget, startedAt, finishedAt: Date.now() }
      }
    } catch (error) {
      console.error('[sync] background sync failed:', error)
      this.lastFailedRun = {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        target: runTarget,
        startedAt,
        finishedAt: Date.now(),
      }
    } finally {
      this.current = { isRunning: false }
    }
  }
}
