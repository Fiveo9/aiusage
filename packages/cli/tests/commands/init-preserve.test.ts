import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `aiusage init` must change only the keys it is about. Everything else in
// config.json stays, and the sync block is removed only by `--backend skip`.

const home = mkdtempSync(join(tmpdir(), 'aiusage-init-preserve-'))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => home }
})

vi.mock('../../src/github/credentials.js', () => ({
  saveGitHubCredentials: vi.fn(() => '11111111-1111-1111-1111-111111111111'),
  loadGitHubCredentials: vi.fn(),
}))

// Must import after mocks
const { runInit } = await import('../../src/commands/init.js')

const aiusageDir = join(home, '.aiusage')
const configPath = join(aiusageDir, 'config.json')

/** Every key of `Config` outside `sync`, with a value that is not a default. */
const SETTINGS = {
  device: 'laptop',
  platform: 'plan9',
  retentionDays: 90,
  refreshInterval: 120000,
  parseInterval: 60000,
  dashboardPollInterval: 30000,
  leaderboardAutoUpload: true,
  leaderboardUploadInterval: 3600000,
  credentials: { 'custom/key': 'value' },
  priceOverrides: { 'some-model': { input: 1, output: 2 } },
  sources: { codex: '/tmp/codex' },
  weekStart: 0,
  displayCurrency: 'CNY',
  exchangeRate: 0.14,
  exchangeRateCache: { rate: 0.14, fetchedAt: 1700000000000 },
  syncInterval: 900000,
  // A key this version does not know about must survive as well.
  futureSetting: { nested: true },
}

const GITHUB_SYNC = {
  backend: 'github',
  repo: 'user/aiusage-data',
  githubAuth: { method: 'pat', credentialId: 'cred-1' },
  branch: 'data',
}

const S3_SYNC = {
  backend: 's3',
  bucket: 'old-bucket',
  prefix: 'aiusage/',
  region: 'auto',
  credentialRef: 's3/old-bucket/accessKeyId',
}

function writeConfig(config: unknown): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2))
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, 'utf-8'))
}

describe('init keeps the settings it is not about', () => {
  beforeEach(() => {
    mkdirSync(aiusageDir, { recursive: true })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(aiusageDir, { recursive: true, force: true })
  })

  describe('without --backend', () => {
    it('leaves a GitHub sync setup and every other key as they were', () => {
      const before = { ...SETTINGS, sync: GITHUB_SYNC }
      writeConfig(before)

      const result = runInit({})

      expect(result.success).toBe(true)
      expect(readConfig()).toEqual(before)
      expect(result.message).not.toContain('without cloud sync')
      expect(result.message).toContain('github')
      expect(result.message).toContain('--backend skip')
    })

    it('leaves a cloud sync setup as it was', () => {
      const before = { ...SETTINGS, sync: { backend: 'cloud' } }
      writeConfig(before)

      expect(runInit({}).success).toBe(true)
      expect(readConfig()).toEqual(before)
    })

    it('leaves an S3 sync setup as it was, even with the option defaults commander passes', () => {
      const before = { ...SETTINGS, sync: { ...S3_SYNC, prefix: 'custom/', region: 'eu-west-1' } }
      writeConfig(before)

      // `--prefix` and `--region` have defaults, so they are always present.
      expect(runInit({ prefix: 'aiusage/', region: 'auto' }).success).toBe(true)
      expect(readConfig()).toEqual(before)
    })

    it('changes only the device alias for --device', () => {
      const before = { ...SETTINGS, sync: GITHUB_SYNC }
      writeConfig(before)

      const result = runInit({ device: 'desktop' })

      expect(result.success).toBe(true)
      expect(readConfig()).toEqual({ ...before, device: 'desktop' })
    })

    it('says that no sync is configured when there is none', () => {
      writeConfig(SETTINGS)

      const result = runInit({})

      expect(result.success).toBe(true)
      expect(result.message).toContain('without cloud sync')
      expect(readConfig()).toEqual(SETTINGS)
    })

    it('creates a config without sync on a first run', () => {
      expect(existsSync(configPath)).toBe(false)

      const result = runInit({ device: 'laptop' })

      expect(result.success).toBe(true)
      expect(result.message).toContain('without cloud sync')
      const config = readConfig()
      expect(config.device).toBe('laptop')
      expect(config.platform).toBe(process.platform)
      expect(config.sync).toBeUndefined()
    })
  })

  describe('--backend skip', () => {
    it('removes the sync block and nothing else', () => {
      writeConfig({ ...SETTINGS, sync: GITHUB_SYNC })

      const result = runInit({ backend: 'skip' })

      expect(result.success).toBe(true)
      expect(result.message).toContain('without cloud sync')
      expect(readConfig()).toEqual(SETTINGS)
    })

    it('applies --device as well', () => {
      writeConfig({ ...SETTINGS, sync: GITHUB_SYNC })

      runInit({ backend: 'skip', device: 'desktop' })

      expect(readConfig()).toEqual({ ...SETTINGS, device: 'desktop' })
    })
  })

  describe('--backend cloud', () => {
    beforeEach(() => {
      writeFileSync(join(aiusageDir, 'leaderboard-credentials.json'), JSON.stringify({
        device_id: 'dev-1',
        device_secret: 'secret',
        obtained_at: '2026-01-01T00:00:00.000Z',
      }))
    })

    it('replaces the sync block and keeps every other key', () => {
      writeConfig({ ...SETTINGS, sync: GITHUB_SYNC })

      const result = runInit({ backend: 'cloud' })

      expect(result.success).toBe(true)
      expect(readConfig()).toEqual({ ...SETTINGS, sync: { backend: 'cloud' } })
    })
  })

  describe('--backend s3', () => {
    it('replaces the sync block, adds its credentials and keeps every other key', () => {
      writeConfig({ ...SETTINGS, sync: GITHUB_SYNC })

      const result = runInit({
        backend: 's3',
        bucket: 'my-bucket',
        prefix: 'aiusage/',
        region: 'auto',
        accessKeyId: 'AKIA_TEST',
        secretAccessKey: 'secret_test',
      })

      expect(result.success).toBe(true)
      expect(readConfig()).toEqual({
        ...SETTINGS,
        sync: {
          backend: 's3',
          bucket: 'my-bucket',
          prefix: 'aiusage/',
          region: 'auto',
          credentialRef: 's3/my-bucket/accessKeyId',
        },
        credentials: {
          'custom/key': 'value',
          's3/my-bucket/accessKeyId': 'AKIA_TEST',
          's3/my-bucket/secretAccessKey': 'secret_test',
        },
      })
    })
  })

  describe('--backend github', () => {
    it('keeps every other key', () => {
      writeConfig({ ...SETTINGS, sync: S3_SYNC })

      const result = runInit({ backend: 'github', repo: 'user/aiusage-data', token: 'ghp_test123' })

      expect(result.success).toBe(true)
      const config = readConfig()
      expect(config.sync).toEqual({
        backend: 'github',
        repo: 'user/aiusage-data',
        githubAuth: { method: 'pat', credentialId: '11111111-1111-1111-1111-111111111111' },
      })
      const { sync: _sync, ...rest } = config
      expect(rest).toEqual(SETTINGS)
    })
  })
})
