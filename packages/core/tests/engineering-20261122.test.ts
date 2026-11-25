import { afterAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { siteMigrationVersions } from '../../../scripts/migration-expectations.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(import.meta.url)
const { recycleOutput, pruneRecycle } = require('../../../scripts/recycle-output.cjs')
const temporaryRoots: string[] = []
function temporary(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}
afterAll(() => {
  const bin = join(repo, 'backups/test-recycle/F22-engineering')
  mkdirSync(bin, { recursive: true })
  for (const root of temporaryRoots) renameSync(root, join(bin, basename(root)))
})

describe('engineering contracts', () => {
  it('reads the intended source version set, including the historical gap', () => {
    const versions = siteMigrationVersions(repo)
    expect(versions).toHaveLength(22)
    expect(versions.at(-1)).toBe(23)
    expect(versions).not.toContain(10)
  })

  it('rejects a broad/outside recycle target before moving it', () => {
    const root = temporary('aiusage-recycle-boundary-')
    expect(() => recycleOutput(root, root)).toThrow('inside workspace')
    expect(() => recycleOutput(root, dirname(root))).toThrow('inside workspace')
    expect(existsSync(root)).toBe(true)
  })

  it('keeps the newest output and recovers older ones through the supplied trash provider', () => {
    const root = temporary('aiusage-recycle-retention-')
    const out = join(root, 'dist')
    mkdirSync(out)
    writeFileSync(join(out, 'index.js'), 'old')
    const first = recycleOutput(root, out)
    mkdirSync(out)
    writeFileSync(join(out, 'index.js'), 'new')
    const second = recycleOutput(root, out)
    const trash = join(root, 'test-trash')
    mkdirSync(trash)
    const moved: string[] = []
    pruneRecycle(root, { maxEntries: 1, maxBytes: 1000, trash: (source: string) => {
      moved.push(source); renameSync(source, join(trash, String(moved.length)))
    } })
    expect(moved).toEqual([first])
    expect(readFileSync(join(second, 'index.js'), 'utf8')).toBe('new')
    expect(readFileSync(join(trash, '1', 'index.js'), 'utf8')).toBe('old')
  })

  it('checks CRLF releases without writes and preserves CRLF when upgrading a synthetic workspace', () => {
    const root = temporary('aiusage-release-crlf-')
    for (const pkg of ['core', 'cli', 'site', 'web', 'widget']) {
      mkdirSync(join(root, 'packages', pkg), { recursive: true })
      writeFileSync(join(root, 'packages', pkg, 'package.json'), JSON.stringify({ version: '1.5.28' }))
    }
    mkdirSync(join(root, 'packages/site/src/routes/docs'), { recursive: true })
    writeFileSync(join(root, 'packages/site/src/routes/docs/+page.svelte'), '<span class="meta-tag">v1.5.28</span>')
    writeFileSync(join(root, 'packages/site/src/routes/+layout.svelte'), "softwareVersion: '1.5.28'")
    for (const [name, marker] of [['CHANGELOG.md', 'Unreleased'], ['CHANGELOG.zh-CN.md', '未发布']]) {
      writeFileSync(join(root, name), `# Changelog\r\n\r\n## [${marker}]\r\n\r\n- Synthetic fix\r\n\r\n---\r\n\r\n## [1.5.28] - 2026-11-22\r\n\r\n- Older fix\r\n\r\n[1.5.28]: https://example.test/compare\r\n`)
    }
    const before = readFileSync(join(root, 'CHANGELOG.md'))
    expect(execFileSync(process.execPath, [join(repo, 'scripts/prepare-patch-release.mjs'), '--check'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()).toBe('1.5.29')
    expect(readFileSync(join(root, 'CHANGELOG.md'))).toEqual(before)
    execFileSync(process.execPath, [join(repo, 'scripts/prepare-patch-release.mjs')], { cwd: root, stdio: 'pipe', windowsHide: true })
    for (const name of ['CHANGELOG.md', 'CHANGELOG.zh-CN.md']) {
      const content = readFileSync(join(root, name), 'utf8')
      expect(content).toContain('## [1.5.29]')
      expect(content).toContain('\r\n\r\n- Synthetic fix\r\n\r\n')
      expect(content.replaceAll('\r\n', '')).not.toContain('\n')
    }
  })
})
