// Verification-only preparation, replacing dependency lifecycle compilation.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const require = createRequire('/app/packages/cli/package.json')
const manifest = require.resolve('better-sqlite3/package.json')
const root = dirname(realpathSync(manifest))
if (!root.startsWith('/app/node_modules/')) throw Error('Native dependency outside container workspace')
const version = JSON.parse(readFileSync(manifest)).version
const name = `better-sqlite3-v${version}-node-v${process.versions.modules}-${process.platform}-${process.arch}.tar.gz`
const stage = '/app/.native-check'
mkdirSync(stage)
const response = await fetch(`https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${name}`)
if (!response.ok) throw Error(`Native prebuild unavailable: HTTP ${response.status}`)
const bytes = Buffer.from(await response.arrayBuffer())
const archive = join(stage, name)
writeFileSync(archive, bytes)
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
const details = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n')
if (entries.some(name => !name.startsWith('build/') || /(^|\/)\.\.(\/|$)|\\|:/.test(name)) || details.some(line => !/^[-d]/.test(line))) throw Error('Unsafe prebuild archive')
execFileSync('tar', ['-xzf', archive, '-C', stage])
mkdirSync(join(root, 'build/Release'), { recursive: true })
copyFileSync(join(stage, 'build/Release/better_sqlite3.node'), join(root, 'build/Release/better_sqlite3.node'))
console.log(`Prepared SQLite ABI ${process.versions.modules}; archive SHA256 ${createHash('sha256').update(bytes).digest('hex')}`)
