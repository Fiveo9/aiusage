import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import type { Config } from '../../src/config.js'
import type { State } from '../../src/init.js'
import { FakeSyncBackend } from '../sync/helpers/fake-backend.js'

const root = mkdtempSync(join(tmpdir(), 'aiusage-file-sync-lock-'))
class PreparedBackend extends FakeSyncBackend {
  async prepare() {}
  async deleteAllData() {
    const count = [...this.files.keys()].filter(path => path.endsWith('.ndjson')).length
    for (const path of [...this.files.keys()]) await this.deleteFile(path)
    return count
  }
}
const shared = vi.hoisted(() => ({ config: {} as Config, state: null as State | null, backend: null as PreparedBackend | null }))
vi.mock('../../src/config.js', async () => ({
  ...await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js'),
  AIUSAGE_DIR: root,
  readConfigFile: () => ({ status: 'ok', config: shared.config }),
  loadConfig: () => shared.config,
  loadCredential: () => 'synthetic-only',
}))
vi.mock('../../src/init.js', async () => ({
  ...await vi.importActual<typeof import('../../src/init.js')>('../../src/init.js'),
  getState: () => shared.state,
  setSyncTargetState: () => {},
  updateState: (_root: string, update: (state: State | null) => State) => shared.state = update(shared.state),
}))
vi.mock('../../src/sync/consent.js', () => ({ verifyConsent: () => true }))
vi.mock('../../src/sync/git.js', () => ({ GitSyncBackend: vi.fn(function () { return shared.backend }) }))
vi.mock('../../src/sync/s3.js', () => ({ S3SyncBackend: vi.fn(function () { return shared.backend }) }))

const { initializeDatabase } = await import('../../src/db/index.js')
const { runSync, runSyncRepair } = await import('../../src/commands/sync.js')
const { propagateClean } = await import('../../src/commands/clean.js')
const { acquireFileSyncLock } = await import('../../src/lock.js')
const { getSyncTarget } = await import('../../src/sync/target.js')

describe('file backend shared cross-process lock entrypoints', () => {
  let db: Database.Database
  let held: (() => void) | null = null
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    shared.backend = new PreparedBackend()
    configure('github')
  })
  afterEach(() => { held?.(); held = null; db.close(); vi.restoreAllMocks() })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  function configure(backend: 'github' | 's3') {
    shared.config = { sync: backend === 'github'
      ? { backend, repo: 'synthetic/repo', githubAuth: { method: 'pat', credentialId: 'synthetic' } }
      : { backend, bucket: 'synthetic', prefix: 'aiusage/' } }
    const target = getSyncTarget(shared.config.sync)!
    shared.state = { deviceInstanceId: 'own', lastSyncStatus: 'ok', syncConsents: { [target]: { syncConsentAt: 1, syncConsentTarget: 'synthetic' } } }
  }

  it.each(['github', 's3'] as const)('blocks sync, repair and clean before remote I/O for %s', async backend => {
    configure(backend)
    const prepare = vi.spyOn(shared.backend!, 'prepare')
    held = acquireFileSyncLock(root)
    expect(held).not.toBeNull()
    expect((await runSync(db)).status).toBe('failed')
    expect((await runSyncRepair(db, { apply: true })).status).toBe('failed')
    expect((await propagateClean({ all: true })).backends[0].status).toBe('failed')
    expect(prepare).not.toHaveBeenCalled()
    held!(); held = null
    expect((await runSync(db)).status).toBe('ok')
    expect((await runSyncRepair(db)).status).toBe('ok')
    expect((await propagateClean({ all: true })).backends[0].status).toBe('ok')
  })

  it.each(['sync', 'repair', 'clean'])('releases the lock after a failed %s', async mode => {
    vi.spyOn(shared.backend!, 'prepare').mockRejectedValueOnce(new Error('synthetic preparation failure'))
    if (mode === 'sync') expect((await runSync(db)).status).toBe('failed')
    else if (mode === 'repair') expect((await runSyncRepair(db)).status).toBe('failed')
    else expect((await propagateClean({ all: true })).backends[0].status).toBe('failed')
    held = acquireFileSyncLock(root)
    expect(held).not.toBeNull()
  })
})
