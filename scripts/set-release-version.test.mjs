import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import recycle from './recycle-output.cjs'
import { packageFiles, selectVersion, setPackageVersions, validateVersion } from './set-release-version.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

test('accepts strict semver and rejects shell, JavaScript and malformed versions', () => {
  for (const value of ['1.2.3', '0.0.0', '1.2.3-rc.1', '1.2.3+build.1', '1.2.3-beta.2+abc']) {
    assert.equal(validateVersion(value), value)
  }
  for (const value of ['', '01.2.3', '1.2', '1.2.3-01', "1.2.3';throw Error('injected');//", '1.2.3`id`', '1.2.3$(id)', '1.2.3;id', '1.2.3\n', '1.2.3-']) {
    assert.throws(() => validateVersion(value), /Invalid release version/)
  }
})

test('selects a validated tag, manual input or existing version', () => {
  assert.equal(selectVersion({ GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'v2.3.4', INPUT_VERSION: '9.9.9' }, '1.2.3'), '2.3.4')
  assert.equal(selectVersion({ INPUT_VERSION: '2.3.4' }, '1.2.3'), '2.3.4')
  assert.equal(selectVersion({}, '1.2.3'), '1.2.3')
  assert.throws(() => selectVersion({ GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: '1.2.3' }, '1.2.3'))
  assert.throws(() => selectVersion({ INPUT_VERSION: '1.2.3$(id)' }, '1.2.3'))
})

function fixture(action) {
  const parent = join(root, '.runtime', 'code-review-20261122', 'release-fixtures')
  mkdirSync(parent, { recursive: true })
  const dir = mkdtempSync(join(parent, 'release-'))
  try {
    for (const [index, file] of packageFiles.entries()) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      writeFileSync(join(dir, file), JSON.stringify({
        name: `@test/package-${index}`, version: '1.2.3',
        ...(index === 1 ? { dependencies: { '@test/package-0': 'workspace:^1.2.3', '@test/package-2': 'workspace:*' } } : {}),
      }))
    }
    action(dir)
  } finally {
    recycle.recycleOutput(root, dir)
  }
}

test('updates all five package versions and explicit workspace references', () => fixture(dir => {
  assert.deepEqual(setPackageVersions(dir, '1.2.4'), packageFiles)
  for (const file of packageFiles) assert.equal(JSON.parse(readFileSync(join(dir, file), 'utf8')).version, '1.2.4')
  const cli = JSON.parse(readFileSync(join(dir, packageFiles[1]), 'utf8'))
  assert.equal(cli.dependencies['@test/package-0'], 'workspace:^1.2.4')
  assert.equal(cli.dependencies['@test/package-2'], 'workspace:*')
}))

test('dry run does not write, and invalid input is rejected before any package write', () => fixture(dir => {
  const before = packageFiles.map(file => readFileSync(join(dir, file), 'utf8'))
  setPackageVersions(dir, '1.2.4', { checkOnly: true })
  assert.throws(() => setPackageVersions(dir, "1.2.4';injected()"))
  assert.deepEqual(packageFiles.map(file => readFileSync(join(dir, file), 'utf8')), before)
}))

test('a mismatched late package cannot leave an earlier package updated', () => fixture(dir => {
  const last = join(dir, packageFiles.at(-1))
  const pkg = JSON.parse(readFileSync(last, 'utf8'))
  pkg.version = '9.9.9'
  writeFileSync(last, JSON.stringify(pkg))
  const before = packageFiles.map(file => readFileSync(join(dir, file), 'utf8'))
  assert.throws(() => setPackageVersions(dir, '1.2.4'), /Workspace version differs/)
  assert.deepEqual(packageFiles.map(file => readFileSync(join(dir, file), 'utf8')), before)
}))
