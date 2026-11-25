import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function allowedSource(path) {
  if (!path || path.includes('\\') || path.startsWith('/') || path.split('/').includes('..')) return false
  if (path.startsWith('docs/')) return false
  if (/(^|\/)\.env[^/]*(\/|$)/i.test(path)) return false
  if (/(^|\/)(\.env[^/]*|\.git|\.artifacts|\.runtime|backups|node_modules|dist|build|target|bin|obj|\.gradle|\.svelte-kit|\.pnpm-store|aiusage-data)(\/|$)/i.test(path)
      && !/^packages\/widget\/bin\/[^/]+\.js$/.test(path)) return false
  if (/(^|\/)(\.npmrc|\.pypirc|credentials?[^/]*\.(json|ini|yaml)|id_(rsa|ed25519))$/i.test(path)) return false
  if (/\.(pem|key|p12|pfx|sqlite|sqlite3|db|tgz|zip|exe|dll|node)$/i.test(path)) return false
  if (/\.timestamp-.*\.mjs$/.test(path)) return false
  return /^(packages\/|scripts\/|docs\/|\.github\/workflows\/)/.test(path)
    || /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.json|README(?:_zh)?\.md|CHANGELOG(?:\.zh-CN)?\.md|LICENSE|Dockerfile|\.dockerignore|\.gitignore)$/.test(path)
}

export function packSource(workspace, destination) {
  const root = resolve(workspace), output = resolve(destination)
  const rel = relative(root, output)
  if (!rel.startsWith('.artifacts/remote-check/') && !rel.startsWith('.artifacts\\remote-check\\')) throw Error('Invalid package destination')
  if (isAbsolute(rel) || rel.startsWith('..')) throw Error('Package destination outside workspace')
  const stage = resolve(output, 'source')
  if (existsSync(stage)) throw Error('Source staging already exists')
  mkdirSync(stage, { recursive: true })
  const files = [...new Set(execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'))]
    .filter(allowedSource).sort()
  const manifest = []
  for (const name of files) {
    const source = resolve(root, name)
    for (let current = source; current !== root; current = dirname(current)) {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw Error(`Linked source requires review: ${name}`)
    }
    const stat = lstatSync(source)
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw Error(`Unexpected source file: ${name}`)
    const bytes = readFileSync(source)
    // Fail closed without showing content if an actual-looking private key/token is present.
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bibk_[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bnpm_[A-Za-z0-9]{30,}/.test(bytes.toString('utf8'))) {
      throw Error(`Potential credential in source; package stopped: ${name}`)
    }
    const target = resolve(stage, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes, { flag: 'wx' })
    manifest.push({ path: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  for (const required of ['pnpm-lock.yaml', 'scripts/remote-check-linux.mjs', 'scripts/remote-check-recycle.cjs']) {
    if (!files.includes(required)) throw Error(`Required source excluded: ${required}`)
  }
  writeFileSync(resolve(stage, 'source-manifest.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(resolve(output, 'source-manifest.json'), JSON.stringify(manifest, null, 2))
  const archive = resolve(output, 'source.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', stage, '.'], { stdio: 'pipe' })
  return { files: files.length, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'), archive }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(packSource(process.cwd(), process.argv[2]))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
