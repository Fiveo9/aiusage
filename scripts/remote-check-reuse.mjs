import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
const [root, attempt] = process.argv.slice(2)
if (!/^\/data\/home\/aiusage-check\/\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(root) || !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(attempt)) throw Error('Invalid reuse path')
const source = join(root, 'source'), incoming = join(root, `incoming-${attempt}`), backup = join(root, `previous-${attempt}`)
const oldManifest = JSON.parse(readFileSync(join(source, 'source-manifest.json')))
const manifest = JSON.parse(readFileSync(join(incoming, 'source-manifest.json')))
const hash = data => createHash('sha256').update(data).digest('hex')
const oldLock = hash(readFileSync(join(source, 'pnpm-lock.yaml')))
if (oldLock !== hash(readFileSync(join(incoming, 'pnpm-lock.yaml')))) throw Error('Lockfile changed; dependency reuse refused')
// Audit all source targets and ancestors before any move or overwrite.
for (const name of new Set([...oldManifest, ...manifest].map(item => item.path).concat('source-manifest.json'))) {
  const file = resolve(source, name)
  if (!file.startsWith(source + '/')) throw Error('Invalid manifest path')
  for (let current = file; current !== source; current = dirname(current)) {
    if (existsSync(current)) { const stat = lstatSync(current); if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw Error('Linked reuse input requires review') }
  }
}
for (const entry of manifest) {
  const file = resolve(incoming, entry.path)
  if (!file.startsWith(incoming + '/') || hash(readFileSync(file)) !== entry.sha256) throw Error('Incoming manifest mismatch')
}
mkdirSync(backup)
for (const name of new Set([...oldManifest, ...manifest].map(item => item.path).concat('source-manifest.json'))) {
  const file = join(source, name)
  if (existsSync(file)) { const target = join(backup, name); mkdirSync(dirname(target), { recursive: true }); renameSync(file, target) }
}
for (const name of manifest.map(item => item.path).concat('source-manifest.json')) {
  const target = join(source, name); mkdirSync(dirname(target), { recursive: true }); renameSync(join(incoming, name), target)
}
// Older successful dependency setup runs predate the ready marker. Accept only
// their explicit successful install/native receipts with the unchanged lockfile.
if (!existsSync(join(root, 'dependencies-ready.json'))) {
  const previous = JSON.parse(readFileSync(join(root, 'results/summary.json')))
  if (!['install', 'sqlite-unpack'].every(name => previous.steps.some(step => step.name === name && step.exitCode === 0))) throw Error('Dependency setup was not completed')
  writeFileSync(join(root, 'dependencies-ready.json'), JSON.stringify({ lockHash: oldLock, node: previous.node }))
}
