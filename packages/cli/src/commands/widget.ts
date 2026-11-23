import { existsSync, readFileSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { join } from 'node:path'
import { AIUSAGE_DIR } from '../config.js'

const WIDGET_PID_PATH = join(AIUSAGE_DIR, 'widget.pid')

export async function launchWidget(): Promise<void> {
  if (isWidgetRunning()) {
    console.log('aiusage widget is already running in the system tray.')
    return
  }

  const electronBin = resolveElectronBin()
  if (!electronBin) {
    console.error(
      'Widget not installed. Run: npm install -g @fiveo9/aiusage-widget'
    )
    process.exit(1)
  }

  const batchShim = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(electronBin)
  const child = spawn(batchShim ? `"${electronBin}"` : electronBin, [], {
    detached: true,
    stdio: 'ignore',
    shell: batchShim,
    windowsHide: true,
  })
  child.on('error', (error) => {
    console.error(`Could not start aiusage widget: ${error.message}`)
    process.exitCode = 1
  })
  child.unref()

  console.log('aiusage widget started.')
}

function isWidgetRunning(): boolean {
  if (!existsSync(WIDGET_PID_PATH)) return false

  let pid: number
  try {
    pid = parseInt(readFileSync(WIDGET_PID_PATH, 'utf-8').trim(), 10)
  } catch {
    return false
  }

  if (isNaN(pid)) return false

  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err.code !== 'ESRCH'
  }
}

export function resolveElectronBin(): string | null {
  try {
    const result = execSync(
      process.platform === 'win32' ? 'where aiusage-widget' : 'command -v aiusage-widget',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim()
    const paths = result.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    return (process.platform === 'win32' ? paths.find(path => /\.(?:exe|cmd|bat)$/i.test(path)) ?? paths[0] : paths[0]) ?? null
  } catch {
    return null
  }
}
