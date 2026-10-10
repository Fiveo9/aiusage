import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeSettingsController } from '../../src/runtime/settings-controller.js'
import { recordLeaderboardUpload } from '../../src/commands/leaderboard-upload.js'
import { ensureAiusageDir, getState, setState } from '../../src/init.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const START = Date.parse('2026-01-01T00:00:00Z')
const stored = { totalTokens: 100, response: { request_id: 'r1', status: 'accepted', snapshots: [] } }
const rejected = { totalTokens: 100, response: { request_id: '', status: 'rejected', snapshots: [] } }
const empty = { totalTokens: 0, response: null }

describe('manual leaderboard uploads and the auto-upload schedule', () => {
  let dir: string
  let config: Record<string, unknown>
  let runLeaderboardUpload: ReturnType<typeof vi.fn>
  const controllers: RuntimeSettingsController[] = []

  function createController(persisted = true): RuntimeSettingsController {
    const controller = new RuntimeSettingsController({
      db: {} as any,
      loadConfig: () => config as any,
      runParse: (async () => {}) as any,
      runCleanup: (() => {}) as any,
      runLeaderboardUpload: runLeaderboardUpload as any,
      getLastLeaderboardUploadAt: persisted ? () => getState(dir)?.lastLeaderboardUploadAt : () => undefined,
      setLastLeaderboardUploadAt: persisted ? (ts: number) => setState(dir, { lastLeaderboardUploadAt: ts }) : () => {},
    })
    controllers.push(controller)
    return controller
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiusage-manual-upload-'))
    ensureAiusageDir(dir)
    config = { leaderboardAutoUpload: true, leaderboardUploadInterval: WEEK }
    runLeaderboardUpload = vi.fn(async () => true)
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })

  afterEach(() => {
    for (const controller of controllers.splice(0)) controller.stop()
    vi.restoreAllMocks()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('recordLeaderboardUpload', () => {
    it('stores the time of an upload the site took', () => {
      const before = getState(dir)!

      expect(recordLeaderboardUpload(stored, dir)).toBe(START)

      expect(getState(dir)).toEqual({ ...before, lastLeaderboardUploadAt: START })
    })

    it('stores a flagged upload as well', () => {
      expect(recordLeaderboardUpload({ ...stored, response: { ...stored.response, status: 'flagged' } }, dir)).toBe(START)
      expect(getState(dir)?.lastLeaderboardUploadAt).toBe(START)
    })

    it('stores nothing for a rejected or an empty upload', () => {
      expect(recordLeaderboardUpload(rejected, dir)).toBeUndefined()
      expect(recordLeaderboardUpload(empty, dir)).toBeUndefined()

      expect(getState(dir)?.lastLeaderboardUploadAt).toBeUndefined()
    })

    it('still reports the upload when state.json cannot be written', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const missing = join(dir, 'missing')

      expect(recordLeaderboardUpload(stored, missing)).toBe(START)
    })
  })

  it('pushes the next auto upload out by one interval after a manual upload in the same process', async () => {
    setState(dir, { lastLeaderboardUploadAt: START })
    const controller = createController()

    controller.start()
    await vi.advanceTimersByTimeAsync(6 * DAY)
    controller.noteLeaderboardUpload(recordLeaderboardUpload(stored, dir)!)

    await vi.advanceTimersByTimeAsync(WEEK - 1)
    expect(runLeaderboardUpload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
  })

  it('picks up a manual upload from another process when its timer fires', async () => {
    setState(dir, { lastLeaderboardUploadAt: START })
    const controller = createController()

    controller.start()
    await vi.advanceTimersByTimeAsync(6 * DAY)
    // Another process, such as `aiusage leaderboard upload`, only writes state.json.
    recordLeaderboardUpload(stored, dir)

    await vi.advanceTimersByTimeAsync(WEEK - 1)
    expect(runLeaderboardUpload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
  })

  it('does not move the schedule for a manual upload that was not stored', async () => {
    setState(dir, { lastLeaderboardUploadAt: START })
    const controller = createController()

    controller.start()
    await vi.advanceTimersByTimeAsync(6 * DAY)
    expect(recordLeaderboardUpload(rejected, dir)).toBeUndefined()

    await vi.advanceTimersByTimeAsync(DAY - 1)
    expect(runLeaderboardUpload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
  })

  it('moves the schedule even when the time could not be stored', async () => {
    const controller = createController(false)

    controller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(6 * DAY)
    controller.noteLeaderboardUpload(Date.now())

    await vi.advanceTimersByTimeAsync(WEEK - 1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(2)
  })

  it('clears the wait after a failed auto upload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    runLeaderboardUpload.mockRejectedValueOnce(new Error('offline'))
    const controller = createController()

    controller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(HOUR / 2)
    controller.noteLeaderboardUpload(recordLeaderboardUpload(stored, dir)!)

    await vi.advanceTimersByTimeAsync(WEEK - 1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(2)
  })

  it('does not start a timer for a manual upload when auto upload is off or the controller is stopped', async () => {
    config = { leaderboardAutoUpload: false }
    const controller = createController()

    controller.noteLeaderboardUpload(START)
    controller.start()
    controller.noteLeaderboardUpload(recordLeaderboardUpload(stored, dir)!)
    await vi.advanceTimersByTimeAsync(2 * WEEK)
    controller.stop()
    controller.noteLeaderboardUpload(Date.now())
    await vi.advanceTimersByTimeAsync(2 * WEEK)

    expect(runLeaderboardUpload).not.toHaveBeenCalled()
  })
})
