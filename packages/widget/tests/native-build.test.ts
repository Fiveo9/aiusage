import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const widgetRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
type MockRequire = ((name: string) => unknown) & { resolve(name: string): string; main?: unknown }

function loadScript(name: string, require: MockRequire, process: object) {
  const file = path.join(widgetRoot, 'bin', name)
  const module = { exports: {} }
  runInNewContext(readFileSync(file, 'utf8'), {
    module, require, process, __dirname: path.dirname(file),
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }, { filename: file })
  return module.exports
}

interface Entry { size: number; mtimeMs: number; text?: string; linked?: boolean }
function nativeHarness(failure?: 'rebuild' | 'copy' | 'codesign' | 'restore', npm = true) {
  const packageFile = path.join(widgetRoot, 'node_modules/native-package/package.json')
  const source = path.join(path.dirname(packageFile), 'build/Release/better_sqlite3.node')
  const target = path.join(widgetRoot, 'dist/native/better_sqlite3.node')
  const marker = target + '.cache.json'
  const files = new Map<string, Entry>([[source, { size: 20, mtimeMs: 100 }]])
  const events: string[] = []
  let clock = 100
  const versions = { electron: '33.0.0', sqlite: '12.0.0', modules: '127' }
  const process = {
    env: npm ? { npm_execpath: path.join(widgetRoot, 'synthetic/npm-cli.js') } : {},
    versions, platform: failure === 'codesign' ? 'darwin' : 'win32', arch: 'x64',
    execPath: 'synthetic-node', argv: ['synthetic-node', 'prepare-native.js'],
  }
  function entry(file: string) {
    const value = files.get(file)
    if (!value) throw Error('Synthetic file missing')
    return value
  }
  const fs = {
    existsSync: (file: string) => files.has(file),
    statSync: (file: string) => entry(file),
    lstatSync: (file: string) => ({ ...entry(file), nlink: 1, isSymbolicLink: () => Boolean(entry(file).linked) }),
    readFileSync: (file: string) => entry(file).text,
    writeFileSync: (file: string, text: string) => { events.push('marker'); files.set(file, { size: text.length, mtimeMs: ++clock, text }) },
    renameSync: (from: string, to: string) => { files.set(to, entry(from)); files.delete(from) },
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn((from: string, to: string) => {
      events.push('copy')
      if (failure === 'copy') throw Error('Synthetic copy failure')
      files.set(to, { size: entry(from).size, mtimeMs: ++clock })
    }),
  }
  const rebuild = vi.fn(async () => {
    events.push('electron')
    files.set(source, { size: 30, mtimeMs: ++clock })
    if (failure === 'rebuild') throw Error('Synthetic rebuild failure')
  })
  const execFileSync = vi.fn((command: string, args: string[], options: { cwd?: string; stdio: string; windowsHide?: boolean }) => {
    if (command === 'codesign') {
      events.push('codesign')
      if (failure === 'codesign') throw Error('Synthetic codesign failure')
      return
    }
    events.push('node')
    expect(command).toBe(process.execPath)
    expect(args).toEqual([process.env.npm_execpath, 'run', 'install'])
    expect(options).toMatchObject({ cwd: path.dirname(packageFile), stdio: 'pipe', windowsHide: true })
    files.set(source, { size: 20, mtimeMs: ++clock })
    if (failure === 'restore') throw Error('Synthetic restore failure')
  })
  const require = Object.assign((name: string) => {
    if (name === 'node:fs') return fs
    if (name === 'node:path') return path
    if (name === 'node:child_process') return { execFileSync }
    if (name === '@electron/rebuild') return { rebuild }
    if (name === './stale-dist.js') return { recycleStaleDist: () => 0 }
    if (name === 'electron/package.json') return { version: versions.electron }
    if (name.endsWith('/package.json')) return { version: versions.sqlite }
    throw Error('Unexpected synthetic import')
  }, { resolve: () => packageFile })
  const api = loadScript('prepare-native.js', require, process) as {
    main(): Promise<void>; isTargetFresh(): boolean; saveMarker(): void
  }
  return { api, files, events, source, target, marker, versions, rebuild, fs }
}

