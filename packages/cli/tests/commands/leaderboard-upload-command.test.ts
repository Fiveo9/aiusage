import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Nothing here reaches the leaderboard site: the request function is replaced,
// and the temporary home holds no credentials.
vi.mock('../../src/leaderboard/api.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return { ...actual, uploadSnapshots: vi.fn() }
})
vi.mock('../../src/leaderboard/credentials.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return { ...actual, hasCredentials: vi.fn(() => true) }
})

import { runLeaderboardUpload } from '../../src/commands/leaderboard-upload.js'
import { uploadSnapshots, LeaderboardApiError } from '../../src/leaderboard/api.js'
import { AIUSAGE_DIR } from '../../src/config.js'
import { createDatabase } from '../../src/db/index.js'
import { ensureAiusageDir, getState } from '../../src/init.js'

describe('aiusage leaderboard upload', () => {
  beforeEach(() => {
    // tests/setup-home.ts gives this file a home made with mkdtemp under the temp directory.
    expect(dirname(dirname(AIUSAGE_DIR))).toBe(tmpdir())
    rmSync(AIUSAGE_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    ensureAiusageDir(AIUSAGE_DIR)
    const db = createDatabase(join(AIUSAGE_DIR, 'cache.db'))
    const now = Date.now()
    db.prepare(`
      INSERT INTO records (id, ts, ingested_at, synced_at, updated_at, line_offset,
        tool, model, provider, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, thinking_tokens, cost, cost_source, session_id,
        source_file, device, device_instance_id)
      VALUES ('r1', @now, @now, NULL, @now, 0,
        'claude-code', 'claude-sonnet-4-6', 'anthropic', 100, 0, 0,
        0, 0, 0, 'pricing', 's1',
        '/tmp/session.jsonl', 'local-device', @device)
    `).run({ now, device: getState(AIUSAGE_DIR)!.deviceInstanceId })
    db.close()
    vi.mocked(uploadSnapshots).mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stores the upload time after an upload the site took', async () => {
    vi.mocked(uploadSnapshots).mockResolvedValue({ request_id: 'r1', status: 'accepted', snapshots: [] })
    const before = Date.now()

    await runLeaderboardUpload()

    expect(uploadSnapshots).toHaveBeenCalledTimes(1)
    const storedAt = getState(AIUSAGE_DIR)?.lastLeaderboardUploadAt
    expect(storedAt).toBeGreaterThanOrEqual(before)
    expect(storedAt).toBeLessThanOrEqual(Date.now())
  })

  it('stores nothing when the site rejected the request', async () => {
    vi.mocked(uploadSnapshots).mockResolvedValue({ request_id: '', status: 'rejected', snapshots: [] })

    await runLeaderboardUpload()

    expect(uploadSnapshots).toHaveBeenCalledTimes(1)
    expect(getState(AIUSAGE_DIR)?.lastLeaderboardUploadAt).toBeUndefined()
  })

  it('stores nothing when the upload failed', async () => {
    vi.mocked(uploadSnapshots).mockRejectedValue(new LeaderboardApiError('banned', 'user_banned'))
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit') }) as never)

    await expect(runLeaderboardUpload()).rejects.toThrow('exit')

    expect(exit).toHaveBeenCalledWith(1)
    expect(getState(AIUSAGE_DIR)?.lastLeaderboardUploadAt).toBeUndefined()
  })
})
