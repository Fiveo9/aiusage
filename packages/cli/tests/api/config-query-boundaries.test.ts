import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import Database from 'better-sqlite3'
import type { StatsRecord } from '@aiusage/core'
import type { Config } from '../../src/config.js'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'

const state = vi.hoisted(() => ({ config: {} as Config, failSave: false }))
vi.mock('../../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/config.js')>()
  return { ...actual,
    loadConfig: vi.fn(() => structuredClone(state.config)),
    saveConfig: vi.fn((config: Config) => {
      if (state.failSave) throw new Error('synthetic save failure')
      state.config = structuredClone(config)
    }),
    updateConfig: vi.fn((update: (config: Config) => unknown) => {
      const config = structuredClone(state.config)
      update(config)
      state.config = config
      return config
    }),
    buildConsentConfig: vi.fn(() => null),
  }
})
vi.mock('../../src/github/credentials.js', () => ({
  saveGitHubCredentials: vi.fn(() => 'new-keychain-reference'),
  loadGitHubCredentials: vi.fn(),
  deleteGitHubCredentials: vi.fn(),
}))
import { createApiServer } from '../../src/api/server.js'
import { saveConfig } from '../../src/config.js'
import { deleteGitHubCredentials, saveGitHubCredentials } from '../../src/github/credentials.js'

function record(id: string, owner: string, tokens: number): StatsRecord {
  return { id, ts: 1000, ingestedAt: 1000, updatedAt: 1000, lineOffset: 0, tool: 'codex',
    model: 'boundary-model', provider: 'boundary-provider', inputTokens: tokens, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, cost: tokens, costSource: 'log',
    sessionId: id, sourceFile: `${id}.jsonl`, device: `Alias ${owner}`, deviceInstanceId: owner }
}

