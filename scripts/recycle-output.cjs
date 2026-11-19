const { existsSync, lstatSync, readdirSync, mkdirSync, renameSync } = require('node:fs')
const { resolve, join, relative, isAbsolute, dirname, basename } = require('node:path')
const { randomUUID } = require('node:crypto')

function recycleOutput(workspace, target) {
  const root = resolve(workspace)
  const source = resolve(root, target)
  const inside = relative(root, source)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw Error('Output must be inside workspace')
  // Inspect ancestors and contents before moving any link or directory tree.
  for (let parent = dirname(source); parent !== root; parent = dirname(parent)) {
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
  const destination = join(recycleRoot, `${basename(source)}-${Date.now()}-${randomUUID()}`)
  renameSync(source, destination)
  return destination
}

module.exports = { recycleOutput }
if (require.main === module) {
  const destination = recycleOutput(resolve(__dirname, '..'), process.argv[2])
  if (destination) console.log(`Previous build moved to ${destination}`)
}
