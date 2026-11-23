import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
const root = mkdtempSync(join(tmpdir(), 'aiusage-git-boundaries-'))
vi.mock('../../src/config.js', async () => ({
  ...await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js'), AIUSAGE_DIR: root,
}))
const { GitSyncBackend } = await import('../../src/sync/git.js')
const { emptyGitConfigPath, gitCredentialOptions, gitFailureSummary, GitIsolationError } = await import('../../src/github/git-credentials.js')
const execute = vi.mocked(execFile)
let cache: string
let backend: InstanceType<typeof GitSyncBackend>
let link: string | undefined
afterAll(() => {
  // Audit the deliberately created junction before the guarded recoverable cleanup.
  if (link) expect(lstatSync(link).isSymbolicLink()).toBe(true)
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  cache = mkdtempSync(join(root, 'cache-'))
  mkdirSync(join(cache, 'data'), { recursive: true })
  backend = new GitSyncBackend({ cacheDir: cache, repo: 'synthetic/repo', token: 'synthetic-only' })
  execute.mockReset().mockImplementation((...args: any[]) => {
    args[args.length - 1](null, { stdout: '' })
    return {} as any
  })
})

describe('review Git cache boundaries', () => {
  it.each(['../outside.ndjson', 'peer\\outside.ndjson', 'peer/\u0000outside.ndjson', 'C:/outside.ndjson'])
  ('rejects unsafe paths before any file operation: %j', async path => {
    await expect(backend.readFile(path)).rejects.toThrow('EINVAL')
    await expect(backend.writeFile(path, 'synthetic')).rejects.toThrow('EINVAL')
    await expect(backend.deleteFile(path)).rejects.toThrow('EINVAL')
  })

  it('rejects a junction in every data access and preserves its target', async () => {
    const outside = mkdtempSync(join(root, 'outside-'))
    writeFileSync(join(outside, 'day.ndjson'), 'synthetic outside data')
    link = join(cache, 'data', 'peer')
    symlinkSync(outside, link, 'junction')
    await expect(backend.readFile('peer/day.ndjson')).rejects.toThrow('ELOOP')
    await expect(backend.writeFile('peer/day.ndjson', 'changed')).rejects.toThrow('ELOOP')
    await expect(backend.deleteFile('peer/day.ndjson')).rejects.toThrow('ELOOP')
    await expect(backend.listFiles()).rejects.toThrow('ELOOP')
    expect(readFileSync(join(outside, 'day.ndjson'), 'utf8')).toBe('synthetic outside data')
  })

  it('rejects a hardlinked data file and a hardlinked empty Git config before truncation', async () => {
    const original = join(cache, 'synthetic-original')
    writeFileSync(original, 'synthetic content must survive')
    mkdirSync(join(cache, 'data', 'peer'))
    linkSync(original, join(cache, 'data', 'peer', 'day.ndjson'))
    await expect(backend.writeFile('peer/day.ndjson', 'changed')).rejects.toThrow('ELOOP')
    const configDir = mkdtempSync(join(root, 'config-'))
    linkSync(original, join(configDir, 'git-empty-config'))
    expect(() => emptyGitConfigPath(configDir)).toThrow(GitIsolationError)
    expect(readFileSync(original, 'utf8')).toBe('synthetic content must survive')
  })

  it('moves removed data into the recycle directory and lists tool snapshots', async () => {
    mkdirSync(join(cache, 'data', 'peer'))
    writeFileSync(join(cache, 'data', 'peer', 'day.ndjson'), 'synthetic')
    writeFileSync(join(cache, 'data', 'peer', 'tool-calls.v1.json'), '{}')
    expect(await backend.listFiles()).toEqual(['peer/day.ndjson', 'peer/tool-calls.v1.json'])
    await backend.deleteFile('peer/day.ndjson')
    expect(existsSync(join(cache, 'data', 'peer', 'day.ndjson'))).toBe(false)
    const recycle = join(root, 'sync-recycle')
    expect(readdirSync(recycle).some(name => readFileSync(join(recycle, name), 'utf8') === 'synthetic')).toBe(true)
  })

  it('fails closed on an unsafe .git path without invoking Git', async () => {
    writeFileSync(join(cache, '.git'), 'synthetic invalid layout')
    await expect(backend.prepare()).rejects.toThrow('ENOTDIR')
    expect(execute).not.toHaveBeenCalled()
  })

  it('recycles failed rebase state and untracked data, then returns the sanitized failure', async () => {
    mkdirSync(join(cache, '.git', 'rebase-merge'), { recursive: true })
    writeFileSync(join(cache, '.git', 'rebase-merge', 'synthetic-state'), 'synthetic')
    writeFileSync(join(cache, 'data', 'untracked.ndjson'), 'synthetic untracked')
    execute.mockImplementation((...args: any[]) => {
      const argv: string[] = args[1]
      const callback = args[args.length - 1]
      if (argv.includes('push')) callback(Object.assign(new Error('synthetic push'), { stderr: ' ! [rejected] main -> main (non-fast-forward)' }))
      else if (argv.includes('pull')) callback(Object.assign(new Error('synthetic rebase'), { stderr: 'CONFLICT synthetic' }))
      else callback(null, { stdout: argv.includes('status') ? ' M data/peer/day.ndjson' : argv.includes('ls-files') ? 'data/untracked.ndjson\u0000' : '' })
      return {} as any
    })
    await expect(backend.flush()).rejects.toThrow('GitHub Git operation')
    expect(existsSync(join(cache, '.git', 'rebase-merge'))).toBe(false)
    expect(existsSync(join(cache, 'data', 'untracked.ndjson'))).toBe(false)
    expect(execute.mock.calls.some((call: any) => call[1].includes('checkout') && call[1].includes('ORIG_HEAD'))).toBe(true)
    expect(execute.mock.calls.filter((call: any) => call[1].includes('push'))).toHaveLength(1)
  })
})

describe('review Git credential input', () => {
  it('disables symlink checkout and rejects credential protocol control characters', () => {
    expect(gitCredentialOptions('synthetic/repo').args).toContain('core.symlinks=false')
    for (const value of ['synthetic\nextra', 'synthetic\rextra', 'synthetic\u0000extra']) {
      expect(() => gitCredentialOptions('synthetic/repo', value)).toThrow(GitIsolationError)
    }
  })
  it('recognizes lowercase TLS failures without retaining raw stderr', () => {
    expect(gitFailureSummary({ stderr: 'ssl certificate failure: synthetic' }, { network: true })).toBe('TLS error')
  })
})
