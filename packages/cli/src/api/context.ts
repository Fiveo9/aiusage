import http from 'node:http'
import type Database from 'better-sqlite3'
import type { SyncStartResult, SyncStatusSnapshot } from '../sync/runtime.js'
import { type AsyncTaskQueueStatus } from '../db/write-queue.js'

export interface ApiServerOptions {
  currentDeviceInstanceId?: string
  onRefresh?: () => Promise<{ parsedCount: number; toolCallCount: number; errors: string[] }>
  onSyncStart?: () => SyncStartResult
  getSyncStatus?: () => SyncStatusSnapshot | null
  onConfigUpdated?: () => void
  runDbWrite?: <T>(task: () => T | Promise<T>) => Promise<T>
  getDbWriteQueueStatus?: () => AsyncTaskQueueStatus
}

export interface ApiServices {
  db: Database.Database
  options?: ApiServerOptions
  runDbWrite: <T>(task: () => T | Promise<T>) => Promise<T>
  getDbWriteQueueStatus: () => AsyncTaskQueueStatus
  /** Live server state; config commits update the factory's getter/setter. */
  weekStart: 0 | 1
}

export interface ApiRequestContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: URL
}

export interface ApiRouteContext extends ApiRequestContext {
  services: ApiServices
  range: string | null
  from: string | null
  to: string | null
}
