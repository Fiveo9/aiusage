import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = process.env.AIUSAGE_CHECK_ROOT
if (!root || !/^\/data\/home\/aiusage-check\/\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(root)) throw Error('Invalid remote run root')
const source = join(root, 'source')
const attempt = process.env.AIUSAGE_CHECK_ATTEMPT
if (attempt && !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(attempt)) throw Error('Invalid attempt ID')
const results = attempt ? join(root, 'attempts', attempt) : join(root, 'results')
const [task, scope] = process.argv.slice(2)
if (!['test', 'build'].includes(task) || !['review', 'full', 'postgres', 'docker'].includes(scope)) throw Error('Invalid task/scope')
mkdirSync(results, { recursive: true })
const summary = { task, scope, status: 'running', category: 'source-integrity', exitCode: null, steps: [], tests: { passed: 0, failed: 0, skipped: 0, total: 0 }, node: process.version }
const save = () => writeFileSync(join(results, 'summary.json'), JSON.stringify(summary, null, 2))
const baseEnv = { ...process.env, CI: '1', PNPM_HOME: join(root, 'tools'), npm_config_cache: join(root, 'npm-cache'),
  npm_config_store_dir: join(root, 'pnpm-store'), NODE_OPTIONS: `--require ${join(source, 'scripts/remote-check-recycle.cjs')}` }
const pnpm = join(root, 'tools/pnpm/package/bin/pnpm.cjs')

