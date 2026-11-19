import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = process.env.AIUSAGE_CHECK_ROOT
const attempt = process.env.AIUSAGE_CHECK_ATTEMPT
if (!root || !/^\/data\/home\/aiusage-check\/\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(root)
  || !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(attempt || '')) throw Error('Isolated reuse run required')
const source = join(root, 'source'), output = join(root, 'attempts', attempt)
const site = join(source, 'packages/site')
const require = createRequire(join(site, 'package.json'))
const postgres = require('postgres')
const container = `aiusage-pg-${attempt.toLowerCase()}`
const report = { status: 'running', assertions: 0, container, stopped: false, scenarios: [] }
let admin
const children = new Set()
const clients = new Set()
function docker(args) { return execFileSync('docker', args, { encoding: 'utf8', timeout: 180000 }).trim() }
async function until(check, label) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) { if (await check()) return; await delay(100) }
  throw Error(`Timed out: ${label}`)
}
function worker(url) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/migration-process.ts'], {
    cwd: site, env: { ...process.env, DATABASE_URL: url }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  children.add(child)
  const state = { pid: child.pid, result: null, exited: false }
  child.on('message', message => { state.result = message })
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => { state.exited = true; children.delete(child); resolve(code) })
  })
  return { state, done }
}
function connect(url) {
  const client = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} })
  clients.add(client); return client
}
try {
  docker(['pull', 'postgres:16-bookworm'])
  report.image = docker(['image', 'inspect', 'postgres:16-bookworm', '--format', '{{.Id}}'])
  docker(['run', '-d', '--name', container, '--label', `aiusage.check=${attempt}`,
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-p', '127.0.0.1::5432', 'postgres:16-bookworm'])
  const mapping = docker(['port', container, '5432/tcp'])
  const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping)
  assert.ok(match, 'PostgreSQL must only be published on loopback')
  const base = `postgres://postgres@127.0.0.1:${match[1]}`
  admin = connect(`${base}/postgres`)
  await until(async () => { try { await admin`SELECT 1`; return true } catch { return false } }, 'PostgreSQL readiness')
  report.version = (await admin`SHOW server_version`)[0].server_version
  for (const failure of [false, true]) {
    const name = failure ? 'check_rollback' : 'check_commit'
    await admin.unsafe(`CREATE DATABASE ${name}`)
    const url = `${base}/${name}`
    const control = connect(url)
    // Gate the first real CREATE TABLE inside runMigrations after its actual
    // advisory lock has been obtained. The gate uses a different key.
    await control.unsafe(`CREATE FUNCTION test_gate() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() WHERE object_identity = 'public.schema_migrations') THEN
          PERFORM pg_advisory_xact_lock(1634304371, 99);
          ${failure ? "RAISE EXCEPTION 'synthetic migration failure' USING ERRCODE = 'P0001';" : ''}
        END IF;
      END $$`)
    await control.unsafe('CREATE EVENT TRIGGER gate_migration ON ddl_command_end WHEN TAG IN (\'CREATE TABLE\') EXECUTE FUNCTION test_gate()')
    await control`SELECT pg_advisory_lock(1634304371, 99)`
    const first = worker(url)
    await until(async () => (await control`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=1634304371 AND objid=99 AND NOT granted`).length > 0, 'first migration reached gate')
    const second = worker(url)
    await until(async () => (await control`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=1634304371 AND objid=1 AND NOT granted`).length > 0, 'second process waits on migration lock')
    assert.notEqual(first.state.pid, second.state.pid); report.assertions++
    assert.equal(first.state.exited || second.state.exited, false); report.assertions++
    await control`SELECT pg_advisory_unlock(1634304371, 99)`
    await until(() => first.state.exited && second.state.exited, 'both migration processes exit')
    const exits = await Promise.all([first.done, second.done])
    assert.deepEqual(exits, failure ? [1, 1] : [0, 0]); report.assertions++
    const held = await control`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=1634304371 AND objid IN (1,99)`
    assert.equal(held.length, 0); report.assertions++
    if (failure) {
      assert.equal((await control`SELECT to_regclass('schema_migrations') AS table_name`)[0].table_name, null)
      report.assertions++
      await control.unsafe('ALTER EVENT TRIGGER gate_migration DISABLE')
      const retry = worker(url)
      await until(() => retry.state.exited, 'successful retry after rollback')
      assert.equal(await retry.done, 0); report.assertions++
    }
    const versions = await control`SELECT version FROM schema_migrations ORDER BY version`
    assert.deepEqual(versions.map(row => row.version), [1,2,3,4,5,6,7,8,9,11,12,13,14,15,16,17]); report.assertions++
    report.scenarios.push({ name, distinctProcesses: true, waiterObserved: true, exits, versions: versions.length, retry: failure ? 'passed' : 'not_needed' })
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = error instanceof assert.AssertionError ? 'PostgreSQL concurrency assertion failed' : error.message
  process.exitCode = 1
} finally {
  for (const child of children) child.kill('SIGTERM')
  for (const client of clients) { try { await client.end({ timeout: 3 }) } catch {} }
  try {
    const id = docker(['inspect', container, '--format', '{{index .Config.Labels "aiusage.check"}}'])
    if (id === attempt) {
      docker(['stop', '--time', '10', container])
      report.stopped = docker(['inspect', container, '--format', '{{.State.Running}}']) === 'false'
    }
  } catch { report.stopped = false }
  if (!report.stopped) { report.status = 'failed'; process.exitCode = 1 }
  writeFileSync(join(output, 'postgres-result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
