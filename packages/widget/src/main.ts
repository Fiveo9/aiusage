import { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog, screen, nativeTheme } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { EXCHANGE_RATE_SOURCE, fetchUsdCnyRate } from './currency'
import type { ExchangeRateState } from './currency'
import { queryWidgetData } from './data'
import { t } from './i18n'
import { loadSettings, saveSettings } from './settings'
import type { WidgetSettings } from './settings'
import { CLI_HELP, resolveCliEntry } from './cli'
import {
  getTrayIconNativeImage,
  getWidgetNativeBindingPath,
  getWindowPosition,
  hasUsableTrayBounds,
  shouldHideWindowOnBlur,
  shouldHideWindowOnClose,
  shouldShowWindowOnLaunch,
} from './ui'

const nodeRequire = createRequire(__filename)
const Database = nodeRequire('better-sqlite3') as typeof import('better-sqlite3')

const DB_PATH = join(homedir(), '.aiusage', 'cache.db')
const PORT_FILE = join(homedir(), '.aiusage', '.serve-port')
const FX_CACHE_FILE = join(homedir(), '.aiusage', 'widget-exchange-rate.json')
const DASHBOARD_PORT = 3847
const WINDOW_WIDTH = 380
const DEFAULT_WINDOW_HEIGHT = 500
const MIN_WINDOW_HEIGHT = 320
const FX_CACHE_TTL_MS = 6 * 60 * 60 * 1000

let tray: Tray | null = null
let win: BrowserWindow | null = null
let db: InstanceType<typeof Database> | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null
let positionRetryTimers: Array<ReturnType<typeof setTimeout>> = []
let settings: WidgetSettings = loadSettings()
let exchangeRate: ExchangeRateState = loadExchangeRateCache()
let exchangeRatePromise: Promise<ExchangeRateState> | null = null

app.setName('AIUsage Widget')

// Prevent dock icon on macOS
if (process.platform === 'darwin' && app.dock) {
  app.dock.hide()
}

app.whenReady().then(async () => {
  const dbExists = existsSync(DB_PATH)

  if (dbExists) {
    db = new Database(DB_PATH, {
      readonly: true,
      nativeBinding: getWidgetNativeBindingPath(__dirname),
    })
  }

  applyTheme(settings.theme)
  createTray()
  createWindow()
  startAutoRefresh()
  void refreshExchangeRate()

  if (!dbExists) {
    await autoSetup()
  } else if (shouldShowWindowOnLaunch(app.isPackaged)) {
    showWindowWhenTrayReady()
  }
})

app.on('window-all-closed', () => {
  // Keep the app running in the tray — do not quit
})

app.on('before-quit', () => {
  db?.close()
})

function applyTheme(theme: WidgetSettings['theme']): void {
  nativeTheme.themeSource = theme
}

function createTray(): void {
  const { buffer, scaleFactor } = getTrayIconNativeImage()
  const icon = nativeImage.createFromBuffer(buffer, scaleFactor ? { scaleFactor } : undefined)
  tray = new Tray(icon)
  tray.setToolTip('AIUsage Widget')

  tray.on('click', () => toggleWindow())
  tray.on('right-click', () => {
    const i18n = t(settings.locale)
    const menu = Menu.buildFromTemplate([
      { label: i18n.showPanel, click: () => showWindow() },
      { label: i18n.openDashboard, click: () => openDashboardAction() },
      { label: i18n.refresh, click: () => pushDataUpdate() },
      { type: 'separator' },
      { label: i18n.quit, click: () => { app.exit(0) } },
    ])
    tray!.popUpContextMenu(menu)
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const rendererPath = join(__dirname, 'renderer', 'index.html')
  win.loadFile(rendererPath)

  if (shouldHideWindowOnBlur(app.isPackaged)) {
    win.on('blur', () => win?.hide())
  }
}

function showWindow(): void {
  if (!win) return

  positionWindowNearTray()
  win.show()
  win.focus()
  pushDataUpdate()
  schedulePositionRetries()
}

function showWindowWhenTrayReady(attempt = 0): void {
  if (!tray) return

  const trayBounds = tray.getBounds()
  if (hasUsableTrayBounds({
    platform: process.platform,
    trayBounds,
    displayBounds: screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y }).workArea,
  }) || attempt >= 12) {
    showWindow()
    return
  }

  setTimeout(() => showWindowWhenTrayReady(attempt + 1), 80)
}

