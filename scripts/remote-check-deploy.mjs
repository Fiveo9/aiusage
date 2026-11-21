import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

const root = process.env.AIUSAGE_CHECK_ROOT
const attempt = process.env.AIUSAGE_CHECK_ATTEMPT
if (!root || !/^\/data\/home\/aiusage-check\/\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(root)
    || (attempt && !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(attempt))) throw Error('Invalid package run directory')
const source = join(root, 'source')
const results = attempt ? join(root, 'attempts', attempt) : join(root, 'results')
const stage = join(results, 'aiusage')
const resultFile = join(results, 'package-result.json')
const result = { status: 'running', assertions: [], artifact: null }
const check = (name, condition) => { assert.ok(condition, name); result.assertions.push(name) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
let child
try {
  check('Linux x64 with Node 22', process.platform === 'linux' && process.arch === 'x64' && process.versions.node.split('.')[0] === '22')
  const cliRoot = join(source, 'packages/cli')
  const pkg = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8'))
  check('Expected CLI package', pkg.name === '@fiveo9/aiusage' && /^\d+\.\d+\.\d+$/.test(pkg.version))
  mkdirSync(stage)
  const { devDependencies, scripts, ...runtimePackage } = pkg
  writeFileSync(join(stage, 'package.json'), JSON.stringify(runtimePackage, null, 2))
  cpSync(join(cliRoot, 'dist'), join(stage, 'dist'), { recursive: true, dereference: false })
  copyFileSync(join(cliRoot, 'README.md'), join(stage, 'README.md'))
  const packages = new Map()
  const omittedOptional = []
  function installedPackage(from, name) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw Error('Invalid dependency name')
    const require = createRequire(join(from, 'package.json'))
    // e.g. the npm "buffer" package also names a Node builtin; requesting its
    // package.json search paths avoids treating that dependency as a builtin.
    for (const search of require.resolve.paths(`${name}/package.json`) || []) {
      const candidate = join(search, name)
      if (existsSync(join(candidate, 'package.json'))) {
        const resolved = realpathSync(candidate)
        if (!resolved.startsWith(source + '/node_modules/')) throw Error('Production dependency leaves isolated install')
        return resolved
      }
    }
    return null
  }
  function copyDependencies(from, destination, metadata) {
    const dependencies = { ...metadata.peerDependencies, ...metadata.dependencies, ...metadata.optionalDependencies }
    for (const name of Object.keys(dependencies)) {
      const installed = installedPackage(from, name)
      if (!installed) {
        if (metadata.optionalDependencies?.[name] || metadata.peerDependenciesMeta?.[name]?.optional) {
          omittedOptional.push(`${metadata.name}:${name}`); continue
        }
        throw Error(`Missing installed production dependency: ${name}`)
      }
      let copied = packages.get(installed)
      if (!copied) {
        copied = join(stage, 'node_modules/.store', String(packages.size))
        packages.set(installed, copied)
        cpSync(installed, copied, { recursive: true, dereference: false, filter: file => {
          if (file !== installed && file.slice(installed.length + 1).split('/').includes('node_modules')) return false
          if (lstatSync(file).isSymbolicLink()) throw Error('Internal dependency link needs explicit handling')
          return true
        } })
        copyDependencies(installed, copied, JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')))
      }
      const link = join(destination, 'node_modules', name)
      mkdirSync(dirname(link), { recursive: true })
      // Both endpoints are newly created inside this package. The relative
      // link is audited again before packaging and remains valid after relocation.
      if (!copied.startsWith(stage + '/') || !link.startsWith(stage + '/') || existsSync(link)) throw Error('Invalid dependency link target')
      symlinkSync(relative(dirname(link), copied), link, 'dir')
    }
  }
  copyDependencies(cliRoot, stage, pkg)
  check('Installed production dependency graph copied', packages.size > 0)
  check('Compiled CLI and dashboard present', existsSync(join(stage, 'dist/index.js')) && existsSync(join(stage, 'dist/web/index.html')))

  // Only relative, internal production dependency links may enter the archive.
  const inspected = new Set()
  function audit(file) {
    if (lstatSync(file).isSymbolicLink() && isAbsolute(readlinkSync(file))) throw Error('Absolute deployment link')
    const resolved = realpathSync(file)
    if (resolved !== stage && !resolved.startsWith(stage + '/')) throw Error('Deployment link leaves package')
    if (inspected.has(resolved)) return
    inspected.add(resolved)
    const info = statSync(file)
    if (info.isDirectory()) {
      for (const name of readdirSync(file)) {
        if (name === '.git' || name.startsWith('.env') || /^(?:credentials?\.(?:json|ini|ya?ml)|id_rsa|id_ed25519)$/i.test(name)) {
          throw Error(`Disallowed deployment file: ${relative(stage, join(file, name))}`)
        }
        audit(join(file, name))
      }
    } else if (!info.isFile()) throw Error('Unsupported package entry')
  }
  audit(stage)

  // No install scripts are executed. Reuse the validated matching Node ABI
  // binary from dependency preparation, copying only after resolved-path audit.
  const targetRequire = createRequire(join(stage, 'package.json'))
  const sourceRequire = createRequire(join(source, 'packages/cli/package.json'))
  const sqliteRoot = dirname(targetRequire.resolve('better-sqlite3/package.json'))
  const sourceSqlite = dirname(sourceRequire.resolve('better-sqlite3/package.json'))
  check('SQLite destination stays in package', realpathSync(sqliteRoot).startsWith(stage + '/node_modules/'))
  check('SQLite source stays in isolated dependencies', realpathSync(sourceSqlite).startsWith(source + '/node_modules/'))
  mkdirSync(join(sqliteRoot, 'build/Release'), { recursive: true })
  const nativeTarget = join(sqliteRoot, 'build/Release/better_sqlite3.node')
  if (existsSync(nativeTarget)) {
    const info = lstatSync(nativeTarget)
    check('Native overwrite is not a link', info.isFile() && !info.isSymbolicLink() && info.nlink === 1)
  }
  copyFileSync(join(sourceSqlite, 'build/Release/better_sqlite3.node'), nativeTarget)
  copyFileSync(join(source, 'LICENSE'), join(stage, 'LICENSE'))
  copyFileSync(join(source, 'README_zh.md'), join(stage, 'README_zh.md'))

  const glibc = process.report.getReport().header.glibcVersionRuntime
  check('glibc runtime detected', typeof glibc === 'string')
  const buildInfo = { package: pkg.name, version: pkg.version, builtAt: new Date().toISOString(),
    runId: attempt || root.split('/').pop(), platform: 'linux', architecture: 'x64',
    node: process.version, nodeAbi: process.versions.modules, testedGlibc: glibc,
    sourceManifestSha256: hash(readFileSync(join(source, 'source-manifest.json'))),
    lockfileSha256: hash(readFileSync(join(source, 'pnpm-lock.yaml'))), sqliteSha256: hash(readFileSync(nativeTarget)),
    productionPackages: packages.size, omittedOptional }
  writeFileSync(join(stage, 'BUILD-INFO.json'), JSON.stringify(buildInfo, null, 2), { flag: 'wx' })
  writeFileSync(join(stage, 'start.sh'), '#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\nnode -e \'if(process.platform!=="linux" || process.arch!=="x64" || process.versions.modules!=="127") { console.error("Requires Linux x86_64 and Node.js 22 (ABI 127)"); process.exit(1) }\'\nexec node dist/index.js serve "$@"\n', { flag: 'wx', mode: 0o755 })
  writeFileSync(join(stage, 'DEPLOY.md'), `# AIUsage Linux 部署包\n\n包含 CLI、Web 仪表盘、生产依赖和 SQLite 原生绑定；不包含 Node.js、Electron 小组件或独立账号站点。\n\n环境：Linux x86_64、Node.js 22（ABI 127）、glibc；在 glibc ${glibc} 上验证。建议使用相同或更新 glibc，Alpine/musl 和 ARM 不适用。无需 pnpm 或 npm install。\n\n解压后运行：\n\n\`\`\`sh\ncd aiusage\n./start.sh --host 127.0.0.1 --port 3847\n\`\`\`\n\n浏览器访问 http://127.0.0.1:3847。监听网络地址时，先在环境或服务管理器中设置 AIUSAGE_DASHBOARD_PASSWORD，再使用 --host 0.0.0.0；勿在命令参数中放入密码。可通过反向代理提供 TLS。\n\n数据位于运行用户的 ~/.aiusage；保持同一运行用户，升级前备份该目录。包目录可整体放到新版本目录，停止旧进程后切换启动位置。Ctrl+C 或 SIGTERM 正常停止。\n\n其他命令：node dist/index.js --help；node dist/index.js status。源日志需在目标机器可读，远程构建机没有携带你的用量或配置。可选 GitHub 同步需要 Git，可选系统钥匙串需要目标机提供 Secret Service。\n\n构建信息见 BUILD-INFO.json，许可见 LICENSE。\n`, { flag: 'wx' })

  // Package only the audited tree. Relative links point to its own .store;
  // extraction does not depend on pnpm or the original workspace.
  inspected.clear()
  audit(stage)
  const name = `aiusage-${pkg.version}-linux-x64-node22-${attempt || root.split('/').pop()}.tar.gz`
  const archive = join(results, name)
  execFileSync('tar', ['--hard-dereference', '-czf', archive, '-C', results, 'aiusage'], { stdio: 'pipe' })
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split('\n')
  const details = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split('\n')
  check('Archive contains safe files and audited internal links', entries.every(name => name.startsWith('aiusage/') && !/(^|\/)\.\.(\/|$)|\\|:/.test(name)) && details.every(line => /^[-dl]/.test(line)))
  const extracted = join(results, 'package-smoke')
  mkdirSync(extracted)
  execFileSync('tar', ['-xzf', archive, '-C', extracted])
  const app = join(extracted, 'aiusage')
  const appRequire = createRequire(join(app, 'package.json'))
  const Database = appRequire('better-sqlite3')
  const db = new Database(':memory:')
  try { check('Extracted SQLite binding executes SQL', db.prepare('SELECT 1 AS n').get().n === 1) } finally { db.close() }
  check('Extracted CLI version', execFileSync(process.execPath, ['dist/index.js', '--version'], { cwd: app, encoding: 'utf8' }).trim() === pkg.version)

  const smokeHome = join(results, 'package-home')
  mkdirSync(join(smokeHome, '.aiusage'), { recursive: true })
  writeFileSync(join(smokeHome, '.aiusage/config.json'), JSON.stringify({ exchangeRate: 0.137, refreshInterval: 0, retentionDays: 0, syncInterval: 0, leaderboardAutoUpload: false }))
  const probe = createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  let output = ''
  child = spawn('./start.sh', ['--host', '127.0.0.1', '--port', String(port)], {
    cwd: app, env: { PATH: process.env.PATH, HOME: smokeHome, TMPDIR: process.env.TMPDIR,
      AIUSAGE_CHECK_ROOT: root, NODE_OPTIONS: process.env.NODE_OPTIONS }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stopped = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
  child.stdout.on('data', data => { output += data.toString() })
  child.stderr.on('data', data => { output += data.toString() })
  const endpoint = `http://127.0.0.1:${port}`
  let ready = false
  for (let i = 0; i < 100 && child.exitCode === null; i++) {
    try { const response = await fetch(endpoint, { signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break } } catch {}
    await delay(200)
  }
  check('Extracted start.sh starts dashboard', ready)
  const html = await (await fetch(endpoint)).text()
  check('Dashboard references bundled JavaScript', html.includes('_app/immutable/'))
  const asset = html.match(/(?:\.\/|\/)?(_app\/immutable\/[^"'\s]+\.js)/)?.[1]
  check('Bundled JavaScript served', asset && (await fetch(`${endpoint}/${asset}`)).ok)
  const sessions = await (await fetch(`${endpoint}/api/sessions?range=all&q=synthetic&sort=cost`)).json()
  check('Session search API available', sessions.total === 0 && Array.isArray(sessions.sessions))
  const cost = await (await fetch(`${endpoint}/api/cost?range=all`)).json()
  check('Cost provenance API available', cost.provenance.totalRecords === 0 && cost.provenance.coverage === null)
  child.kill('SIGTERM')
  const exit = await Promise.race([stopped, delay(10000).then(() => { throw Error('Package smoke did not exit') })])
  check('Graceful shutdown', exit.code === 0)
  child = null
  writeFileSync(join(results, 'package-smoke.log'), output)
  result.artifact = { name, bytes: statSync(archive).size, sha256: hash(readFileSync(archive)), platform: 'linux-x64', node: '22', glibc }
  result.status = 'passed'
} catch (error) {
  result.status = 'failed'; result.message = error.message; process.exitCode = 1
  console.error(error.message)
} finally {
  if (child && child.exitCode === null) child.kill('SIGTERM')
  writeFileSync(resultFile, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
}
