import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import * as path from 'node:path'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as ui from '../src/ui'
import * as settingsModule from '../src/settings'
import { resolveCliEntry } from '../src/cli'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function main({ databaseThrows = false, queryThrows = false, lock = true, port = '3847' } = {}) {
  let ready: () => void = () => {}
  const app = Object.assign(new EventEmitter(), { setName: vi.fn(), isPackaged: false, quit: vi.fn(), exit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => lock), whenReady: () => new Promise<void>(resolve => { ready = resolve }) })
  const windows: any[] = []
  const trays: any[] = []
  class Window extends EventEmitter {
    destroyed = false
    visible = false
    webContents = { send: vi.fn() }
    constructor() { super(); windows.push(this) }
    isDestroyed() { return this.destroyed }
    isVisible() { if (this.destroyed) throw Error('Object has been destroyed'); return this.visible }
    show() { if (this.destroyed) throw Error('Object has been destroyed'); this.visible = true }
    hide() { if (this.destroyed) throw Error('Object has been destroyed'); this.visible = false }
    focus() {}
    loadFile() { return Promise.resolve() }
    getBounds() { return { x: 0, y: 0, width: 380, height: 500 } }
    setPosition() {}
    setSize() {}
  }
  class Tray extends EventEmitter {
    constructor() { super(); trays.push(this) }
    getBounds() { return { x: 10, y: 900, width: 16, height: 16 } }
    setToolTip() {}
    popUpContextMenu() {}
    destroy() {}
  }
  const db = { close: vi.fn() }
  const Database = vi.fn(function () { if (databaseThrows) throw Error('synthetic unavailable'); return db })
  const handles = new Map<string, Function>()
  const ipc = Object.assign(new EventEmitter(), { handle: (name: string, handler: Function) => handles.set(name, handler) })
  const menus: any[][] = []
  const request = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() })
  const http = { get: vi.fn((_url: string, callback: Function) => { callback({ destroy() {}, statusCode: 200 }); return request }) }
  const spawn = vi.fn(() => Object.assign(new EventEmitter(), { unref() {} }))
  const saveSettings = vi.fn()
  const writes = vi.fn()
  const source = transpileModule(readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 },
  }).outputText
  const modules: Record<string, any> = {
    electron: { app, BrowserWindow: Window, Tray, ipcMain: ipc, Menu: { buildFromTemplate: (menu: any[]) => { menus.push(menu); return menu } },
      shell: { openExternal: vi.fn(async () => {}) }, nativeImage: { createFromBuffer: vi.fn() }, dialog: { showErrorBox: vi.fn() },
      screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }) }, nativeTheme: {} },
    'node:path': path, 'node:os': { homedir: () => 'C:/synthetic-widget' },
    'node:fs': { existsSync: (name: string) => name.endsWith('cache.db') || name.endsWith('.serve-port'),
      readFileSync: () => port, mkdirSync: vi.fn(), writeFileSync: writes },
    './currency': { EXCHANGE_RATE_SOURCE: 'synthetic-rate', fetchUsdCnyRate: vi.fn(async () => ({ rate: 7, source: 'synthetic-rate' })) },
    './settings': { ...settingsModule, loadSettings: settingsModule.getDefaultSettings, saveSettings },
    './data': { queryWidgetData: vi.fn(() => { if (queryThrows) throw Error('synthetic query'); return {} }) },
    './i18n': { t: () => ({ quit: 'Quit' }) }, './cli': { CLI_HELP: 'synthetic CLI', resolveCliEntry: () => 'C:/synthetic-cli.js' },
    './ui': ui, 'better-sqlite3': Database, http, child_process: { spawn },
  }
  const requireMock: any = (id: string) => { if (!(id in modules)) throw Error(`Unexpected module ${id}`); return modules[id] }
  requireMock.resolve = (id: string) => id
  modules['node:module'] = { createRequire: () => requireMock }
  new Function('require', 'exports', '__filename', '__dirname', 'process', source)(requireMock, {}, 'C:/synthetic-widget/main.js', 'C:/synthetic-widget',
    { platform: 'win32', argv: ['electron', 'main.js'], env: {}, pid: 101 })
  return { app, windows, trays, db, handles, ipc, menus, http, spawn, Database, saveSettings, writes,
    mount: async () => { ready(); await Promise.resolve(); await Promise.resolve() } }
}

