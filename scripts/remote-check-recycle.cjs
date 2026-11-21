// Preloaded only in an isolated remote-check run. Replace JS filesystem deletion
// with recoverable renames; never touch data outside this run.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { syncBuiltinESMExports } = require('node:module')
const { randomUUID } = require('node:crypto')
const root = path.resolve(process.env.AIUSAGE_CHECK_ROOT || '')
if (!/^\/data\/home\/aiusage-check\/\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(root)) throw Error('Missing isolated remote-check root')
const recycleDir = path.join(root, 'recycle')
fs.mkdirSync(recycleDir, { recursive: true })
const linkAudit = path.join(root, 'created-hardlinks.jsonl')
const originalLink = fs.linkSync
fs.linkSync = (from, to) => {
  for (const input of [from, to]) {
    const candidate = path.resolve(String(input))
    if (!candidate.startsWith(root + '/')) throw Error('Hard link outside isolated run refused')
    for (let parent = path.dirname(candidate); parent !== root; parent = path.dirname(parent)) {
      if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw Error('Linked hard-link ancestor requires review')
    }
  }
  const original = fs.lstatSync(from)
  if (!original.isFile() || original.isSymbolicLink()) throw Error('Invalid hard-link source')
  originalLink(from, to)
  fs.appendFileSync(linkAudit, JSON.stringify({ dev: original.dev, ino: original.ino, from: String(from), to: String(to) }) + '\n')
}
function recycle(input) {
  const source = path.resolve(input instanceof URL ? fileURLToPath(input) : String(input))
  const rel = path.relative(root, source)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || source === recycleDir || source.startsWith(recycleDir + '/')) {
    throw Error('Cleanup outside isolated remote-check run was refused')
  }
  // Linked package contents are not followed or modified; abort pending review.
  for (let parent = path.dirname(source); parent !== root; parent = path.dirname(parent)) {
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw Error('Linked cleanup ancestor requires review')
  }
  let stat
  try { stat = fs.lstatSync(source) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  function inspect(file, info) {
    if (info.isSymbolicLink()) throw Error('Linked cleanup target requires review')
    if (info.isFile() && info.nlink > 1) {
      const created = fs.existsSync(linkAudit) && fs.readFileSync(linkAudit, 'utf8').trim().split('\n').some(line => {
        try { const entry = JSON.parse(line); return entry.dev === info.dev && entry.ino === info.ino } catch { return false }
      })
      if (!created) throw Error('Unregistered hard link requires review')
      fs.appendFileSync(path.join(root, 'recycle.jsonl'), JSON.stringify({ linked: path.relative(root, file), nlink: info.nlink }) + '\n')
    }
    if (info.isDirectory()) for (const child of fs.readdirSync(file)) {
      const entry = path.join(file, child); inspect(entry, fs.lstatSync(entry))
    }
  }
  inspect(source, stat)
  const destination = path.join(recycleDir, `${Date.now()}-${randomUUID()}`)
  fs.renameSync(source, destination)
  fs.appendFileSync(path.join(root, 'recycle.jsonl'), JSON.stringify({ source: rel, destination: path.relative(root, destination) }) + '\n')
}
for (const name of ['rmSync', 'unlinkSync', 'rmdirSync']) fs[name] = recycle
for (const name of ['rm', 'unlink', 'rmdir']) {
  fs[name] = (...args) => {
    const callback = args[args.length - 1]
    try { recycle(args[0]); callback(null) } catch (error) { callback(error) }
  }
  fsp[name] = async input => recycle(input)
}
syncBuiltinESMExports()