describe('review config, price and legacy query boundaries', () => {
  let db: Database.Database
  let server: http.Server
  let base: string
  beforeEach(async () => {
    vi.clearAllMocks()
    state.config = {}
    state.failSave = false
    db = new Database(':memory:')
    initializeDatabase(db)
    server = createApiServer(db)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(async () => {
    vi.useRealTimers()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
  })
  const put = (base: string, route: string, body: unknown) => fetch(base + route, { method: 'PUT', body: JSON.stringify(body) })

  it.each([-1, 0.01, 1.5, 'NaN', true, {}, 9007199254740992])('refuses unsafe retentionDays %j before saving', async retentionDays => {
    const response = await put(base, '/api/config', { retentionDays })
    expect(response.status).toBe(400)
    expect(vi.mocked(saveConfig)).not.toHaveBeenCalled()
  })
  it.each([null, false, '', 0, '0'])('keeps explicit retention disable %j', async retentionDays => {
    state.config.retentionDays = 30
    expect((await put(base, '/api/config', { retentionDays })).status).toBe(200)
    expect(state.config.retentionDays).toBeUndefined()
  })
  it('keeps legacy values unchanged on an unrelated save, and accepts positive integer strings', async () => {
    state.config.retentionDays = 0.01
    expect((await put(base, '/api/config', { device: 'changed' })).status).toBe(200)
    expect(state.config.retentionDays).toBe(0.01)
    expect((await put(base, '/api/config', { retentionDays: '30' })).status).toBe(200)
    expect(state.config.retentionDays).toBe(30)
  })
  it('clears optional S3 values but retains an explicit root prefix', async () => {
    state.config.sync = { backend: 's3', bucket: 'synthetic-bucket', prefix: 'old/', endpoint: 'https://s3.example', region: 'auto', credentialRef: 'old-reference' }
    expect((await put(base, '/api/config', { sync: { backend: 's3', prefix: '', endpoint: '', region: '', credentialRef: '' } })).status).toBe(200)
    expect(state.config.sync).toEqual({ backend: 's3', bucket: 'synthetic-bucket', prefix: '' })
  })
  it.each([[[]], [{ custom: 2 }], [{ custom: {} }], [{ GITHUB_TOKEN: 'synthetic-only' }], [{ 'github/owner/repo/token': 'synthetic-only' }]])
  ('refuses malformed or plaintext GitHub credential updates %j', async credentials => {
    expect((await put(base, '/api/config', { credentials })).status).toBe(400)
    expect(vi.mocked(saveConfig)).not.toHaveBeenCalled()
  })
  it.each([[[]], [{ githubToken: {} }]])('refuses malformed write-only credentials %j', async syncCredentials => {
    expect((await put(base, '/api/config', { syncCredentials })).status).toBe(400)
    expect(saveGitHubCredentials).not.toHaveBeenCalled()
  })
  it('retires only an old keychain reference after a successful replacement', async () => {
    state.config.sync = { backend: 'github', repo: 'owner/repo', githubAuth: { method: 'pat', credentialId: 'old-keychain-reference' } }
    expect((await put(base, '/api/config', { syncCredentials: { githubToken: 'synthetic-only' } })).status).toBe(200)
    expect(state.config.sync?.githubAuth?.credentialId).toBe('new-keychain-reference')
    expect(deleteGitHubCredentials).toHaveBeenCalledWith('old-keychain-reference')
    expect(deleteGitHubCredentials).not.toHaveBeenCalledWith('new-keychain-reference')
  })
  it('retains the old keychain reference if config saving fails', async () => {
    state.config.sync = { backend: 'github', repo: 'owner/repo', githubAuth: { method: 'pat', credentialId: 'old-keychain-reference' } }
    state.failSave = true
    expect((await put(base, '/api/config', { syncCredentials: { githubToken: 'synthetic-only' } })).status).toBe(500)
    expect(state.config.sync.githubAuth?.credentialId).toBe('old-keychain-reference')
    expect(deleteGitHubCredentials).toHaveBeenCalledWith('new-keychain-reference')
    expect(deleteGitHubCredentials).not.toHaveBeenCalledWith('old-keychain-reference')
  })
  it('does not commit the in-memory week start when validation or saving fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 0, 7, 12))
    insertRecord(db, { ...record('sunday', 'a', 7), ts: new Date(2026, 0, 4, 12).getTime() })
    const weekTokens = async () => (await (await fetch(base + '/api/summary?range=week')).json()).inputTokens
    expect(await weekTokens()).toBe(0)
    expect((await put(base, '/api/config', { weekStart: 0, sync: { backend: 'invalid' } })).status).toBe(400)
    expect(await weekTokens()).toBe(0)
    state.failSave = true
    expect((await put(base, '/api/config', { weekStart: 0 })).status).toBe(500)
    expect(await weekTokens()).toBe(0)
  })
  it.each([
    { model: 1, input: 0, output: 0 }, { model: ' ', input: 0, output: 0 },
    { model: 'boundary-model', input: -1, output: 0 }, { model: 'boundary-model', input: 0, output: -1 },
    { model: 'boundary-model', input: 0, output: 0, cacheRead: -1 },
    { model: 'boundary-model', input: 0, output: 0, cacheWrite: '1' },
    { model: 'boundary-model', input: null, output: 0 },
  ])('rejects invalid prices %j', async price => {
    expect((await put(base, '/api/pricing', price)).status).toBe(400)
  })
  it('preserves legal zero rates and optional null-clear', async () => {
    expect((await put(base, '/api/pricing', { model: 'boundary-model', input: 0, output: 0, cacheRead: 0, cacheWrite: null })).status).toBe(200)
  })
  it.each(['input', 'output', 'cacheRead', 'cacheWrite'])('rejects JSON numeric overflow in %s', async field => {
    const body = JSON.stringify({ model: 'boundary-model', input: 0, output: 0, [field]: 1 })
      .replace(`"${field}":1`, `"${field}":1e309`)
    expect((await fetch(base + '/api/pricing', { method: 'PUT', body })).status).toBe(400)
  })
  it.each(['a', 'Alias a'])('filters all legacy aggregates by device %s with no state identity', async device => {
    insertRecord(db, record('one', 'a', 10)); insertRecord(db, record('two', 'b', 20))
    const suffix = `?range=all&device=${encodeURIComponent(device)}`
    const tokens = await (await fetch(base + '/api/tokens' + suffix)).json()
    const cost = await (await fetch(base + '/api/cost' + suffix)).json()
    const models = await (await fetch(base + '/api/models' + suffix)).json()
    expect(tokens.data.reduce((n: number, row: { inputTokens: number }) => n + row.inputTokens, 0)).toBe(10)
    expect(cost.data.reduce((n: number, row: { cost: number }) => n + row.cost, 0)).toBe(10)
    expect(cost.provenance.totalRecords).toBe(1)
    expect(models.models[0]?.totalTokens).toBe(10)
  })
  it('includes a cwd-only project without a source filename', async () => {
    insertRecord(db, { ...record('cwd-only', 'a', 10), sourceFile: '', cwd: 'C:/Repositories/my-project/pkg' })
    const response = await fetch(base + '/api/projects?range=all')
    expect(response.status).toBe(200)
    expect((await response.json()).projects).toEqual([expect.objectContaining({ name: 'my-project', tokens: 10 })])
  })
  it('returns 400 for a malformed encoded session identifier', async () => {
    expect((await fetch(base + '/api/sessions/%E0%A4')).status).toBe(400)
  })
})