describe('review actual Widget main lifecycle', () => {
  it('hides on close, keeps a usable window, and tolerates a destroyed window', async () => {
    const view = main(); await view.mount()
    const window = view.windows[0]
    const event = { preventDefault: vi.fn() }
    window.emit('close', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    window.destroyed = true; window.emit('closed')
    expect(() => view.trays[0].emit('click')).not.toThrow()
    view.app.emit('before-quit')
  })
  it('uses graceful tray quit and clears timers/database on before-quit', async () => {
    const view = main(); await view.mount()
    view.trays[0].emit('right-click'); view.menus[0].find(item => item.label === 'Quit').click()
    expect(view.app.quit).toHaveBeenCalled()
    view.app.emit('before-quit')
    expect(vi.getTimerCount()).toBe(0)
    expect(view.db.close).toHaveBeenCalledOnce()
  })
  it('acquires a single-instance lock and does not initialize a losing instance', async () => {
    const view = main({ lock: false }); await view.mount()
    expect(view.app.requestSingleInstanceLock).toHaveBeenCalledOnce()
    expect(view.app.quit).toHaveBeenCalled()
    expect(view.windows).toHaveLength(0)
  })
  it('keeps startup alive when the readonly database cannot be opened', async () => {
    const view = main({ databaseThrows: true }); await view.mount()
    expect(view.windows).toHaveLength(1)
    view.app.emit('before-quit')
  })
  it('opens the readonly database with a bounded busy timeout', async () => {
    const view = main(); await view.mount()
    expect(view.Database.mock.calls[0][1]).toMatchObject({ readonly: true, timeout: 30000 })
    view.app.emit('before-quit')
  })
  it('validates settings at the IPC boundary', async () => {
    const view = main(); await view.mount()
    const result = view.handles.get('widget:save-settings')!({}, { rangeDays: 9999, refreshIntervalSec: 0, theme: 'invalid', locale: 'invalid', currency: 'invalid' })
    expect(result).toMatchObject({ rangeDays: 365, refreshIntervalSec: 5, theme: 'system', locale: 'en', currency: 'USD' })
    view.app.emit('before-quit')
  })
  it('hides on blur for an npm-installed runtime without the explicit dev flag', async () => {
    const view = main(); await view.mount(); const window = view.windows[0]; window.visible = true
    window.emit('blur'); expect(window.visible).toBe(false); view.app.emit('before-quit')
  })
  it('probes IPv4, rejects an invalid port file and coalesces repeated opens', async () => {
    const view = main({ port: '99999' }); await view.mount()
    const open = view.handles.get('widget:open-dashboard')!
    await Promise.all([open(), open()])
    expect(view.http.get).toHaveBeenCalledTimes(1)
    expect(view.http.get.mock.calls[0][0]).toBe('http://127.0.0.1:3847')
    view.app.emit('before-quit')
  })
  it('keeps the PID pointing to the lock owner after a second launch', async () => {
    const view = main(); await view.mount()
    view.app.emit('second-instance')
    expect(view.writes).toHaveBeenCalledWith(expect.stringContaining('widget.pid'), '101', expect.anything())
    view.app.emit('before-quit')
  })
  it('does not create a launch retry from an HTTP response received after quit', async () => {
    const view = main(); await view.mount()
    const requests: any[] = []
    view.http.get.mockImplementation(() => {
      const request = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() })
      requests.push(request); return request
    })
    const opening = view.handles.get('widget:open-dashboard')!()
    requests[0].emit('error', Error('synthetic offline'))
    for (let i = 0; i < 8 && requests.length < 2; i++) await Promise.resolve()
    expect(requests).toHaveLength(2)
    view.app.emit('before-quit')
    requests[1].emit('error', Error('synthetic late response'))
    for (let i = 0; i < 8; i++) await Promise.resolve()
    try { expect(vi.getTimerCount()).toBe(0) }
    finally { view.app.emit('before-quit'); await opening }
  })
})

it('normalizes persisted options without accepting arbitrary keys or wrong types', () => {
  expect((settingsModule as any).normalizeSettings).toBeTypeOf('function')
  expect((settingsModule as any).normalizeSettings({ rangeDays: -3, refreshIntervalSec: Infinity, showCost: 'yes', injected: true }))
    .toEqual({ ...settingsModule.getDefaultSettings(), rangeDays: 1 })
})

it('writes a foreground PID and preserves signal exit status without visible helper windows', () => {
  const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn(), unref: vi.fn() })
  const spawn = vi.fn(() => child), writeFileSync = vi.fn()
  const processMock = Object.assign(new EventEmitter(), { argv: ['node', 'launcher', '--foreground'], exit: vi.fn() })
  const modules: Record<string, any> = { child_process: { spawn }, fs: { writeFileSync, mkdirSync: vi.fn() },
    os: { homedir: () => 'C:/synthetic-widget' }, electron: 'C:/synthetic-electron.exe', path }
  new Function('require', '__dirname', 'process', readFileSync(new URL('../bin/launcher.js', import.meta.url), 'utf8').replace(/^#![^\n]*\n/, ''))(
    (id: string) => modules[id], 'C:/synthetic-widget/bin', processMock)
  expect(writeFileSync).toHaveBeenCalledWith(expect.stringContaining('widget.pid'), '4242', expect.anything())
  expect(spawn.mock.calls[0][2]).toMatchObject({ windowsHide: true })
  child.emit('exit', null, 'SIGTERM')
  expect(processMock.exit).toHaveBeenCalledWith(143)
})

it('locates the explicitly installed CLI beside a pnpm global virtual-store widget', () => {
  const widgetDir = path.join('C:/synthetic-pnpm/global/5/node_modules/.pnpm/widget@1/node_modules/@fiveo9/aiusage-widget/dist')
  const manifest = path.join('C:/synthetic-pnpm/global/5/node_modules/@fiveo9/aiusage/package.json')
  const entry = path.join(path.dirname(manifest), 'dist/index.js')
  expect(resolveCliEntry(widgetDir, () => { throw Error('not a dependency') }, value => value === entry,
    value => { if (value !== manifest) throw Error('no manifest'); return JSON.stringify({ name: '@fiveo9/aiusage' }) }))
    .toBe(entry)
})
