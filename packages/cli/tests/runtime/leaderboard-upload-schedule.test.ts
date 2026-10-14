import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeSettingsController } from '../../src/runtime/settings-controller.js'
import { ensureAiusageDir, getState, setState } from '../../src/init.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const MONTH = 2592000000
const MAX_TIMER_DELAY = 2 ** 31 - 1
const START = Date.parse('2026-01-01T00:00:00Z')

describe('RuntimeSettingsController leaderboard upload schedule', () => {
  let dir: string
  let config: Record<string, unknown>
  let runParse: ReturnType<typeof vi.fn>
  let runCleanup: ReturnType<typeof vi.fn>
  let runLeaderboardUpload: ReturnType<typeof vi.fn>
  const controllers: RuntimeSettingsController[] = []

  // Wired the way `aiusage serve` wires it: the last-upload time lives in state.json.
  function createController(): RuntimeSettingsController {
    const controller = new RuntimeSettingsController({
      db: {} as any,
      loadConfig: () => config as any,
      runParse: runParse as any,
      runCleanup: runCleanup as any,
      runLeaderboardUpload: runLeaderboardUpload as any,
      getLastLeaderboardUploadAt: () => getState(dir)?.lastLeaderboardUploadAt,
      setLastLeaderboardUploadAt: (ts: number) => setState(dir, { lastLeaderboardUploadAt: ts }),
    })
    controllers.push(controller)
    return controller
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiusage-upload-schedule-'))
    ensureAiusageDir(dir)
    config = { leaderboardAutoUpload: true, leaderboardUploadInterval: WEEK }
    runParse = vi.fn(async () => {})
    runCleanup = vi.fn(() => {})
    runLeaderboardUpload = vi.fn(async () => true)
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })

  afterEach(() => {
    for (const controller of controllers.splice(0)) controller.stop()
    // Spies first: one that wraps a fake timer would put the fake back.
    vi.restoreAllMocks()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('never asks for a timer delay above the 32-bit limit with the monthly interval', async () => {
    setState(dir, { lastLeaderboardUploadAt: START })
    config = { leaderboardAutoUpload: true, leaderboardUploadInterval: MONTH }
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')

    createController().start()
    await vi.advanceTimersByTimeAsync(MONTH)

    const delays = [...timeoutSpy.mock.calls, ...intervalSpy.mock.calls].map(call => Number(call[1] ?? 0))
    expect(delays.length).toBeGreaterThan(0)
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_TIMER_DELAY)
  })

  it('uploads once per month with the monthly interval', async () => {
    setState(dir, { lastLeaderboardUploadAt: START })
    config = { leaderboardAutoUpload: true, leaderboardUploadInterval: MONTH }

    createController().start()
    await vi.advanceTimersByTimeAsync(MONTH - 1)
    expect(runLeaderboardUpload).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
    expect(runParse).toHaveBeenCalledTimes(1)
    expect(getState(dir)?.lastLeaderboardUploadAt).toBe(START + MONTH)

    await vi.advanceTimersByTimeAsync(MONTH - 1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(2)
  })

  it('does not upload back to back on real timers with the monthly interval', async () => {
    vi.useRealTimers()
    setState(dir, { lastLeaderboardUploadAt: Date.now() })
    config = { leaderboardAutoUpload: true, leaderboardUploadInterval: MONTH }
    const warnings: string[] = []
    const onWarning = (warning: Error) => { warnings.push(warning.name) }
    process.on('warning', onWarning)

    try {
      createController().start()
      await new Promise(resolve => setTimeout(resolve, 100))
    } finally {
      process.off('warning', onWarning)
    }

    expect(runLeaderboardUpload).not.toHaveBeenCalled()
    expect(warnings).not.toContain('TimeoutOverflowWarning')
  })

  it('keeps a weekly schedule across a config save', async () => {
    setState(dir, { lastLeaderboardUploadAt: START })
    const controller = createController()

    controller.start()
    await vi.advanceTimersByTimeAsync(6 * DAY)
    controller.reload()
    await vi.advanceTimersByTimeAsync(DAY - 1)
    expect(runLeaderboardUpload).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
  })

  it('keeps a weekly schedule across a restart', async () => {
    setState(dir, { lastLeaderboardUploadAt: START })
    const first = createController()

    first.start()
    await vi.advanceTimersByTimeAsync(6 * DAY)
    first.stop()

    createController().start()
    await vi.advanceTimersByTimeAsync(DAY - 1)
    expect(runLeaderboardUpload).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
    expect(getState(dir)?.lastLeaderboardUploadAt).toBe(START + WEEK)
  })

  it('uploads on start when the interval already passed while stopped', async () => {
    setState(dir, { lastLeaderboardUploadAt: START - 8 * DAY })

    createController().start()
    await vi.advanceTimersByTimeAsync(0)

    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
    expect(getState(dir)?.lastLeaderboardUploadAt).toBe(START)

    await vi.advanceTimersByTimeAsync(WEEK - 1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(2)
  })

  it('uploads on start when no upload time is stored yet', async () => {
    createController().start()
    await vi.advanceTimersByTimeAsync(0)

    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
    expect(getState(dir)?.lastLeaderboardUploadAt).toBe(START)
  })

  it('keeps the other state.json fields when it stores the upload time', async () => {
    const before = getState(dir)!

    createController().start()
    await vi.advanceTimersByTimeAsync(0)

    expect(getState(dir)).toEqual({ ...before, lastLeaderboardUploadAt: START })
  })

  it('does not store a time for a failed upload, and retries an hour later', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    runLeaderboardUpload.mockRejectedValueOnce(new Error('offline'))
    const controller = createController()

    controller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
    expect(getState(dir)?.lastLeaderboardUploadAt).toBeUndefined()

    // A config save must not turn the wait into an immediate retry.
    controller.reload()
    await vi.advanceTimersByTimeAsync(HOUR - 1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(2)
    expect(getState(dir)?.lastLeaderboardUploadAt).toBe(START + HOUR)
  })

  it('does not store a time when the parse before the upload fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    runParse.mockRejectedValueOnce(new Error('parse failed'))

    createController().start()
    await vi.advanceTimersByTimeAsync(0)

    expect(runLeaderboardUpload).not.toHaveBeenCalled()
    expect(getState(dir)?.lastLeaderboardUploadAt).toBeUndefined()
  })

  it('does not store a time when there was nothing to upload', async () => {
    runLeaderboardUpload.mockResolvedValueOnce(false)

    createController().start()
    await vi.advanceTimersByTimeAsync(0)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
    expect(getState(dir)?.lastLeaderboardUploadAt).toBeUndefined()

    await vi.advanceTimersByTimeAsync(HOUR - 1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(2)
  })

  it('does not start a second upload when a config save lands during one', async () => {
    let release!: (value: boolean) => void
    runLeaderboardUpload.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve }))
    const controller = createController()

    controller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)

    controller.reload()
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)

    release(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(getState(dir)?.lastLeaderboardUploadAt).toBe(START + HOUR)

    await vi.advanceTimersByTimeAsync(WEEK - 1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(2)
  })

  it('applies a shorter interval from the stored upload time', async () => {
    setState(dir, { lastLeaderboardUploadAt: START })
    const controller = createController()

    controller.start()
    await vi.advanceTimersByTimeAsync(2 * DAY)
    expect(runLeaderboardUpload).not.toHaveBeenCalled()

    config = { leaderboardAutoUpload: true, leaderboardUploadInterval: DAY }
    controller.reload()
    await vi.advanceTimersByTimeAsync(0)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
  })

  it('uses the weekly default when no interval is configured', async () => {
    setState(dir, { lastLeaderboardUploadAt: START })
    config = { leaderboardAutoUpload: true }

    createController().start()
    await vi.advanceTimersByTimeAsync(WEEK - 1)
    expect(runLeaderboardUpload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
  })

  it('does not upload when auto upload is off or gets turned off', async () => {
    config = { leaderboardAutoUpload: false, leaderboardUploadInterval: DAY }
    const controller = createController()

    controller.start()
    await vi.advanceTimersByTimeAsync(2 * DAY)
    expect(runLeaderboardUpload).not.toHaveBeenCalled()

    config = { leaderboardAutoUpload: true, leaderboardUploadInterval: DAY }
    controller.reload()
    await vi.advanceTimersByTimeAsync(0)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)

    config = { leaderboardAutoUpload: false, leaderboardUploadInterval: DAY }
    controller.reload()
    await vi.advanceTimersByTimeAsync(3 * DAY)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
  })

  it('stops the upload timer on stop', async () => {
    setState(dir, { lastLeaderboardUploadAt: START })
    const controller = createController()

    controller.start()
    controller.stop()
    await vi.advanceTimersByTimeAsync(2 * WEEK)

    expect(runLeaderboardUpload).not.toHaveBeenCalled()
  })

  it('does not wait on a stored time that lies in the future', async () => {
    setState(dir, { lastLeaderboardUploadAt: START + 365 * DAY })

    createController().start()
    await vi.advanceTimersByTimeAsync(0)

    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
    expect(getState(dir)?.lastLeaderboardUploadAt).toBe(START)
  })

  it('does not upload more often than hourly for a stored interval below the minimum', async () => {
    config = { leaderboardAutoUpload: true, leaderboardUploadInterval: 1 }

    createController().start()
    await vi.advanceTimersByTimeAsync(HOUR - 1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(2)
  })

  it('keeps the schedule when storing the upload time fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = new RuntimeSettingsController({
      db: {} as any,
      loadConfig: () => config as any,
      runParse: runParse as any,
      runCleanup: runCleanup as any,
      runLeaderboardUpload: runLeaderboardUpload as any,
      getLastLeaderboardUploadAt: () => undefined,
      setLastLeaderboardUploadAt: () => { throw new Error('disk full') },
    })
    controllers.push(controller)

    controller.start()
    await vi.advanceTimersByTimeAsync(WEEK - 1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(2)
  })

  it('does not upload back to back when a future stored time cannot be replaced', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = new RuntimeSettingsController({
      db: {} as any,
      loadConfig: () => config as any,
      runParse: runParse as any,
      runCleanup: runCleanup as any,
      runLeaderboardUpload: runLeaderboardUpload as any,
      getLastLeaderboardUploadAt: () => START + 365 * DAY,
      setLastLeaderboardUploadAt: () => { throw new Error('disk full') },
    })
    controllers.push(controller)

    controller.start()
    await vi.advanceTimersByTimeAsync(WEEK - 1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runLeaderboardUpload).toHaveBeenCalledTimes(2)
  })

  it('clamps refresh and sync timers that exceed the 32-bit limit', async () => {
    config = { refreshInterval: MONTH, syncInterval: MONTH, sync: { backend: 'cloud' } }
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    const runSync = vi.fn()
    const controller = new RuntimeSettingsController({
      db: {} as any,
      loadConfig: () => config as any,
      runParse: runParse as any,
      runCleanup: runCleanup as any,
      runSync,
    })
    controllers.push(controller)

    controller.start()

    const delays = intervalSpy.mock.calls.map(call => Number(call[1] ?? 0))
    expect(delays).toHaveLength(2)
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_TIMER_DELAY)
  })
})
