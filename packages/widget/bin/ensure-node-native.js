#!/usr/bin/env node
const { dirname } = require('node:path')
const { execFileSync } = require('node:child_process')

function available() {
  try {
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.close()
    return true
  } catch { return false }
}

if (!available()) {
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw Error('Run the Node native check through pnpm or npm')
  execFileSync(process.execPath, [npmCli, 'run', 'install'], {
    cwd: dirname(require.resolve('better-sqlite3/package.json')), stdio: 'pipe', windowsHide: true,
  })
  if (!available()) throw Error('Node native binding remains unavailable after rebuild')
} else console.log('Node native binding already loads; rebuild skipped')