describe('native build cache and restoration', () => {
  it('migrates a fresh legacy copy to a marker without rebuilding', async () => {
    const h = nativeHarness()
    h.files.set(h.target, { size: 30, mtimeMs: 200 })
    await h.api.main()
    await h.api.main()
    expect(h.rebuild).not.toHaveBeenCalled()
    expect(h.events).toEqual(['marker'])
    expect(h.api.isTargetFresh()).toBe(true)
  })

  it('saves source metadata after Node restoration and reuses it even when source is newer than the copied target', async () => {
    const h = nativeHarness()
    await h.api.main()
    expect(h.events).toEqual(['electron', 'copy', 'node', 'marker'])
    expect(h.files.get(h.source)!.mtimeMs).toBeGreaterThan(h.files.get(h.target)!.mtimeMs)
    const marker = JSON.parse(h.files.get(h.marker)!.text!)
    expect(marker.source).toEqual(h.files.get(h.source))
    expect(marker.target).toEqual(h.files.get(h.target))
    expect(h.api.isTargetFresh()).toBe(true)
    await h.api.main()
    expect(h.rebuild).toHaveBeenCalledTimes(1)
    expect(h.fs.copyFileSync).toHaveBeenCalledTimes(1)
  })

  it.each(['source', 'electron', 'sqlite', 'modules'] as const)('invalidates the marker when %s changes', async (field) => {
    const h = nativeHarness()
    await h.api.main()
    if (field === 'source') h.files.get(h.source)!.mtimeMs += 1
    else h.versions[field] += '.changed'
    expect(h.api.isTargetFresh()).toBe(false)
    await h.api.main()
    expect(h.rebuild).toHaveBeenCalledTimes(2)
    expect(h.api.isTargetFresh()).toBe(true)
  })

  it.each(['rebuild', 'copy', 'codesign', 'restore'] as const)('restores Node after %s failure and never records a successful cache', async (failure) => {
    const h = nativeHarness(failure)
    await expect(h.api.main()).rejects.toThrow(`Synthetic ${failure} failure`)
    expect(h.events).toContain('node')
    expect(h.events).not.toContain('marker')
    expect(h.files.has(h.marker)).toBe(false)
    expect(h.api.isTargetFresh()).toBe(false)
  })

  it('requires the Node restore entry before changing the shared binding', async () => {
    const h = nativeHarness(undefined, false)
    await expect(h.api.main()).rejects.toThrow('through pnpm or npm')
    expect(h.events).toEqual([])
    expect(h.rebuild).not.toHaveBeenCalled()
  })

  it('refuses a linked cache marker before any rebuild', async () => {
    const h = nativeHarness()
    h.files.set(h.marker, { size: 0, mtimeMs: 0, linked: true })
    await expect(h.api.main()).rejects.toThrow('Linked native cache marker')
    expect(h.events).toEqual([])
  })

  it('does not overwrite an abandoned temporary marker', () => {
    const h = nativeHarness()
    h.files.set(h.target, { size: 30, mtimeMs: 200 })
    h.files.set(h.marker + '.tmp', { size: 0, mtimeMs: 0 })
    expect(() => h.api.saveMarker()).toThrow('recovery required')
    expect(h.events).toEqual([])
  })
})

function nodeCheckHarness(loadable: boolean, repaired = true, npm = true) {
  const execFileSync = vi.fn(() => { loadable = repaired })
  const close = vi.fn()
  const Database = vi.fn(function () {
    if (!loadable) throw Error('Synthetic ABI mismatch')
    return { close }
  })
  const require = Object.assign((name: string) => {
    if (name === 'node:path') return path
    if (name === 'node:child_process') return { execFileSync }
    if (name === 'better-sqlite3') return Database
    throw Error('Unexpected synthetic import')
  }, { resolve: () => path.join(widgetRoot, 'synthetic/package.json') })
  const run = () => loadScript('ensure-node-native.js', require, {
    env: npm ? { npm_execpath: 'synthetic-npm-cli.js' } : {}, execPath: 'synthetic-node',
  })
  return { run, execFileSync, Database, close }
}

describe('conditional Node native preparation', () => {
  it('does not rebuild a loadable Node binding and closes the probe database', () => {
    const h = nodeCheckHarness(true)
    h.run()
    expect(h.execFileSync).not.toHaveBeenCalled()
    expect(h.Database).toHaveBeenCalledWith(':memory:')
    expect(h.close).toHaveBeenCalledOnce()
  })

  it('rebuilds only after a failed probe and verifies the restored binding', () => {
    const h = nodeCheckHarness(false)
    h.run()
    expect(h.execFileSync).toHaveBeenCalledOnce()
    expect(h.execFileSync).toHaveBeenCalledWith('synthetic-node', ['synthetic-npm-cli.js', 'run', 'install'], {
      cwd: path.join(widgetRoot, 'synthetic'), stdio: 'pipe', windowsHide: true,
    })
    expect(h.Database).toHaveBeenCalledTimes(2)
    expect(h.close).toHaveBeenCalledOnce()
  })

  it('fails rather than rebuilding with a missing package manager entry', () => {
    const h = nodeCheckHarness(false, true, false)
    expect(h.run).toThrow('through pnpm or npm')
    expect(h.execFileSync).not.toHaveBeenCalled()
  })

  it('does not accept a rebuild that leaves the Node binding unavailable', () => {
    const h = nodeCheckHarness(false, false)
    expect(h.run).toThrow('remains unavailable')
    expect(h.Database).toHaveBeenCalledTimes(2)
  })
})

