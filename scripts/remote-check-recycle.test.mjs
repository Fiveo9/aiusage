import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path/posix'
import { test } from 'node:test'
import vm from 'node:vm'

const guard = readFileSync(new URL('./remote-check-recycle.cjs', import.meta.url), 'utf8')
const root = '/data/home/aiusage-check/20261123T132338Z-4f2994a0'
const fixture = `${root}/tmp/aiusage-git-boundaries-synthetic`

// Run the real guard against an in-memory filesystem: no real deletion or links.
function harness(linkTarget = `${fixture}/outside`, chained = false) {
  const entries = new Map([
    [root, { type: 'dir' }], [`${root}/tmp`, { type: 'dir' }],
    [fixture, { type: 'dir' }], [`${fixture}/cache`, { type: 'dir' }],
    [`${fixture}/outside`, { type: 'dir' }],
    [`${fixture}/outside/day.ndjson`, { type: 'file' }],
    [`${fixture}/cache/peer`, { type: 'link', target: linkTarget }],
  ])
  const renames = []
  const audit = []
  const fs = {
    mkdirSync: file => entries.set(file, { type: 'dir' }),
    existsSync: file => entries.has(file),
    lstatSync(file) {
      const entry = entries.get(file)
      if (!entry) throw Object.assign(Error('Missing synthetic entry'), { code: 'ENOENT' })
      return {
        isSymbolicLink: () => entry.type === 'link', isDirectory: () => entry.type === 'dir',
        isFile: () => entry.type === 'file', nlink: 1,
      }
    },
    readlinkSync: file => entries.get(file).target,
    realpathSync: file => {
      if (!entries.has(file)) throw Object.assign(Error('Dangling synthetic link'), { code: 'ENOENT' })
      return chained ? '/outside-run/redirected' : file
    },
    readdirSync: dir => [...entries.keys()].filter(file => path.dirname(file) === dir).map(file => path.basename(file)),
    appendFileSync: (file, text) => audit.push({ file, value: JSON.parse(text) }),
    renameSync: (from, to) => renames.push({ from, to }),
    linkSync: () => {},
  }
  const fsp = { link: async () => {} }
  const dependencies = {
    'node:fs': fs, 'node:fs/promises': fsp, 'node:path': path,
    'node:url': { fileURLToPath: url => url.pathname },
    'node:module': { syncBuiltinESMExports() {} }, 'node:crypto': { randomUUID: () => 'synthetic-id' },
  }
  vm.runInNewContext(guard, { require: name => dependencies[name], process: { env: { AIUSAGE_CHECK_ROOT: root } }, URL })
  return { fs, fsp, renames, audit }
}

test('recycles a complete fixture after auditing its internal absolute symlink', () => {
  const h = harness()
  h.fs.rmSync(fixture)
  assert.equal(h.renames.length, 1)
  assert.equal(h.renames[0].from, fixture)
  assert.ok(h.renames[0].to.startsWith(`${root}/recycle/`))
  assert.deepEqual(h.audit[0].value, { symbolic: 'tmp/aiusage-git-boundaries-synthetic/cache/peer', target: 'tmp/aiusage-git-boundaries-synthetic/outside' })
  assert.equal(h.audit.at(-1).value.source, 'tmp/aiusage-git-boundaries-synthetic')
})

test('promise cleanup audits an internal relative symlink and preserves one directory move', async () => {
  const h = harness('../outside')
  await h.fsp.rm(fixture)
  assert.equal(h.renames.length, 1)
})

test('refuses links outside the selected fixture, including paths elsewhere in the run', () => {
  for (const target of ['/etc', `${root}/source`, `${fixture}-other/data`]) {
    const h = harness(target)
    assert.throws(() => h.fs.rmSync(fixture), /Linked cleanup target requires review/)
    assert.equal(h.renames.length, 0)
  }
})

test('refuses chained or dangling internal links before moving any files', () => {
  for (const h of [harness(`${fixture}/outside`, true), harness(`${fixture}/missing`)]) {
    assert.throws(() => h.fs.rmSync(fixture))
    assert.equal(h.renames.length, 0)
  }
})

test('refuses a symlink selected alone and preserves the run-root cleanup boundary', () => {
  const h = harness()
  assert.throws(() => h.fs.unlinkSync(`${fixture}/cache/peer`), /Linked cleanup target requires review/)
  assert.throws(() => h.fs.rmSync(root), /Cleanup outside isolated remote-check run was refused/)
  assert.equal(h.renames.length, 0)
})
