#!/usr/bin/env node
const { copyFileSync, mkdirSync, statSync, lstatSync, existsSync, readFileSync, writeFileSync, renameSync } = require('node:fs')
const { dirname, join } = require('node:path')
const { execFileSync } = require('node:child_process')
const { rebuild } = require('@electron/rebuild')
const { recycleStaleDist } = require('./stale-dist.js')

const widgetRoot = join(__dirname, '..')
const nativeSource = join(
  dirname(require.resolve('better-sqlite3/package.json')),
  'build',
  'Release',
  'better_sqlite3.node'
)
const nativeDir = join(widgetRoot, 'dist', 'native')
const nativeTarget = join(nativeDir, 'better_sqlite3.node')
const marker = nativeTarget + '.cache.json'
function fingerprint() {
  const stamp = file => { const s = statSync(file); return { size: s.size, mtimeMs: s.mtimeMs } }
  return { version: 1, electron: require('electron/package.json').version,
    sqlite: require('better-sqlite3/package.json').version,
    nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch,
    source: stamp(nativeSource), target: stamp(nativeTarget) }
}
function saveMarker() {
  if (existsSync(marker) && (lstatSync(marker).isSymbolicLink() || lstatSync(marker).nlink > 1)) throw Error('Linked native cache marker requires review')
  const temporary = marker + '.tmp'
  if (existsSync(temporary)) throw Error('Native cache temporary file already exists; recovery required')
  writeFileSync(temporary, JSON.stringify(fingerprint()) + '\n')
  renameSync(temporary, marker)
}

function isTargetFresh() {
  try {
    if (!existsSync(nativeTarget) || !existsSync(nativeSource)) return false
    if (existsSync(marker)) return JSON.stringify(JSON.parse(readFileSync(marker, 'utf8'))) === JSON.stringify(fingerprint())
    const srcTime = statSync(nativeSource).mtimeMs
    const dstTime = statSync(nativeTarget).mtimeMs
    return dstTime >= srcTime
  } catch {
    return false
  }
}

async function main() {
  if (existsSync(marker) && (lstatSync(marker).isSymbolicLink() || lstatSync(marker).nlink > 1)) throw Error('Linked native cache marker requires review')
  const recycled = recycleStaleDist(widgetRoot)
  if (recycled) console.log(`Stale widget JavaScript outputs recycled: ${recycled}`)
  if (isTargetFresh() && !process.argv.includes('--force')) {
    if (!existsSync(marker)) saveMarker()
    console.log('Native binding is up to date, skipping rebuild (use --force to override)')
    return
  }

  const electronVersion = require('electron/package.json').version
  // Validate the restore entry before a rebuild can change the shared Node ABI.
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error('Run prepare:native through pnpm or npm')

  try {
    await rebuild({
    buildPath: widgetRoot,
    electronVersion,
    onlyModules: ['better-sqlite3'],
    force: true,
    })

  mkdirSync(nativeDir, { recursive: true })
  copyFileSync(nativeSource, nativeTarget)

  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--force', '--sign', '-', nativeTarget], { stdio: 'inherit' })
  }

  } finally {
    // Always restore Node even if Electron compilation/copy/signing fails.
    execFileSync(process.execPath, [npmCli, 'run', 'install'], {
    cwd: dirname(require.resolve('better-sqlite3/package.json')),
    stdio: 'pipe',
    windowsHide: true,
    })
  }
  // Capture the source AFTER Node restoration, not before its mtime changes.
  saveMarker()
}

module.exports = { main, isTargetFresh, fingerprint, saveMarker }
if (require.main === module) main().catch((error) => {
  console.error(error)
  process.exit(1)
})
