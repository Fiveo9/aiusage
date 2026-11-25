import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const file = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/record-demo-gif.mjs')
const parsed = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
const functions = parsed.statements.filter(statement => ts.isFunctionDeclaration(statement)
  && ['commandExists', 'launchCommand'].includes(statement.name?.text ?? ''))
if (functions.length !== 2) throw Error('GIF command definitions were not completely inspected')
const definitions = functions.map(statement => statement.getText(parsed)).join('\n')

function harness(platform = 'win32', found = 'C:\\tools\\npm\r\nC:\\tools\\npm.cmd\r\n', status = 0,
  shim = '"%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*', exists = true) {
  const spawnSync = vi.fn(() => ({ status, stdout: found }))
  const read = vi.fn(() => shim)
  const context = {
    process: { platform, execPath: 'synthetic-node' }, spawnSync,
    readFileSync: read, existsSync: () => exists, resolve: win32.resolve, dirname: win32.dirname,
  }
  const api = runInNewContext(definitions + '\n({ commandExists, launchCommand })', context) as {
    commandExists(command: string): boolean
    launchCommand(command: string, args: string[]): [string, string[]]
  }
  return { api, spawnSync, read }
}

describe('GIF command entry resolution', () => {
  it('keeps POSIX command arguments and uses which without invoking a shell', () => {
    const h = harness('linux')
    const args = ['--version']
    expect(h.api.launchCommand('npm', args)).toEqual(['npm', args])
    expect(h.api.commandExists('npm')).toBe(true)
    expect(h.spawnSync).toHaveBeenCalledWith('which', ['npm'], { stdio: 'ignore', windowsHide: true })
    expect(h.read).not.toHaveBeenCalled()
  })

  it('skips the extensionless POSIX shim returned before npm.cmd on Windows and keeps arguments separate', () => {
    const h = harness()
    const args = ['exec', '--', 'synthetic & argument', 'quote"and space']
    expect(h.api.launchCommand('npm', args)).toEqual(['synthetic-node', ['C:\\tools\\node_modules\\npm\\bin\\npm-cli.js', ...args]])
    expect(h.read).toHaveBeenCalledWith('C:\\tools\\npm.cmd', 'utf8')
    expect(h.spawnSync).toHaveBeenCalledWith('where.exe', ['npm'], { encoding: 'utf8', windowsHide: true })
  })

  it('uses a Windows native executable directly and detects commands through where.exe', () => {
    const h = harness('win32', 'C:\\tools\\ffmpeg.exe\r\n')
    expect(h.api.launchCommand('ffmpeg', ['-version'])).toEqual(['C:\\tools\\ffmpeg.exe', ['-version']])
    expect(h.api.commandExists('ffmpeg')).toBe(true)
    expect(h.spawnSync).toHaveBeenLastCalledWith('where.exe', ['ffmpeg'], { stdio: 'ignore', windowsHide: true })
    expect(h.read).not.toHaveBeenCalled()
  })

  it('refuses extensionless files instead of attempting to spawn a POSIX script on Windows', () => {
    const h = harness('win32', 'C:\\tools\\npm\r\n')
    expect(() => h.api.launchCommand('npm', [])).toThrow('Command not found')
    expect(h.read).not.toHaveBeenCalled()
  })

  it('does not use stdout from a failed where.exe invocation', () => {
    const h = harness('win32', 'C:\\tools\\npm.cmd\r\n', 1)
    expect(() => h.api.launchCommand('npm', [])).toThrow('Command not found')
    expect(h.read).not.toHaveBeenCalled()
  })

  it('refuses an unsupported batch shim without evaluating its text', () => {
    const h = harness('win32', 'C:\\tools\\npm.cmd\r\n', 0, 'echo synthetic')
    expect(() => h.api.launchCommand('npm', [])).toThrow('Unsupported command shim')
  })

  it('rejects a batch shim whose JS entry escapes the executable directory', () => {
    const h = harness('win32', 'C:\\tools\\npm.cmd\r\n', 0, '"%dp0%\\node_modules\\..\\..\\outside.js" %*')
    expect(() => h.api.launchCommand('npm', [])).toThrow('Unsupported command shim')
  })

  it('refuses a batch shim with an absent JS entry', () => {
    const h = harness('win32', 'C:\\tools\\npm.cmd\r\n', 0, undefined, false)
    expect(() => h.api.launchCommand('npm', [])).toThrow('Unsupported command shim')
  })
})
