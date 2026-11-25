import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { siteMigrationVersions } from './migration-expectations.mjs'

const root = process.env.AIUSAGE_CHECK_ROOT, attempt = process.env.AIUSAGE_CHECK_ATTEMPT
if (!/^\/data\/home\/aiusage-check\/\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(root || '')
  || !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(attempt || '')) throw Error('Isolated reuse run required')
const source = join(root, 'source'), output = join(root, 'attempts', attempt)
const expectedVersions = siteMigrationVersions(source)
const buildDate = new Date().toISOString()
const suffix = attempt.toLowerCase()
const cliImage = `aiusage-check-cli:${suffix}`, siteImage = `aiusage-check-site:${suffix}`
const cli = `aiusage-cli-${suffix}`, site = `aiusage-site-${suffix}`, pg = `aiusage-site-pg-${suffix}`
const network = `aiusage-check-${suffix}`
const report = { status: 'running', assertions: 0, builds: [], containers: [], stopped: false, network }
function docker(args, seconds = 60) {
  try { return execFileSync('docker', args, { encoding: 'utf8', timeout: seconds * 1000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch (error) { throw Error(`Docker ${args[0]} failed (exit ${error.status ?? 'timeout'}): ${String(error.stderr || '').slice(-1200)}`) }
}
async function build(name, file, tag) {
  console.log(`[docker-build] ${name}`)
  const log = createWriteStream(join(output, `docker-${name}-build.log`))
  const child = spawn('docker', ['build', '--progress=plain', '--build-arg', 'AIUSAGE_CONTAINER_CHECK=1', '--build-arg', `BUILD_DATE=${buildDate}`, '-f', file, '-t', tag, '.'],
    { cwd: source, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  await new Promise(resolve => log.end(resolve))
  report.builds.push({ name, tag, exitCode: code })
  if (code !== 0) throw Error(`${name} image build failed; see docker-${name}-build.log`)
  report.builds.at(-1).imageId = docker(['image', 'inspect', tag, '--format', '{{.Id}}'])
  assert.equal(docker(['image', 'inspect', tag, '--format', '{{.Config.User}}']), 'node'); report.assertions++
  assert.equal(docker(['image', 'inspect', tag, '--format', '{{index .Config.Labels "org.opencontainers.image.created"}}']), buildDate); report.assertions++
  assert.notEqual(docker(['image', 'inspect', tag, '--format', '{{json .Config.Healthcheck}}']), 'null'); report.assertions++
}
async function ready(container, script, label) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try {
      const value = docker(['exec', container, 'node', '-e', script], 8)
      if (value === 'ok') return
    } catch {}
    if (docker(['inspect', container, '--format', '{{.State.Running}}']) !== 'true') throw Error(`${label} container exited`)
    await delay(500)
  }
  throw Error(`${label} readiness timed out`)
}
try {
  await build('cli', 'Dockerfile', cliImage)
  await build('site', 'packages/site/Dockerfile', siteImage)
  process.env.AIUSAGE_DASHBOARD_PASSWORD = randomBytes(24).toString('hex')
  docker(['run', '-d', '--name', cli, '--network', 'none', '--label', `aiusage.check=${attempt}`, '-e', 'AIUSAGE_DASHBOARD_PASSWORD', cliImage])
  report.containers.push(cli)
  assert.equal(docker(['exec', cli, 'id', '-u']), '1000'); report.assertions++
  assert.equal(docker(['exec', cli, 'node', '-e', "const fs=require('node:fs');if(['packages/site','packages/web','/usr/bin/g++','/usr/bin/make'].some(p=>fs.existsSync(p)))process.exit(1);console.log('ok')"]), 'ok'); report.assertions++
  await ready(cli, "fetch('http://127.0.0.1:3847/api/auth/status').then(async r=>{const d=await r.json();if(r.status!==200||!d.enabled||d.authenticated)process.exit(1);console.log('ok')}).catch(()=>process.exit(1))", 'CLI')
  report.assertions++
  const cliCheck = docker(['exec', cli, 'node', '-e', `(async()=>{
    const base='http://127.0.0.1:3847';
    const page=await fetch(base); if(page.status!==200||!(await page.text()).includes('<html'))throw Error();
    const blocked=await fetch(base+'/api/config'); if(blocked.status!==401)throw Error();
    const login=await fetch(base+'/api/auth/login',{method:'POST',body:JSON.stringify({password:process.env.AIUSAGE_DASHBOARD_PASSWORD})});
    if(login.status!==200)throw Error(); const cookie=login.headers.get('set-cookie').split(';')[0];
    const allowed=await fetch(base+'/api/config',{headers:{Cookie:cookie}}); if(allowed.status!==200)throw Error();
    console.log('ok');
  })().catch(()=>process.exit(1))`])
  assert.equal(cliCheck, 'ok'); report.assertions += 4
  docker(['network', 'create', '--internal', '--label', `aiusage.check=${attempt}`, network])
  docker(['run', '-d', '--name', pg, '--network', network, '--network-alias', 'db', '--label', `aiusage.check=${attempt}`,
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-bookworm'])
  report.containers.push(pg)
  for (let n = 0; n < 60; n++) {
    try { docker(['exec', pg, 'pg_isready', '-U', 'postgres']); break } catch { if (n === 59) throw Error('PostgreSQL container not ready'); await delay(500) }
  }
  docker(['run', '-d', '--name', site, '--network', network, '--label', `aiusage.check=${attempt}`,
    '-e', 'DATABASE_URL=postgres://postgres@db:5432/postgres', '-e', 'ORIGIN=http://localhost:3000', siteImage])
  report.containers.push(site)
  await ready(site, "fetch('http://127.0.0.1:3000/api/health').then(async r=>{const d=await r.json();if(r.status!==200||d.status!=='ok'||d.db!=='connected')process.exit(1);console.log('ok')}).catch(()=>process.exit(1))", 'Site')
  report.assertions++
  const versions = docker(['exec', pg, 'psql', '-U', 'postgres', '-tAc', 'SELECT count(*) FROM schema_migrations'])
  assert.equal(versions, String(expectedVersions.length)); report.assertions++
  assert.equal(docker(['exec', pg, 'psql', '-U', 'postgres', '-tAc', 'SELECT max(version) FROM schema_migrations']), String(expectedVersions.at(-1))); report.assertions++
  assert.equal(docker(['exec', site, 'id', '-u']), '1000'); report.assertions++
  for (const name of report.containers) {
    assert.equal(docker(['inspect', name, '--format', '{{json .HostConfig.PortBindings}}']), '{}')
    report.assertions++
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = error instanceof assert.AssertionError ? 'Container assertion failed' : error.message
  process.exitCode = 1
} finally {
  for (const name of report.containers) {
    try {
      writeFileSync(join(output, `${name.startsWith('aiusage-site-pg') ? 'docker-pg' : name.startsWith('aiusage-site') ? 'docker-site' : 'docker-cli'}-runtime.log`), docker(['logs', name]))
    } catch { report.status = 'failed'; process.exitCode = 1 }
    // Evidence collection must not prevent shutdown when a logs request fails.
    try {
      if (docker(['inspect', name, '--format', '{{index .Config.Labels "aiusage.check"}}']) === attempt) docker(['stop', '--time', '10', name], 20)
    } catch { report.status = 'failed'; process.exitCode = 1 }
  }
  report.stopped = report.containers.every(name => { try { return docker(['inspect', name, '--format', '{{.State.Running}}']) === 'false' } catch { return false } })
  if (!report.stopped) { report.status = 'failed'; process.exitCode = 1 }
  writeFileSync(join(output, 'docker-result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
