const { existsSync, lstatSync, readdirSync, mkdirSync, renameSync } = require('node:fs')
const { resolve, join, relative, isAbsolute, dirname, basename } = require('node:path')
const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { tmpdir } = require('node:os')
let lastRecycleTime = 0

function moveToBackup(root, source, ownerRoot) {
  // Inspect ancestors and contents before moving any link or directory tree.
  for (let parent = dirname(source); parent !== ownerRoot; parent = dirname(parent)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw Error('Linked output ancestor requires review')
  }
  if (!existsSync(source)) return null
  function inspect(path) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw Error('Linked output requires review')
    if (stat.isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name))
  }
  inspect(source)
  const backupRoot = join(root, 'backups')
  const recycleRoot = join(backupRoot, 'build-recycle')
  for (const path of [root, backupRoot, recycleRoot]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw Error('Linked recycle path requires review')
  }
  mkdirSync(recycleRoot, { recursive: true })
  lastRecycleTime = Math.max(Date.now(), lastRecycleTime + 1)
  const destination = join(recycleRoot, `${basename(source)}-${lastRecycleTime}-${randomUUID()}`)
  renameSync(source, destination)
  pruneRecycle(root)
  return destination
}

function recycleOutput(workspace, target) {
  const root = resolve(workspace), source = resolve(root, target), inside = relative(root, source)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw Error('Output must be inside workspace')
  return moveToBackup(root, source, root)
}

function recycleTemporary(workspace, target, prefix) {
  const root = resolve(workspace), source = resolve(target), temporary = resolve(tmpdir())
  if (dirname(source) !== temporary || !prefix || !basename(source).startsWith(prefix)) throw Error('Unexpected temporary recycle target')
  if (existsSync(temporary) && lstatSync(temporary).isSymbolicLink()) throw Error('Linked temporary root requires review')
  return moveToBackup(root, source, temporary)
}

function pruneRecycle(workspace, options = {}) {
  // Minimal Docker check images have no desktop trash provider; their fresh
  // builder stages are ephemeral and contain no pre-existing output history.
  if (process.env.AIUSAGE_CONTAINER_CHECK === '1') return 0
  const root = resolve(workspace), bin = join(root, 'backups', 'build-recycle')
  if (!existsSync(bin)) return 0
  if (lstatSync(bin).isSymbolicLink()) throw Error('Linked recycle root requires review')
  const positive = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback
  const maxEntries = positive(options.maxEntries ?? process.env.AIUSAGE_RECYCLE_MAX_ENTRIES, 8)
  const maxBytes = positive(options.maxBytes ?? process.env.AIUSAGE_RECYCLE_MAX_BYTES, 512 * 1024 * 1024)
  function bytes(file) {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw Error('Linked recycled output requires review')
    return stat.isDirectory() ? readdirSync(file).reduce((sum, name) => sum + bytes(join(file, name)), 0) : stat.size
  }
  const entries = readdirSync(bin).filter(name => /-\d{13}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(name))
    .map(name => { const file = resolve(bin, name); if (dirname(file) !== bin) throw Error('Recycle child escaped root'); return { file, size: bytes(file), time: Number(/-(\d{13})-[a-f0-9-]+$/.exec(name)[1]) } })
    .sort((a, b) => b.time - a.time)
  let total = entries.reduce((sum, entry) => sum + entry.size, 0), moved = 0
  const trash = options.trash || (file => {
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'move-to-recycle-bin.ps1'), '-LiteralPath', file, '-AllowedRoot', bin], { stdio: 'pipe', windowsHide: true })
    } else {
      execFileSync('gio', ['trash', '--', file], { stdio: 'pipe' })
    }
  })
  while (entries.length > 1 && (entries.length > maxEntries || total > maxBytes)) {
    const oldest = entries.pop()
    // No physical-delete fallback when the OS trash provider is unavailable.
    trash(oldest.file)
    if (existsSync(oldest.file)) throw Error('OS trash move did not complete; output retained')
    total -= oldest.size; moved++
  }
  if (moved) console.log(`Older build outputs moved to OS recycle bin: ${moved}`)
  return moved
}

module.exports = { recycleOutput, recycleTemporary, pruneRecycle }
if (require.main === module) {
  const destination = recycleOutput(resolve(__dirname, '..'), process.argv[2])
  if (destination) console.log(`Previous build moved to ${destination}`)
}
