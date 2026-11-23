import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, readdir, lstat, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { gitCredentialOptions, gitFailureSummary, GitIsolationError } from '../github/git-credentials.js'
import { validateRepo, GitHubAuthError } from '../github/auth.js'
import { JsonFileError } from '../json-file.js'
import { isSafeSyncPath } from './safe-path.js'

const exec = promisify(execFile)

/**
 * True only for `ENOENT`, the one errno that confirms absence. `ENOTDIR`
 * (a path component is a file where a directory is expected) means the cache
 * layout is corrupt, not that the file was deleted: for a reader that prunes
 * against absence it must surface as an error.
 */
function isNotFound(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ENOENT'
}

/**
 * Error surfaced for cache I/O failures. Only the relative sync path and the
 * errno code are retained: never the absolute cache path or the OS message.
 */
function cacheError(operation: string, path: string, error: unknown): Error {
  const code = (error as { code?: string } | null)?.code ?? 'unknown error'
  return new Error(`Cannot ${operation} '${path}' in the GitHub sync cache (${code}). Check the permissions of the sync cache directory.`)
}

class NonFastForwardError extends Error {}

function isNonFastForward(error: unknown): boolean {
  const failure = error as { stderr?: unknown; killed?: boolean } | null
  return !failure?.killed && typeof failure?.stderr === 'string'
    && /^\s*!\s+\[rejected\]\s+\S+\s+->\s+\S+\s+\((?:non-fast-forward|fetch first)\)\s*$/m.test(failure.stderr)
}

export interface GitSyncConfig {
  repo: string
  token?: string
  getToken?: () => Promise<string>
  /** Local directory to clone the repo into */
  cacheDir: string
  /** Branch to sync with (default: 'main') */
  branch?: string
}

export class GitSyncBackend {
  private repo: string
  private getToken: () => Promise<string>
  private cacheDir: string
  private dataDir: string
  private branch: string

