import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const packageFiles = ['core', 'cli', 'web', 'site', 'widget']
  .map(name => `packages/${name}/package.json`)

export function validateVersion(value) {
  if (typeof value !== 'string' || value.length > 256) throw new Error('Invalid release version')
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value)
  if (!match || match.slice(1, 4).some(part => !Number.isSafeInteger(Number(part)))
    || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) {
    throw new Error('Invalid release version')
  }
  return value
}

export function selectVersion(env, currentVersion) {
  if (env.GITHUB_EVENT_NAME === 'push') {
    const tag = env.GITHUB_REF_NAME || ''
    if (!tag.startsWith('v')) throw new Error('Release tags must start with v')
    return validateVersion(tag.slice(1))
  }
  return validateVersion((env.INPUT_VERSION || '').trim() || currentVersion)
}

export function setPackageVersions(root, version, { checkOnly = false } = {}) {
  validateVersion(version)
  const packages = packageFiles.map(file => {
    const absolute = resolve(root, file)
    const stat = lstatSync(absolute)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error(`Linked package requires review: ${file}`)
    return { file, absolute, pkg: JSON.parse(readFileSync(absolute, 'utf8')) }
  })
  const currentVersion = validateVersion(packages[0].pkg.version)
  const names = new Set(packages.map(({ pkg }) => pkg.name))
  if (names.size !== packageFiles.length || [...names].some(name => typeof name !== 'string' || !name)) {
    throw new Error('Workspace package names must be unique')
  }
  // Validate the complete set before writing any package.
  for (const { file, pkg } of packages) {
    if (pkg.version !== currentVersion) throw new Error(`Workspace version differs: ${file}`)
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, spec] of Object.entries(pkg[group] || {})) {
        if (!names.has(name)) continue
        if (['workspace:*', 'workspace:^', 'workspace:~'].includes(spec)) continue
        const match = /^workspace:([~^]?)(.+)$/.exec(spec)
        if (!match || match[2] !== currentVersion) throw new Error(`Workspace dependency differs: ${file} (${name})`)
        pkg[group][name] = `workspace:${match[1]}${version}`
      }
    }
    pkg.version = version
  }
  if (!checkOnly) for (const { absolute, pkg } of packages) {
    writeFileSync(absolute, `${JSON.stringify(pkg, null, 2)}\n`)
  }
  return packages.map(({ file }) => file)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Unsupported argument')
  const current = JSON.parse(readFileSync('packages/cli/package.json', 'utf8')).version
  const version = selectVersion(process.env, current)
  setPackageVersions(process.cwd(), version, { checkOnly: process.argv.includes('--check') })
  process.stdout.write(`Publishing version: ${version}\n`)
}
