import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { State } from '../../src/init.js'
import { SyncRuntimeController } from '../../src/sync/runtime.js'

/** Resolves once the controller's background run has finished. */
async function settled(controller: SyncRuntimeController): Promise<void> {
  for (let i = 0; i < 200 && controller.getStatus().isRunning; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  expect(controller.getStatus().isRunning).toBe(false)
}

describe('SyncRuntimeController: a background sync that fails (#103)', () => {
  let rejections: unknown[]
  const onRejection = (reason: unknown) => { rejections.push(reason) }
  let persisted: State | null

  beforeEach(() => {
    rejections = []
    persisted = { deviceInstanceId: 'dev', lastSyncStatus: 'ok', lastSyncAt: 1000, lastSyncTarget: 'cloud', lastSyncUploaded: 3 }
    process.on('unhandledRejection', onRejection)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.off('unhandledRejection', onRejection)
    vi.restoreAllMocks()
  })

  it('does not let a throw escape as an unhandled rejection, and shows it in the status', async () => {
    const controller = new SyncRuntimeController({
      runSync: async () => { throw new TypeError("Cannot read properties of null (reading 'deviceInstanceId')") },
      getPersistedState: () => persisted,
    })

    expect(controller.start().accepted).toBe(true)
    await settled(controller)
    // An unhandled rejection is reported after the microtask queue drains.
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(rejections).toEqual([])
    const status = controller.getStatus()
    expect(status.lastSyncStatus).toBe('failed')
    expect(status.lastSyncError).toContain('deviceInstanceId')
    expect(status.lastSyncAt).toBeGreaterThan(1000)
    expect(console.error).toHaveBeenCalled()
  })

  it('keeps running syncs afterwards, and a later success replaces the error', async () => {
    let fail = true
    const controller = new SyncRuntimeController({
      runSync: async () => {
        if (fail) throw new Error('boom')
        persisted = { ...persisted!, lastSyncStatus: 'ok', lastSyncAt: Date.now(), lastSyncError: undefined }
      },
      getPersistedState: () => persisted,
    })

    controller.start()
    await settled(controller)
    expect(controller.getStatus()).toMatchObject({ lastSyncStatus: 'failed', lastSyncError: 'boom' })

    fail = false
    expect(controller.start().accepted).toBe(true)
    await settled(controller)
    const status = controller.getStatus()
    expect(status.lastSyncStatus).toBe('ok')
    expect(status.lastSyncError).toBeUndefined()
  })

  it('shows a failed result that could not be written to state.json', async () => {
    const controller = new SyncRuntimeController({
      runSync: async () => ({ status: 'failed', error: 'Cannot use state.json: it is not valid JSON.' }),
      getPersistedState: () => null,
      getCurrentTarget: () => 'cloud',
    })

    controller.start()
    await settled(controller)
    expect(controller.getStatus()).toMatchObject({
      lastSyncStatus: 'failed',
      lastSyncError: 'Cannot use state.json: it is not valid JSON.',
      lastSyncTarget: 'cloud',
    })
  })

  it('leaves a result that was written to state.json to state.json', async () => {
    const controller = new SyncRuntimeController({
      runSync: async () => {
        persisted = { ...persisted!, lastSyncStatus: 'failed', lastSyncError: 'HTTP 500', lastSyncAt: Date.now(), lastSyncUploaded: 0 }
        return { status: 'failed', error: 'HTTP 500' }
      },
      getPersistedState: () => persisted,
    })

    controller.start()
    await settled(controller)
    expect(controller.getStatus()).toMatchObject({ lastSyncStatus: 'failed', lastSyncError: 'HTTP 500', lastSyncAt: persisted!.lastSyncAt, lastSyncUploaded: 0 })
  })

  it('shows a failure only for the target the run was for', async () => {
    const a = 'github:user/a'
    const b = 'github:user/b'
    let current = a
    persisted = {
      deviceInstanceId: 'dev', lastSyncStatus: 'ok', lastSyncTarget: b,
      syncTargets: {
        [a]: { lastSyncAt: 1000, lastSyncStatus: 'ok', lastSyncTarget: a },
        [b]: { lastSyncAt: 2000, lastSyncStatus: 'ok', lastSyncTarget: b, lastSyncUploaded: 7 },
      },
    }
    const controller = new SyncRuntimeController({
      runSync: async () => { throw new Error('repository a is gone') },
      getPersistedState: () => persisted,
      getCurrentTarget: () => current,
    })

    controller.start()
    await settled(controller)
    expect(controller.getStatus()).toMatchObject({ lastSyncTarget: a, lastSyncStatus: 'failed', lastSyncError: 'repository a is gone' })

    // The configuration now points at another target, which last synced fine.
    current = b
    const status = controller.getStatus()
    expect(status).toMatchObject({ lastSyncTarget: b, lastSyncStatus: 'ok', lastSyncAt: 2000, lastSyncUploaded: 7 })
    expect(status.lastSyncError).toBeUndefined()

    current = a
    expect(controller.getStatus()).toMatchObject({ lastSyncTarget: a, lastSyncStatus: 'failed' })
  })

  it('ties a failure to the target the sync reports it used, not the one configured when it was queued', async () => {
    const a = 'github:user/a'
    const b = 'github:user/b'
    let current = a
    persisted = {
      deviceInstanceId: 'dev', lastSyncStatus: 'ok', lastSyncTarget: a,
      syncTargets: {
        [a]: { lastSyncAt: 1000, lastSyncStatus: 'ok', lastSyncTarget: a },
        [b]: { lastSyncAt: 2000, lastSyncStatus: 'ok', lastSyncTarget: b },
      },
    }
    const controller = new SyncRuntimeController({
      // The configuration changed while the run waited its turn: it syncs b.
      runSync: async ({ onTarget }) => {
        current = b
        onTarget?.(b)
        return { status: 'failed', error: 'Could not create sync backend. Check credentials.' }
      },
      getPersistedState: () => persisted,
      getCurrentTarget: () => current,
    })

    controller.start()
    await settled(controller)
    expect(controller.getStatus()).toMatchObject({ lastSyncTarget: b, lastSyncStatus: 'failed', lastSyncError: 'Could not create sync backend. Check credentials.' })
    current = a
    const status = controller.getStatus()
    expect(status).toMatchObject({ lastSyncTarget: a, lastSyncStatus: 'ok', lastSyncAt: 1000 })
    expect(status.lastSyncError).toBeUndefined()
  })

  it('reports the status even when reading the current target fails', async () => {
    const controller = new SyncRuntimeController({
      runSync: async () => {},
      getPersistedState: () => persisted,
      getCurrentTarget: () => { throw new Error('config.json does not parse') },
    })
    expect(() => controller.getStatus()).not.toThrow()
    expect(controller.start().accepted).toBe(true)
    await settled(controller)
  })
})