  constructor(config: GitSyncConfig) {
    validateRepo(config.repo)
    this.repo = config.repo
    this.getToken = config.getToken ?? (async () => config.token ?? '')
    this.cacheDir = resolve(config.cacheDir)
    this.dataDir = join(this.cacheDir, 'data')
    this.branch = config.branch ?? 'main'
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(this.branch) || this.branch.includes('..')) throw new Error('Invalid GitHub sync branch')
  }

  private get remoteUrl(): string {
    return `https://github.com/${this.repo}.git`
  }

  private async git(args: string[], cwd?: string, rawOutput = false): Promise<string> {
    const network = ['clone', 'fetch', 'pull', 'push'].includes(args[0])
    let token: string | undefined
    try {
      token = network ? await this.getToken() : undefined
      const credentials = gitCredentialOptions(this.repo, token)
      const { stdout } = await exec('git', [...credentials.args, ...args], {
        cwd: cwd ?? this.cacheDir,
        timeout: 60_000,
        env: credentials.env,
        windowsHide: true,
      })
      // Network output is never consumed or surfaced: servers can echo secrets.
      return network ? '' : rawOutput ? stdout : stdout.trim()
    } catch (error) {
      // A config.json that stopped parsing (the token is read from it) is a
      // locally authored message too, and names the file and the way out.
      if (error instanceof GitHubAuthError || error instanceof GitIsolationError || error instanceof JsonFileError) throw error
      // Never retain child-process message, stack, stdout, stderr, cmd, or cause:
      // only a sanitized one-line summary is surfaced (fixed phrases for network commands).
      const detail = gitFailureSummary(error, { network, token })
      const message = `GitHub Git operation failed or was rejected${detail ? ` (git ${args[0]}: ${detail})` : ''}. Check repository access, network connectivity, and Git identity.`
      if (args[0] === 'push' && isNonFastForward(error)) throw new NonFastForwardError(message)
      throw new Error(message)
    }
  }

  private cachePath(path: string): string {
    if (!isSafeSyncPath(path)) throw Object.assign(new Error('Unsafe GitHub sync path'), { code: 'EINVAL' })
    const full = resolve(this.cacheDir, path)
    const rel = relative(this.cacheDir, full)
    if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
      throw Object.assign(new Error('Unsafe GitHub sync path'), { code: 'EINVAL' })
    }
    return full
  }

  private async checkedCachePath(path: string, allowMissing = false, kind?: 'file' | 'directory'): Promise<string> {
    const full = this.cachePath(path)
    const parts = path.split('/')
    const candidates = [this.cacheDir, ...parts.map((_, index) => join(this.cacheDir, ...parts.slice(0, index + 1)))]
    for (let index = 0; index < candidates.length; index++) {
      let info
      try { info = await lstat(candidates[index]) } catch (error) {
        if (allowMissing && isNotFound(error)) return full
        throw error
      }
      if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1) {
        throw Object.assign(new Error('Linked GitHub sync cache path'), { code: 'ELOOP' })
      }
      if (!info.isFile() && !info.isDirectory()) throw Object.assign(new Error('Invalid GitHub sync cache entry'), { code: 'EINVAL' })
      if (index < candidates.length - 1 && !info.isDirectory()) {
        throw Object.assign(new Error('Invalid GitHub sync cache layout'), { code: 'ENOTDIR' })
      }
      if (index === candidates.length - 1 && kind && !(kind === 'file' ? info.isFile() : info.isDirectory())) {
        throw Object.assign(new Error('Invalid GitHub sync cache entry'), { code: kind === 'file' ? 'EISDIR' : 'ENOTDIR' })
      }
    }
    return full
  }

  /** Clone or pull the repo to get latest remote state */
  async prepare(): Promise<void> {
    let exists = false
    try {
      await this.checkedCachePath('.git', false, 'directory')
      exists = true
    } catch (error) {
      if (!isNotFound(error)) throw cacheError('inspect', '.git', error)
    }
    if (exists) {
      // Remove legacy authenticated URLs before any Git operation. Do not expose
      // the old config via subprocess output or errors, even on migration failure.
      try {
        const path = await this.checkedCachePath('.git/config', false, 'file')
        const config = await readFile(path, 'utf8')
        await writeFile(path, config.replace(/https:\/\/[^\s/]*@github\.com/gi, 'https://github.com'), { mode: 0o600 })
      } catch { throw new Error('Cannot migrate the GitHub sync cache configuration.') }
      await this.git(['config', '--replace-all', 'remote.origin.url', this.remoteUrl])
      await this.git(['config', '--replace-all', 'remote.origin.pushurl', this.remoteUrl])
      await this.recoverInterruptedRebase()
      // Refuse existing linked data before checkout can write through it.
      try { await this.walkDir(this.dataDir, '') } catch (error) { if (!isNotFound(error)) throw cacheError('inspect', 'data', error) }
      await this.git(['fetch', this.remoteUrl, this.branch, '--depth=1'])
      await this.git(['checkout', '-f', '-B', this.branch, 'FETCH_HEAD'])
      await this.recycleUntrackedData()
    } else {
      await mkdir(this.cacheDir, { recursive: true })
      await this.checkedCachePath('.git', true)
      await this.git(['clone', '--depth=1', '--branch', this.branch, this.remoteUrl, this.cacheDir], this.cacheDir)
    }
  }

  /**
   * `null` only when the file does not exist (`ENOENT`). Any other failure
   * (permission denied, I/O error, a directory where a file was expected, a
   * file where a directory was expected) is thrown: the orchestrator treats a
   * missing file as a deletion and prunes against it, so a masked read error
   * would destroy local data.
   */
  async readFile(path: string): Promise<string | null> {
    try {
      if (!isSafeSyncPath(path)) throw Object.assign(new Error('Unsafe sync path'), { code: 'EINVAL' })
      const fullPath = await this.checkedCachePath(`data/${path}`, false, 'file')
      return await readFile(fullPath, 'utf-8')
    } catch (error) {
      if (isNotFound(error)) return null
      throw cacheError('read', path, error)
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    try {
      if (!isSafeSyncPath(path)) throw Object.assign(new Error('Unsafe sync path'), { code: 'EINVAL' })
      const fullPath = await this.checkedCachePath(`data/${path}`, true, 'file')
      await mkdir(dirname(fullPath), { recursive: true })
      await this.checkedCachePath(`data/${path}`, true, 'file')
      await writeFile(fullPath, content, 'utf-8')
    } catch (error) { throw cacheError('write', path, error) }
  }

  /**
   * Every `*.ndjson` and namespace manifest under `data/`. A repository without
   * a `data/` directory is genuinely empty; a failure walking an existing tree is thrown
   * so that it can never be mistaken for "every namespace was deleted".
   */
  async listFiles(): Promise<string[]> {
    try {
      await this.checkedCachePath('data', false, 'directory')
    } catch (error) {
      if (isNotFound(error)) return []
      throw cacheError('list', 'data', error)
    }
    try {
      return await this.walkDir(this.dataDir, '')
    } catch (error) {
      throw cacheError('list', 'data', error)
    }
  }

  async deleteFile(path: string): Promise<void> {
    try {
      if (!isSafeSyncPath(path)) throw Object.assign(new Error('Unsafe sync path'), { code: 'EINVAL' })
      await this.recycleCachePath(`data/${path}`)
    } catch (error) {
      if (isNotFound(error)) return // already gone
      throw cacheError('delete', path, error)
    }
  }

  async deleteAllData(): Promise<number> {
    const files = await this.listFiles()
    try { await this.recycleCachePath('data') } catch (error) { if (!isNotFound(error)) throw cacheError('clear', 'data', error) }
    return files.filter(path => path.endsWith('.ndjson')).length
  }

  private static readonly MAX_PUSH_RETRIES = 3

  /** Commit and push all changes. Returns true if anything was pushed. */
  async flush(): Promise<boolean> {
    const status = await this.git(['status', '--porcelain', '--', 'data/'])
    if (!status) return false

    await this.git(['add', '-f', '--', 'data/'])
    await this.git(['commit', '-m', `sync ${new Date().toISOString()}`])

    for (let attempt = 1; attempt <= GitSyncBackend.MAX_PUSH_RETRIES; attempt++) {
      try {
        await this.git(['push', this.remoteUrl, this.branch])
        return true
      } catch (error) {
        if (!(error instanceof NonFastForwardError) || attempt >= GitSyncBackend.MAX_PUSH_RETRIES) throw error
        try {
          await this.git(['pull', '--rebase', this.remoteUrl, this.branch])
        } catch (rebaseError) {
          await this.recoverInterruptedRebase()
          await this.recycleUntrackedData()
          throw rebaseError
        }
      }
    }

    return false
  }

  private async walkDir(dir: string, prefix: string): Promise<string[]> {
    await this.checkedCachePath(prefix ? `data/${prefix}` : 'data', false, 'directory')
    const entries = await readdir(dir, { withFileTypes: true })
    const files: string[] = []

    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!isSafeSyncPath(relPath)) throw Object.assign(new Error('Unsafe sync cache entry'), { code: 'EINVAL' })
      await this.checkedCachePath(`data/${relPath}`)
      if (entry.isDirectory()) {
        files.push(...await this.walkDir(join(dir, entry.name), relPath))
      } else if (entry.isFile() && (entry.name.endsWith('.ndjson') || (['manifest.json', 'tool-calls.v1.json'].includes(entry.name) && prefix !== '' && !prefix.includes('/')))) {
        files.push(relPath)
      }
    }

    return files.sort()
  }

  private async assertMovableTree(path: string): Promise<void> {
    const info = await lstat(path)
    if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1) throw Object.assign(new Error('Linked sync cache entry'), { code: 'ELOOP' })
    if (info.isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true })) await this.assertMovableTree(join(path, entry.name))
    } else if (!info.isFile()) throw Object.assign(new Error('Invalid sync cache entry'), { code: 'EINVAL' })
  }

  private async recycleCachePath(path: string): Promise<void> {
    const full = await this.checkedCachePath(path)
    await this.assertMovableTree(full)
    const recycle = join(dirname(this.cacheDir), 'sync-recycle')
    try {
      const info = await lstat(recycle)
      if (!info.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error('Unsafe sync recycle directory'), { code: 'ELOOP' })
    } catch (error) { if (!isNotFound(error)) throw error }
    await mkdir(recycle, { recursive: true, mode: 0o700 })
    await rename(full, join(recycle, `${Date.now()}-${randomUUID()}`))
  }

  private async recoverInterruptedRebase(): Promise<void> {
    let interrupted = false
    for (const path of ['.git/rebase-merge', '.git/rebase-apply']) {
      try { await this.recycleCachePath(path); interrupted = true } catch (error) { if (!isNotFound(error)) throw cacheError('recover', path, error) }
    }
    if (interrupted) await this.git(['checkout', '-f', '-B', this.branch, 'ORIG_HEAD'])
  }

  private async recycleUntrackedData(): Promise<void> {
    const paths = (await this.git(['ls-files', '--others', '-z', '--', 'data/'], undefined, true)).split('\u0000').filter(Boolean)
    for (const path of paths) {
      if (!isSafeSyncPath(path) || !path.startsWith('data/')) throw new Error('Unsafe untracked GitHub sync path')
      try { await this.recycleCachePath(path) } catch (error) { if (!isNotFound(error)) throw cacheError('recover', 'data', error) }
    }
  }
}
