import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

// The real runSync against a home directory of this file's own.
const home = mkdtempSync(join(tmpdir(), 'aiusage-sync-state-integrity-'))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => home }
})

const { runSync } = await import('../../src/commands/sync.js')
const { AIUSAGE_DIR, CONFIG_PATH } = await import('../../src/config.js')
const { initializeDatabase } = await import('../../src/db/index.js')

const STATE_PATH = join(AIUSAGE_DIR, 'state.json')
const DEVICE = '11111111-2222-3333-4444-555555555555'
const GOOD_STATE = JSON.stringify({
  deviceInstanceId: DEVICE,
  lastSyncStatus: 'ok',
  syncConsents: { 'github:user/repo': { syncConsentAt: 1, syncConsentTarget: 'fp' } },
}, null, 2)
const TRUNCATED = GOOD_STATE.slice(0, 70)

function configure(sync: Record<string, unknown>): void {
  writeFileSync(CONFIG_PATH, JSON.stringify({ sync }), 'utf-8')
}

function logIn(): void {
  writeFileSync(join(AIUSAGE_DIR, 'leaderboard-credentials.json'),
    JSON.stringify({ device_id: 'dev', device_secret: 'secret', obtained_at: '2026-01-01T00:00:00Z' }), 'utf-8')
}

describe('runSync with an unusable state.json or config.json (#104, #103)', () => {
  let db: Database.Database

  beforeEach(() => {
    rmSync(AIUSAGE_DIR, { recursive: true, force: true })
    mkdirSync(AIUSAGE_DIR, { recursive: true })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no request expected') }))
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    db.close()
  })

  afterAll(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  for (const backend of [{ backend: 'github', repo: 'user/repo' }, { backend: 'cloud' }]) {
    it(`${backend.backend}: fails on a truncated state.json without replacing the device identity`, async () => {
      configure(backend)
      logIn()
      writeFileSync(STATE_PATH, TRUNCATED, 'utf-8')

      const result = await runSync(db)
      expect(result.status).toBe('failed')
      expect(result.error).toContain(STATE_PATH)
      expect(result.error).toMatch(/left untouched/)
      expect(readFileSync(STATE_PATH, 'utf-8')).toBe(TRUNCATED)
      expect(fetch).not.toHaveBeenCalled()
    })

    it(`${backend.backend}: returns a failed result, not a TypeError, when state.json is missing`, async () => {
      configure(backend)
      logIn()

      const result = await runSync(db)
      expect(result.status).toBe('failed')
      expect(result.error).toMatch(/state\.json/)
      expect(result.error).toMatch(/missing/)
      // The sync does not invent an identity on the way out either.
      expect(existsSync(STATE_PATH)).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
    })
  }

  it('returns a failed result that names the file when config.json does not parse', async () => {
    const typo = '{ "sync": { "backend": "cloud" }, }'
    writeFileSync(CONFIG_PATH, typo, 'utf-8')
    writeFileSync(STATE_PATH, GOOD_STATE, 'utf-8')

    const result = await runSync(db)
    expect(result.status).toBe('failed')
    expect(result.error).toContain(CONFIG_PATH)
    expect(result.error).not.toMatch(/not configured/i)
    expect(readFileSync(CONFIG_PATH, 'utf-8')).toBe(typo)
    expect(readFileSync(STATE_PATH, 'utf-8')).toBe(GOOD_STATE)
  })

  it('reports the target it syncs before anything can fail for that target', async () => {
    configure({ backend: 'github', repo: 'user/repo', branch: 'dev' })
    const targets: string[] = []
    const result = await runSync(db, { onTarget: target => targets.push(target) })
    expect(result.status).toBe('failed')
    expect(targets).toEqual(['github:user/repo?branch=dev'])
  })

  it('still reports a missing config as not configured', async () => {
    const result = await runSync(db)
    expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/not configured/i) })
  })
})