function positionWindowNearTray(): boolean {
  if (!win || !tray) return false

  const trayBounds = tray!.getBounds()
  const displayBounds = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y }).workArea
  const winBounds = win.getBounds()
  const { x, y } = getWindowPosition({
    platform: process.platform,
    trayBounds,
    windowBounds: winBounds,
    displayBounds,
  })

  win.setPosition(x, y, false)
  return hasUsableTrayBounds({ platform: process.platform, trayBounds, displayBounds })
}

function schedulePositionRetries(): void {
  for (const timer of positionRetryTimers) clearTimeout(timer)
  positionRetryTimers = [80, 200, 500, 1000].map((delay) => setTimeout(() => {
    if (!win?.isVisible()) return
    const positionedWithRealTrayBounds = positionWindowNearTray()
    if (positionedWithRealTrayBounds) {
      for (const timer of positionRetryTimers) clearTimeout(timer)
      positionRetryTimers = []
    }
  }, delay))
}

function toggleWindow(): void {
  if (win?.isVisible()) {
    win.hide()
  } else {
    showWindow()
  }
}

function pushDataUpdate(): void {
  if (!win || !db) return
  try {
    const data = queryWidgetData(db, settings.rangeDays)
    win.webContents.send('widget:data-update', data)
  } catch {
    // DB may not be initialized yet; silently skip
  }
}

function startAutoRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(() => pushDataUpdate(), settings.refreshIntervalSec * 1000)
}

async function openDashboardAction(): Promise<void> {
  const port = getDashboardPort()
  const reachable = await isDashboardReachable(port)
  if (!reachable) {
    showWindow()
    notifyRenderer('install:status', { phase: 'launching' })
    const result = await launchDashboard()
    if (result.success) {
      notifyRenderer('install:status', { phase: 'done' })
    }
    if (!result.success) {
      notifyRenderer('install:status', { phase: 'failed', error: result.error })
      dialog.showErrorBox('Launch Failed', `${result.error ?? 'Dashboard failed to start'}\n\n${CLI_HELP}`)
      return
    }
  }
  shell.openExternal(`http://localhost:${getDashboardPort()}`)
}

function notifyRenderer(channel: string, payload: Record<string, unknown>): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

function loadExchangeRateCache(): ExchangeRateState {
  try {
    if (existsSync(FX_CACHE_FILE)) {
      const raw = JSON.parse(readFileSync(FX_CACHE_FILE, 'utf-8')) as ExchangeRateState
      if (raw.base === 'USD' && raw.target === 'CNY' && typeof raw.rate === 'number') {
        return raw
      }
    }
  } catch {
    // Fall through to empty state
  }

  return {
    base: 'USD',
    target: 'CNY',
    rate: null,
    fetchedAt: null,
    source: EXCHANGE_RATE_SOURCE,
  }
}

function saveExchangeRateCache(rate: ExchangeRateState): void {
  const dir = join(homedir(), '.aiusage')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(FX_CACHE_FILE, JSON.stringify(rate, null, 2), 'utf-8')
}

async function refreshExchangeRate(force = false): Promise<ExchangeRateState> {
  const hasFreshRate = exchangeRate.rate !== null &&
    exchangeRate.fetchedAt !== null &&
    Date.now() - exchangeRate.fetchedAt < FX_CACHE_TTL_MS

  if (!force && hasFreshRate) return exchangeRate
  if (exchangeRatePromise) return exchangeRatePromise

  exchangeRatePromise = (async () => {
    try {
      const { rate, date, source } = await fetchUsdCnyRate()

      exchangeRate = {
        base: 'USD',
        target: 'CNY',
        rate,
        fetchedAt: Date.now(),
        date,
        source,
      }
      saveExchangeRateCache(exchangeRate)
    } catch (error) {
      exchangeRate = {
        ...exchangeRate,
        error: error instanceof Error ? error.message : 'Failed to fetch exchange rate',
        source: EXCHANGE_RATE_SOURCE,
      }
    } finally {
      exchangeRatePromise = null
    }

    return exchangeRate
  })()

  return exchangeRatePromise
}

