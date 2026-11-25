import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The intended version set, not a count guessed from an older review. */
export function siteMigrationVersions(source) {
  const schema = readFileSync(join(source, 'packages/site/src/lib/server/db/schema.ts'), 'utf8')
  const versions = [...schema.matchAll(/^\s+version:\s*(\d+),/gm)].map(match => Number(match[1]))
  if (!versions.length || new Set(versions).size !== versions.length
    || versions.some((version, index) => !Number.isSafeInteger(version) || version < 1 || (index && version <= versions[index - 1]))) {
    throw Error('Invalid source migration version sequence')
  }
  return versions
}
