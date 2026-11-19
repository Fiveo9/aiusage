import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allowedSource } from './remote-check-package.mjs'
import { packSource } from './remote-check-package.mjs'
import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const { recycleOutput } = createRequire(import.meta.url)('./recycle-output.cjs')

function fixture() {
  const parent = resolve('.artifacts/remote-check/package-tests')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'case-'))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  const files = {
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'scripts/remote-check-linux.mjs': '// synthetic\n',
    'scripts/remote-check-recycle.cjs': '// synthetic\n',
    'packages/cli/src/example.ts': 'export const value = 1\n',
    'packages/cli/.env': 'SYNTHETIC_ONLY=1\n',
    'packages/cli/dist/old.js': '// build output\n',
    'backups/original.ts': '// backup\n',
  }
  for (const [name, contents] of Object.entries(files)) {
    const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, contents)
  }
  return root
}

test('keeps source and new regression files', () => {
  for (const path of ['packages/cli/src/auth.ts', 'packages/site/tests/db/migration-atomicity.pg.test.ts',
    'scripts/remote-check.ps1', 'pnpm-lock.yaml', 'packages/widget/bin/prepare-native.js']) {
    assert.equal(allowedSource(path), true, path)
  }
})
test('excludes secrets, environment files, backups and compiled output at every depth', () => {
  for (const path of ['.env', 'packages/widget/bin/.env.js', 'packages/site/.env.example', 'packages/site/.env.production',
    'backups/old.ts', 'packages/site/backups/old.ts', 'packages/cli/dist/index.js',
    'packages/site/build/index.js', 'packages/widget/node_modules/x.js',
    'packages/site/private.pem', 'packages/cli/cache.db', 'packages/cli/.npmrc',
    'packages/site/credentials.json', 'packages/site/vite.config.js.timestamp-123.mjs',
    '.artifacts/check/a.ts', 'node_modules/a.js', 'packages/cli/bin/blob.exe']) {
    assert.equal(allowedSource(path), false, path)
  }
})
test('rejects traversal, absolute paths and Windows path ambiguity', () => {
  for (const path of ['../private.ts', '/packages/cli/a.ts', 'packages/../private.ts',
    'packages\\cli\\src\\a.ts', 'C:/packages/a.ts']) assert.equal(allowedSource(path), false, path)
})

test('archives only allowed current source and records exact byte hashes', () => {
  const root = fixture()
  try {
    const output = join(root, '.artifacts/remote-check/synthetic')
    const packed = packSource(root, output)
    const manifest = JSON.parse(readFileSync(join(output, 'source-manifest.json'), 'utf8'))
    assert.equal(packed.files, 4)
    assert.equal(manifest.every(entry => /^[a-f0-9]{64}$/.test(entry.sha256)), true)
    const archived = execFileSync('tar', ['-tzf', packed.archive], { encoding: 'utf8' })
    assert.match(archived, /packages\/cli\/src\/example\.ts/)
    assert.doesNotMatch(archived, /\.env|dist\/old|backups/)
  } finally { recycleOutput(process.cwd(), root) }
})

test('rejects a hard-linked source before reading or transmitting it', () => {
  const root = fixture()
  try {
    linkSync(join(root, 'packages/cli/src/example.ts'), join(root, 'packages/cli/src/linked.ts'))
    assert.throws(() => packSource(root, join(root, '.artifacts/remote-check/synthetic')), /Linked source requires review/)
  } finally {
    // Both hard-link names and their owner were created above and reviewed here.
    // Moving the entire synthetic tree preserves the links and all fixture bytes.
    const { renameSync } = createRequire(import.meta.url)('node:fs')
    const destination = join(process.cwd(), 'backups', `package-link-test-${Date.now()}`)
    assert.equal(resolve(root).startsWith(resolve('.artifacts/remote-check/package-tests') + '\\')
      || resolve(root).startsWith(resolve('.artifacts/remote-check/package-tests') + '/'), true)
    renameSync(root, destination)
  }
})