function staleOutputHarness(sources = ['main.ts', 'i18n.ts'], linked?: 'root' | 'file', outside = false) {
  const output = path.join(widgetRoot, 'dist')
  const directories = new Set([output, path.join(output, 'legacy'), path.join(output, 'renderer'), path.join(output, 'native')])
  const files = new Set(['main.js', 'main.js.map', 'i18n.js', 'i18n.js.map', 'retired.js', 'legacy/old.js.map', 'renderer/app.js', 'native/prebuilt.js'].map(name => path.join(output, name)))
  const recycleOutput = vi.fn((_repo: string, file: string) => { files.delete(file) })
  const require = Object.assign((name: string) => {
    if (name === 'node:path') return path
    if (name === 'node:fs') return {
      existsSync: (file: string) => directories.has(file) || files.has(file),
      lstatSync: (file: string) => ({
        isDirectory: () => directories.has(file), isFile: () => files.has(file), nlink: 1,
        isSymbolicLink: () => file === (linked === 'root' ? output : linked === 'file' ? path.join(output, 'retired.js') : undefined),
      }),
      readdirSync: (directory: string) => [...directories, ...files].filter(file => path.dirname(file) === directory).map(file => path.basename(file)),
    }
    if (name === 'typescript') return {
      sys: { readFile: vi.fn() }, readConfigFile: () => ({ config: {} }),
      parseJsonConfigFileContent: () => ({ fileNames: [path.join(widgetRoot, 'src/main.ts')], options: { rootDir: path.join(widgetRoot, 'src'), outDir: outside ? path.dirname(widgetRoot) : output, sourceMap: true } }),
      createProgram: () => ({ getSourceFiles: () => sources.map(name => ({ fileName: path.join(widgetRoot, 'src', name), isDeclarationFile: false })) }),
    }
    if (name.endsWith('recycle-output.cjs')) return { recycleOutput }
    throw Error('Unexpected synthetic import')
  }, { resolve: () => '' })
  const api = loadScript('stale-dist.js', require, {}) as { recycleStaleDist(root: string): number }
  return { api, files, recycleOutput, output }
}

describe('stale TypeScript output recycling', () => {
  it('keeps emitted imported dependencies and renderer/native assets while recycling nested obsolete JS/maps', () => {
    const h = staleOutputHarness()
    expect(h.api.recycleStaleDist(widgetRoot)).toBe(2)
    expect(h.recycleOutput.mock.calls.map(([, file]) => file).sort()).toEqual(['legacy/old.js.map', 'retired.js'].map(name => path.join(h.output, name)).sort())
    for (const name of ['main.js', 'main.js.map', 'i18n.js', 'i18n.js.map', 'renderer/app.js', 'native/prebuilt.js']) expect(h.files.has(path.join(h.output, name))).toBe(true)
  })

  it('refuses to recycle when no emit targets were discovered', () => {
    const h = staleOutputHarness([])
    expect(() => h.api.recycleStaleDist(widgetRoot)).toThrow('No widget emit targets')
    expect(h.recycleOutput).not.toHaveBeenCalled()
  })

  it('refuses an output root outside the package', () => {
    const h = staleOutputHarness(undefined, undefined, true)
    expect(() => h.api.recycleStaleDist(widgetRoot)).toThrow('outside package')
    expect(h.recycleOutput).not.toHaveBeenCalled()
  })

  it.each(['root', 'file'] as const)('refuses a linked output %s', (linked) => {
    const h = staleOutputHarness(undefined, linked)
    expect(() => h.api.recycleStaleDist(widgetRoot)).toThrow('Linked widget output')
    if (linked === 'root') expect(h.recycleOutput).not.toHaveBeenCalled()
    else {
      // Earlier ordinary stale files may already have been recovered; the
      // linked file itself must remain untouched, not require atomic pruning.
      expect(h.files.has(path.join(h.output, 'retired.js'))).toBe(true)
      expect(h.recycleOutput.mock.calls.some(([, file]) => file === path.join(h.output, 'retired.js'))).toBe(false)
    }
  })
})
