import { expect, it } from 'vitest'
import { join } from 'node:path'
import { resolveCliEntry } from '../../../widget/src/cli.js'

it('prefers the built independent workspace CLI', () => {
  const root = join(process.cwd(), 'synthetic', 'widget', 'dist')
  expect(resolveCliEntry(root, () => { throw Error('not installed') }, () => true,
    () => '{"name":"@fiveo9/aiusage"}')).toBe(join(root, '..', '..', 'cli', 'dist', 'index.js'))
})

it('rejects an upstream sibling and resolves only the independent package', () => {
  const manifest = join(process.cwd(), 'synthetic', '@fiveo9', 'aiusage', 'package.json')
  expect(resolveCliEntry('widget/dist', (id) => {
    expect(id).toBe('@fiveo9/aiusage/package.json')
    return manifest
  }, () => true, (path) => JSON.stringify({ name: path === manifest ? '@fiveo9/aiusage' : '@juliantanx/aiusage' })))
    .toBe(join(manifest, '..', 'dist', 'index.js'))
})

it('returns no executable when missing or unbuilt, without installing anything', () => {
  expect(resolveCliEntry('widget/dist', () => { throw Error('missing') }, () => false,
    () => '{"name":"@fiveo9/aiusage"}')).toBeNull()
})
