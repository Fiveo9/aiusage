import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryAllQuotas, queryClaudeCodeQuota } from '../src/quota.js'

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), execSync: vi.fn(), readFileSync: vi.fn(), fetch: vi.fn() }))
vi.mock('node:os', () => ({ platform: () => 'darwin', homedir: () => '/synthetic-home' }))
vi.mock('node:fs', () => ({ existsSync: () => false, readFileSync: mocks.readFileSync }))
vi.mock('node:child_process', () => ({ execFile: mocks.execFile, execSync: mocks.execSync }))
beforeEach(() => { vi.clearAllMocks(); mocks.execFile.mockReset(); vi.stubGlobal('fetch', mocks.fetch) })
afterEach(() => vi.unstubAllGlobals())

describe('F19 asynchronous Keychain boundary', () => {
  it('returns a pending promise without blocking and handles an asynchronous failure', async () => {
    const pending = queryClaudeCodeQuota()
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(mocks.execFile).toHaveBeenCalledWith('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      expect.objectContaining({ timeout: 3000, windowsHide: true }), expect.any(Function))
    mocks.execFile.mock.calls[0][3](new Error('synthetic unavailable'), '')
    expect((await pending).credentialStatus).toBe('not_found')
    expect(mocks.execSync).not.toHaveBeenCalled()
    expect(mocks.readFileSync).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('passes both fixed service names as arguments, never through a shell', async () => {
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(new Error('synthetic unavailable'), ''))
    expect((await queryAllQuotas()).map(result => result.credentialStatus)).toEqual(['not_found', 'not_found', 'not_found'])
    expect(mocks.execFile.mock.calls.map(call => call[1])).toEqual([
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], ['find-generic-password', '-s', 'Codex Auth', '-w'],
    ])
    expect(mocks.execSync).not.toHaveBeenCalled()
  })

  it('keeps synchronous launch failures on the existing not-found fallback path', async () => {
    mocks.execFile.mockImplementation(() => { throw new Error('synthetic launch failure') })
    expect((await queryClaudeCodeQuota()).credentialStatus).toBe('not_found')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
