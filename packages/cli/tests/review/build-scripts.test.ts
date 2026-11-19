import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const require = createRequire(import.meta.url)
const { recycleOutput } = require('../../../../scripts/recycle-output.cjs')

it('moves old output into the workspace recycle directory without losing bytes', () => {
  const artifacts = resolve('../../.artifacts/build-script-tests')
  mkdirSync(artifacts, { recursive: true })
  const workspace = mkdtempSync(join(artifacts, 'case-'))
  mkdirSync(join(workspace, 'dist'))
  writeFileSync(join(workspace, 'dist', 'sentinel.txt'), 'synthetic build')
  const recycled = recycleOutput(workspace, 'dist')
  expect(existsSync(join(workspace, 'dist'))).toBe(false)
  expect(readFileSync(join(recycled, 'sentinel.txt'), 'utf8')).toBe('synthetic build')
  expect(() => recycleOutput(workspace, '..')).toThrow('inside workspace')
  expect(() => recycleOutput(workspace, '.')).toThrow('inside workspace')
  // Keep the fixture recoverable too; no test teardown physically deletes it.
  recycleOutput(resolve('../..'), workspace)
})
