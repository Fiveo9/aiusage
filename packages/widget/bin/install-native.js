#!/usr/bin/env node
/**
 * postinstall: produce a better-sqlite3 native binding that matches BOTH the
 * end user's platform/arch AND Electron's ABI, and place it at
 * dist/native/better_sqlite3.node (where main.ts loads it via `nativeBinding`).
 *
 * Why this exists:
 *  - Electron embeds its own Node, so a binding compiled for the system Node
 *    ABI fails to load inside Electron, and vice versa.
 *  - The published package cannot ship a single prebuilt binary, because that
 *    binary is locked to the platform/arch of the machine that built it
 *    (the CI runner). On any other OS/arch it is unloadable.
 *
 * Strategy: download the prebuilt better-sqlite3 binary for `electron` runtime
 * matching the locally installed Electron version, this platform, and this
 * arch. We run prebuild-install inside a throwaway copy of better-sqlite3's
 * package.json so we never clobber the shared better-sqlite3 build/Release
 * (the CLI package relies on its Node-ABI binding in a pnpm workspace).
 *
 * Best-effort: a failure here (e.g. offline install, or no prebuilt for an
 * exotic platform) prints a warning but does not fail `npm install`; any
 * binary shipped in dist/native remains as a last-resort fallback.
 */
const { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { dirname, join } = require('node:path')
const { execFileSync } = require('node:child_process')
const { tmpdir } = require('node:os')

const widgetRoot = join(__dirname, '..')

function warn(message) {
  console.warn(`[aiusage-widget] ${message}`)
  console.warn('[aiusage-widget] the tray widget may fail to open the usage database until this is resolved.')
}

function resolveElectronVersion() {
  try {
    return require('electron/package.json').version
  } catch {
    return null
  }
}

function main() {
  const electronVersion = resolveElectronVersion()
  if (!electronVersion) {
    warn('could not resolve the installed electron version; skipping native binding setup.')
    return
  }

  let betterSqlite3Pkg
  try {
    betterSqlite3Pkg = require.resolve('better-sqlite3/package.json')
  } catch {
    warn('could not locate better-sqlite3; skipping native binding setup.')
    return
  }
  const betterSqlite3Dir = dirname(betterSqlite3Pkg)

  let prebuildInstallBin
  try {
    prebuildInstallBin = require.resolve('prebuild-install/bin.js', { paths: [betterSqlite3Dir] })
  } catch {
    warn('could not locate prebuild-install; skipping native binding setup.')
    return
  }

  // Run prebuild-install against a disposable copy of better-sqlite3's
  // package.json so the shared install (used by the Node-side CLI) is untouched.
  const stageDir = join(tmpdir(), `aiusage-widget-native-${process.pid}`)
  try {
    mkdirSync(stageDir, { recursive: true })
    writeFileSync(join(stageDir, 'package.json'), readFileSync(betterSqlite3Pkg))

    execFileSync(
      process.execPath,
      [
        prebuildInstallBin,
        '--runtime=electron',
        `--target=${electronVersion}`,
        `--arch=${process.arch}`,
        `--platform=${process.platform}`,
      ],
      { cwd: stageDir, stdio: 'inherit' },
    )

    const built = join(stageDir, 'build', 'Release', 'better_sqlite3.node')
    if (!existsSync(built)) {
      warn('prebuild-install completed but produced no binary; skipping native binding setup.')
      return
    }

    const nativeDir = join(widgetRoot, 'dist', 'native')
    mkdirSync(nativeDir, { recursive: true })
    const target = join(nativeDir, 'better_sqlite3.node')
    copyFileSync(built, target)

    if (process.platform === 'darwin') {
      // Ad-hoc sign so Gatekeeper / hardened runtime will load the binding.
      try {
        execFileSync('codesign', ['--force', '--sign', '-', target], { stdio: 'inherit' })
      } catch {
        // Non-fatal: unsigned binaries still load in most local setups.
      }
    }

    console.log(
      `[aiusage-widget] installed better-sqlite3 binding for electron ${electronVersion} (${process.platform}-${process.arch}).`,
    )
  } catch (error) {
    warn(`failed to set up the native binding: ${error && error.message ? error.message : error}`)
  } finally {
    try {
      rmSync(stageDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup failures
    }
  }
}

main()
