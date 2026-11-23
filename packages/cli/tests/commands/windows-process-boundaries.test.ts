import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { execSync, spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

vi.mock('node:child_process', () => ({ execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn(), execFileSync: vi.fn(),
  execFile: vi.fn((_command: unknown, ...args: unknown[]) => {
    const callback = args.at(-1)
    if (typeof callback === 'function') callback(new Error('Unexpected synthetic execFile'))
  }),
}))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), existsSync: vi.fn(() => false), writeFileSync: vi.fn() }))
vi.mock('../../src/config.js', async original => ({ ...await original<typeof import('../../src/config.js')>(), AIUSAGE_DIR: 'C:\\Synthetic Profile\\Ai Usage' }))
const menu = vi.hoisted(() => ({ answers: [] as string[] }))
vi.mock('node:readline', () => ({ createInterface: () => ({
  question: (_question: string, callback: (answer: string) => void) => {
    if (!menu.answers.length) throw new Error('Unexpected synthetic prompt')
    callback(menu.answers.shift()!)
  }, close: vi.fn(),
}) }))
import { getPidOnPort, runMenu } from '../../src/commands/menu.js'
import { launchWidget } from '../../src/commands/widget.js'
import { buildPm2Config, runCli } from '../../src/cli.js'
import { AIUSAGE_DIR } from '../../src/config.js'

const entry = 'C:\\Synthetic Tools\\aiusage\\dist\\index.js'
const originalArgv = process.argv
const originalExitCode = process.exitCode
let child: EventEmitter & { unref: ReturnType<typeof vi.fn> }
beforeEach(() => {
  vi.clearAllMocks()
  process.argv = [process.execPath, entry]
  child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  vi.mocked(spawn).mockReturnValue(child as any)
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as any)
  vi.mocked(execSync).mockImplementation(() => { throw new Error('synthetic command not found') })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})
afterEach(() => { process.argv = originalArgv; process.exitCode = originalExitCode; vi.useRealTimers(); vi.restoreAllMocks() })

describe('review menu and PM2 command boundaries', () => {
  it.each([['Y', ['parse']], ['N', ['parse', '--no-progress']]])('honors progress selection %s without an unsupported flag', async (answer, expected) => {
    menu.answers = ['2', '1', answer as string, '', '0', '5']
    await runMenu()
    expect(vi.mocked(spawnSync).mock.calls[0][0]).toBe(process.execPath)
    expect(vi.mocked(spawnSync).mock.calls[0][1]).toEqual([entry, ...expected as string[]])
  })
  it('starts the dashboard through the same Node/CLI entry and forwards the requested port', async () => {
    vi.useFakeTimers()
    vi.mocked(spawn).mockImplementation(() => {
      vi.mocked(execSync).mockReturnValue((process.platform === 'win32' ? 'TCP 127.0.0.1:3847 0.0.0.0:0 LISTENING 12345\n' : '12345\n') as any)
      return child as any
    })
    menu.answers = ['1', '1', '', '0', '5']
    const running = runMenu()
    await vi.advanceTimersByTimeAsync(2000)
    await running
    expect(vi.mocked(spawn).mock.calls[0][0]).toBe(process.execPath)
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual([entry, 'serve', '--port', '3847'])
    expect(vi.mocked(spawn).mock.calls[0][2]).toMatchObject({ detached: true, windowsHide: true })
  })
  it('serializes backslash paths as valid CJS string values', () => {
    const config = buildPm2Config(false)
    const module = { exports: {} as { apps: Array<{ script: string }> } }
    runInNewContext(config, { module })
    expect(module.exports.apps[0].script).toBe(join(AIUSAGE_DIR, 'pm2-server.cjs'))
  })
  it('uses the known Node and CLI entry in the generated wrapper, not a batch file as a JS entry', () => {
    buildPm2Config(false)
    const wrapper = vi.mocked(writeFileSync).mock.calls.find(([file]) => String(file).endsWith('pm2-server.cjs'))![1] as string
    const wrappedChild = new EventEmitter()
    const start = vi.fn(() => wrappedChild)
    const lookup = vi.fn(() => 'C:\\Synthetic Tools\\aiusage.cmd\r\nC:\\other\\aiusage.cmd')
    runInNewContext(wrapper, {
      require: (id: string) => id === 'child_process' ? { spawn: start, execSync: lookup }
        : id === 'path' ? { dirname: () => '', join } : { accessSync: () => { throw new Error('synthetic absent node') } },
      process: { execPath: process.execPath, env: {}, on: vi.fn(), exit: vi.fn() }, console,
    })
    expect(start).toHaveBeenCalledWith(process.execPath, [entry, 'serve'], expect.any(Object))
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe.runIf(process.platform === 'win32')('review Windows command lookup and listener boundaries', () => {
  it('matches the exact local listening port, not a longer port or a remote endpoint', () => {
    vi.mocked(execSync).mockReturnValue('TCP 0.0.0.0:38470 0.0.0.0:0 LISTENING 700\nTCP [::]:3847 [::]:0 LISTENING 101\nTCP 0.0.0.0:9999 127.0.0.1:3847 LISTENING 999\n' as any)
    expect(getPidOnPort(3847)).toBe('101')
  })
  it('does not return a PID when only a prefix-matched listening port exists', () => {
    vi.mocked(execSync).mockReturnValue('TCP 0.0.0.0:38470 0.0.0.0:0 LISTENING 700\n' as any)
    expect(getPidOnPort(3847)).toBeNull()
  })
  it('selects one executable from multiline where output and invokes a quoted cmd shim', async () => {
    const shim = 'C:\\Synthetic Tools\\aiusage-widget.cmd'
    vi.mocked(execSync).mockReturnValue(`C:\\Synthetic Tools\\aiusage-widget\r\n${shim}\r\n` as any)
    await launchWidget()
    expect(spawn).toHaveBeenCalledWith(`"${shim}"`, [], expect.objectContaining({ shell: true, windowsHide: true }))
  })
  it('handles a widget spawn error without an uncaught EventEmitter error', async () => {
    vi.mocked(execSync).mockReturnValue('C:\\Synthetic Tools\\aiusage-widget.cmd' as any)
    await launchWidget()
    expect(() => child.emit('error', new Error('synthetic spawn failure'))).not.toThrow()
    expect(process.exitCode).toBe(1)
  })
  it('detects the optional PM2 widget with Windows command lookup', async () => {
    vi.mocked(execSync).mockImplementation(command => {
      if (String(command).startsWith('where ')) return 'C:\\Synthetic Tools\\aiusage-widget.cmd' as any
      throw new Error('synthetic unsupported lookup')
    })
    await runCli(['node', entry, 'pm2-setup'])
    const config = vi.mocked(writeFileSync).mock.calls.find(([file]) => String(file).endsWith('ecosystem.config.cjs'))![1] as string
    const module = { exports: {} as { apps: Array<{ name: string }> } }
    runInNewContext(config, { module })
    expect(module.exports.apps.map(app => app.name)).toContain('aiusage-widget')
  })
})
