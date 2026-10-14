import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'

vi.mock('../../src/commands/leaderboard-upload.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    // The real one would contact the leaderboard site.
    uploadLeaderboardData: vi.fn(),
  }
})

import { createApiServer } from '../../src/api/server.js'
import { uploadLeaderboardData } from '../../src/commands/leaderboard-upload.js'
import { AIUSAGE_DIR } from '../../src/config.js'
import { ensureAiusageDir, getState } from '../../src/init.js'

describe('POST /api/leaderboard/upload', () => {
  let db: Database.Database
  let server: http.Server
  let baseUrl: string
  let onLeaderboardUploaded: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    // tests/setup-home.ts gives this file a home made with mkdtemp under the temp directory.
    expect(dirname(dirname(AIUSAGE_DIR))).toBe(tmpdir())
    rmSync(join(AIUSAGE_DIR, 'state.json'), { force: true })
    ensureAiusageDir(AIUSAGE_DIR)
    vi.mocked(uploadLeaderboardData).mockReset()
    onLeaderboardUploaded = vi.fn()
    db = new Database(':memory:')
    initializeDatabase(db)
    server = createApiServer(db, { onLeaderboardUploaded })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number }
        baseUrl = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    if (server?.listening) {
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    db.close()
  })

  const post = () => fetch(`${baseUrl}/api/leaderboard/upload`, { method: 'POST' })

  it('stores the upload time and reports it for an upload the site took', async () => {
    const response = { request_id: 'r1', status: 'accepted', snapshots: [] }
    vi.mocked(uploadLeaderboardData).mockResolvedValue({ totalTokens: 100, response })
    const before = Date.now()

    const res = await post()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ totalTokens: 100, response })
    const storedAt = getState(AIUSAGE_DIR)?.lastLeaderboardUploadAt
    expect(storedAt).toBeGreaterThanOrEqual(before)
    expect(storedAt).toBeLessThanOrEqual(Date.now())
    expect(onLeaderboardUploaded).toHaveBeenCalledTimes(1)
    expect(onLeaderboardUploaded).toHaveBeenCalledWith(storedAt)
  })

  it('stores nothing when the site rejected the request', async () => {
    const response = { request_id: '', status: 'rejected', snapshots: [] }
    vi.mocked(uploadLeaderboardData).mockResolvedValue({ totalTokens: 100, response })

    const res = await post()

    expect(res.status).toBe(200)
    expect(getState(AIUSAGE_DIR)?.lastLeaderboardUploadAt).toBeUndefined()
    expect(onLeaderboardUploaded).not.toHaveBeenCalled()
  })

  it('stores nothing when there was no usage to upload', async () => {
    vi.mocked(uploadLeaderboardData).mockResolvedValue({ totalTokens: 0, response: null })

    const res = await post()

    expect(res.status).toBe(200)
    expect(getState(AIUSAGE_DIR)?.lastLeaderboardUploadAt).toBeUndefined()
    expect(onLeaderboardUploaded).not.toHaveBeenCalled()
  })

  it('stores nothing when the upload failed', async () => {
    vi.mocked(uploadLeaderboardData).mockRejectedValue(new Error('offline'))

    const res = await post()

    expect(res.status).toBe(502)
    expect(getState(AIUSAGE_DIR)?.lastLeaderboardUploadAt).toBeUndefined()
    expect(onLeaderboardUploaded).not.toHaveBeenCalled()
  })
})