function runFirstParse(): Promise<{ success: boolean; error?: string }> {
  const { execFile } = nodeRequire('child_process') as typeof import('child_process')
  const entry = resolveCliEntry(__dirname, nodeRequire.resolve)
  if (!entry) return Promise.resolve({ success: false, error: CLI_HELP })
  return new Promise((resolve) => {
    execFile('node', [entry, 'parse'], { timeout: 120_000, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: stderr || err.message })
      } else {
        resolve({ success: true })
      }
    })
  })
}

async function autoSetup(): Promise<void> {
  // Show overlay
  notifyRenderer('setup:status', { phase: 'checking' })
  showWindow()

  // Run first parse
  notifyRenderer('setup:status', { phase: 'parsing' })
  const result = await runFirstParse()
  if (!result.success) {
    notifyRenderer('setup:status', { phase: 'failed', error: result.error })
    return
  }

  // Open database if it now exists
  if (existsSync(DB_PATH)) {
    db = new Database(DB_PATH, {
      readonly: true,
      nativeBinding: getWidgetNativeBindingPath(__dirname),
    })
  }

  notifyRenderer('setup:status', { phase: 'done' })
  pushDataUpdate()
}

// IPC handlers
ipcMain.handle('widget:get-data', () => {
  if (!db) return null
  return queryWidgetData(db, settings.rangeDays)
})

ipcMain.handle('widget:open-dashboard', async () => {
  await openDashboardAction()
})

ipcMain.handle('widget:get-settings', () => {
  return settings
})

ipcMain.handle('widget:get-exchange-rate', async () => {
  return refreshExchangeRate()
})

ipcMain.handle('widget:save-settings', (_event, newSettings: WidgetSettings) => {
  settings = newSettings
  saveSettings(settings)
  applyTheme(settings.theme)
  startAutoRefresh()
  return settings
})

ipcMain.on('widget:hide-window', () => {
  win?.hide()
})

ipcMain.on('widget:resize-window', (_event, height: number) => {
  if (!win || !Number.isFinite(height)) return

  const bounds = win.getBounds()
  const displayBounds = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea
  const nextHeight = Math.min(
    Math.max(Math.ceil(height), MIN_WINDOW_HEIGHT),
    displayBounds.height
  )

  if (Math.abs(bounds.height - nextHeight) < 2) return

  win.setSize(WINDOW_WIDTH, nextHeight, false)
  if (win.isVisible()) {
    positionWindowNearTray()
  }
})

function getDashboardPort(): number {
  try {
    if (existsSync(PORT_FILE)) {
      const port = parseInt(readFileSync(PORT_FILE, 'utf-8').trim(), 10)
      if (!isNaN(port) && port > 0) return port
    }
  } catch {}
  return DASHBOARD_PORT
}

async function isDashboardReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const http = nodeRequire('http') as typeof import('http')
    const req = http.get(`http://localhost:${port}`, (res) => {
      res.destroy()
      resolve(res.statusCode !== undefined && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(200, () => { req.destroy(); resolve(false) })
  })
}

async function launchDashboard(): Promise<{ success: boolean; error?: string }> {
  const { spawn } = nodeRequire('child_process') as typeof import('child_process')
  const entry = resolveCliEntry(__dirname, nodeRequire.resolve)
  if (!entry) return { success: false, error: CLI_HELP }

  return new Promise((resolve) => {
    const child = spawn('node', [entry, 'serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })

    let failed = false

    child.on('error', () => { failed = true })

    child.on('close', (code) => {
      if (code !== 0) failed = true
    })

    child.unref()

    let attempts = 0
    const check = async () => {
      if (failed) {
        resolve({ success: false, error: 'aiusage command not found' })
        return
      }
      if (await isDashboardReachable(getDashboardPort())) {
        resolve({ success: true })
        return
      }
      attempts++
      if (attempts >= 25) {
        resolve({ success: false, error: 'Server failed to start within 5 seconds' })
        return
      }
      setTimeout(check, 200)
    }
    check()
  })
}