async function step(name, command, args, category, cwd = source) {
  summary.category = category
  const record = { name, command: [command, ...args], status: 'running', exitCode: null }
  summary.steps.push(record); save()
  console.log(`[start] ${name}`)
  const log = createWriteStream(join(results, `${name}.log`), { flags: 'wx' })
  const child = spawn(command, args, { cwd, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let tail = ''
  for (const output of [child.stdout, child.stderr]) output.on('data', chunk => { log.write(chunk); tail = (tail + chunk.toString()).slice(-3000) })
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  await new Promise(resolve => log.end(resolve))
  record.exitCode = code; record.status = code === 0 ? 'passed' : 'failed'; save()
  console.log(`[end] ${name}: exit ${code}`)
  if (code !== 0) { console.log(tail); throw Error(`${name} failed`) }
}
async function pnpmStep(name, args, category, cwd) { await step(name, process.execPath, [pnpm, ...args], category, cwd) }
function auditArchive(archive, prefix) {
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
  const details = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n')
  if (entries.some(name => !name.startsWith(prefix) || /(^|\/)\.\.(\/|$)|\\|:/.test(name))
      || details.some(line => !/^[-d]/.test(line))) throw Error('Unsafe downloaded archive: path or link requires review')
}
async function tests(pkg, files) {
  const report = join(results, `${pkg}-tests.json`)
  const config = pkg === 'cli' && scope !== 'full' ? ['--config', 'vitest.review.config.ts'] : []
  let failure
  try {
    await pnpmStep(`${pkg}-tests`, ['--dir', `packages/${pkg}`, 'exec', 'vitest', 'run', ...config, ...files,
      '--minWorkers=1', '--maxWorkers=2', '--reporter=default', '--reporter=json', `--outputFile=${report}`], 'unit-test')
  } catch (error) { failure = error }
  if (!existsSync(report)) throw failure || Error(`Missing ${pkg} test report`)
  const result = JSON.parse(readFileSync(report, 'utf8'))
  summary.tests.total += result.numTotalTests
  summary.tests.passed += result.numPassedTests
  summary.tests.failed += result.numFailedTests
  summary.tests.skipped += result.numPendingTests + (result.numTodoTests || 0)
  save()
  if (failure) throw failure
  if (!Number.isInteger(result.numTotalTests) || !result.numTotalTests || !result.success) throw Error(`Incomplete ${pkg} test report`)
}

try {
  const manifest = JSON.parse(readFileSync(join(source, 'source-manifest.json'), 'utf8'))
  for (const entry of manifest) {
    const file = resolve(source, entry.path)
    if (!file.startsWith(source + '/') || createHash('sha256').update(readFileSync(file)).digest('hex') !== entry.sha256) throw Error('Source manifest mismatch')
  }
  summary.sourceFilesVerified = manifest.length; save()
  const lockHash = createHash('sha256').update(readFileSync(join(source, 'pnpm-lock.yaml'))).digest('hex')
  const readyFile = join(root, 'dependencies-ready.json')
  const reuse = process.env.AIUSAGE_CHECK_REUSE === '1'
  if (reuse) {
    const ready = JSON.parse(readFileSync(readyFile, 'utf8'))
    if (ready.lockHash !== lockHash || ready.node !== process.version) throw Error('Dependency reuse requires identical lockfile and Node version')
    summary.dependenciesReused = true
  } else {
  summary.category = 'dependency-setup'; save()
  // Isolated pnpm download is pinned to the repository packageManager version.
  const response = await fetch('https://registry.npmjs.org/pnpm/-/pnpm-9.15.0.tgz')
  if (!response.ok) throw Error(`pnpm download failed: HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  if (createHash('sha512').update(archive).digest('base64') !== 'duI3l2CkMo7EQVgVvNZije5yevN3mqpMkU45RBVsQpmSGon5djge4QfUHxLPpLZmgcqccY8GaPoIMe1MbYulbA==') throw Error('pnpm integrity mismatch')
  mkdirSync(join(root, 'tools/pnpm'), { recursive: true })
  writeFileSync(join(root, 'tools/pnpm.tgz'), archive, { flag: 'wx' })
  auditArchive(join(root, 'tools/pnpm.tgz'), 'package/')
  await step('pnpm-unpack', 'tar', ['-xzf', join(root, 'tools/pnpm.tgz'), '-C', join(root, 'tools/pnpm')], 'dependency-setup')
  await pnpmStep('install', ['install', '--frozen-lockfile', '--ignore-scripts', '--package-import-method=copy', '--store-dir', join(root, 'pnpm-store')], 'dependency-setup')
  // Native dependency lifecycle is deliberately not run: obtain a matching
  // official prebuild in an isolated staging directory, leaving the install intact.
  const sqliteVersion = JSON.parse(readFileSync(join(source, 'packages/cli/node_modules/better-sqlite3/package.json'))).version
  const nativeName = `better-sqlite3-v${sqliteVersion}-node-v${process.versions.modules}-${process.platform}-${process.arch}.tar.gz`
  const nativeResponse = await fetch(`https://github.com/WiseLibs/better-sqlite3/releases/download/v${sqliteVersion}/${nativeName}`)
  if (!nativeResponse.ok) throw Error(`SQLite native download failed: HTTP ${nativeResponse.status}`)
  const nativeArchive = join(root, 'tools', nativeName)
  const nativeBytes = Buffer.from(await nativeResponse.arrayBuffer())
  writeFileSync(nativeArchive, nativeBytes, { flag: 'wx' })
  summary.nativeArchiveSha256 = createHash('sha256').update(nativeBytes).digest('hex')
  auditArchive(nativeArchive, 'build/')
  const nativeRoot = join(root, 'tools/sqlite-native')
  mkdirSync(nativeRoot)
  await step('sqlite-unpack', 'tar', ['-xzf', nativeArchive, '-C', nativeRoot], 'dependency-setup')
  // Copy rather than rebuild the shared dependency. Its symlink is read-only;
  // the destination is the resolved, run-owned package directory.
  const { realpathSync, copyFileSync } = await import('node:fs')
  const sqliteRoot = realpathSync(join(source, 'packages/cli/node_modules/better-sqlite3'))
  if (!sqliteRoot.startsWith(source + '/node_modules/')) throw Error('SQLite package resolved outside run')
  mkdirSync(join(sqliteRoot, 'build/Release'), { recursive: true })
  copyFileSync(join(nativeRoot, 'build/Release/better_sqlite3.node'), join(sqliteRoot, 'build/Release/better_sqlite3.node'))
  writeFileSync(readyFile, JSON.stringify({ lockHash, node: process.version }))
  }
  await pnpmStep('core-build', ['--dir', 'packages/core', 'run', 'build'], 'remote-build')
  if (scope === 'postgres') {
    summary.evidenceFiles = ['postgres-result.json']; save()
    await step('postgres-concurrency', process.execPath, ['scripts/remote-check-postgres.mjs'], 'postgres-integration')
    const pgResult = JSON.parse(readFileSync(join(results, 'postgres-result.json'), 'utf8'))
    if (pgResult.status !== 'passed' || !pgResult.stopped) throw Error('PostgreSQL acceptance incomplete')
    summary.integrationAssertions = pgResult.assertions
  } else if (scope === 'docker') {
    try {
      await step('docker-acceptance', process.execPath, ['scripts/remote-check-docker.mjs'], 'container-integration')
      const result = JSON.parse(readFileSync(join(results, 'docker-result.json'), 'utf8'))
      if (result.status !== 'passed' || !result.stopped) throw Error('Container acceptance incomplete')
      summary.integrationAssertions = result.assertions
    } finally {
      summary.evidenceFiles = ['docker-result.json', 'docker-cli-build.log', 'docker-site-build.log', 'docker-cli-runtime.log', 'docker-site-runtime.log', 'docker-pg-runtime.log'].filter(file => existsSync(join(results, file)))
      save()
    }
  } else if (task === 'test') {
    if (scope === 'full') {
      const failedPackages = []
      for (const pkg of ['core', 'cli', 'widget', 'site', 'web']) {
        try {
          if (pkg === 'site') await pnpmStep('site-sync', ['--dir', 'packages/site', 'exec', 'svelte-kit', 'sync'], 'remote-build')
          await tests(pkg, [])
        } catch (error) { failedPackages.push(pkg); console.error(error.message) }
      }
      summary.category = 'unit-test'
      if (failedPackages.length) throw Error(`Failed packages: ${failedPackages.join(', ')}`)
    } else {
    await tests('core', scope === 'full' ? [] : ['tests/codex.test.ts', 'tests/codex-reasoning.test.ts', 'tests/codex-file-boundary.test.ts'])
    await tests('cli', [])
    await tests('widget', scope === 'full' ? [] : ['tests/data.test.ts', 'tests/dst-boundary.test.ts'])
    await pnpmStep('site-sync', ['--dir', 'packages/site', 'exec', 'svelte-kit', 'sync'], 'remote-build')
    await tests('site', scope === 'full' ? [] : ['tests/initialization.test.ts', 'tests/db/migration-lock.test.ts', 'tests/db/schema-migrations.test.ts', 'tests/db/entry-hidden-migration.pg.test.ts', 'tests/db/migration-atomicity.pg.test.ts'])
    }
  } else {
    for (const pkg of ['web', 'cli', 'site']) await pnpmStep(`${pkg}-build`, ['--dir', `packages/${pkg}`, 'run', 'build'], 'remote-build')
    await pnpmStep('widget-renderer', ['--dir', 'packages/widget', 'exec', 'vite', 'build'], 'remote-build')
    await pnpmStep('widget-types', ['--dir', 'packages/widget', 'exec', 'tsc', '--noEmit'], 'remote-build')
    summary.widgetNative = 'not_run'; summary.widgetGui = 'not_run'
  }
  summary.status = 'passed'; summary.exitCode = 0
  if (!['postgres', 'docker'].includes(scope)) summary.category = task === 'test' ? 'unit-test' : 'remote-build'
} catch (error) {
  summary.status = 'failed'; summary.exitCode = 1; summary.message = error.message
  console.error(error.message)
} finally {
  save()
  console.log(JSON.stringify({ status: summary.status, exitCode: summary.exitCode, tests: summary.tests }))
  process.exitCode = summary.exitCode
}
