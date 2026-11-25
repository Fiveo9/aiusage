import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

export const CLI_PACKAGE = '@fiveo9/aiusage'
export const CLI_HELP = `Start from this checkout with pnpm dev:widget, or install the CLI explicitly: npm install -g ${CLI_PACKAGE}`

export function resolveCliEntry(
  widgetDir: string,
  resolveModule: (id: string) => string,
  exists: (path: string) => boolean = existsSync,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string | null {
  // dist/ is beside the package manifest in both workspace and global installs.
  // Check the manifest before accepting the sibling to avoid using an unrelated CLI.
  const sibling = join(widgetDir, '..', '..', 'cli')
  try {
    if (JSON.parse(read(join(sibling, 'package.json'))).name === CLI_PACKAGE) {
      const entry = join(sibling, 'dist', 'index.js')
      if (exists(entry)) return entry
    }
  } catch {}
  // pnpm's widget lives below .pnpm, while the explicitly installed global CLI
  // is linked from an outer node_modules. Probe only its exact package path.
  for (let ancestor = widgetDir, depth = 0; depth < 12; depth++) {
    if (basename(ancestor) === 'node_modules') {
      const manifest = join(ancestor, CLI_PACKAGE, 'package.json')
      try {
        if (JSON.parse(read(manifest)).name === CLI_PACKAGE) {
          const entry = join(dirname(manifest), 'dist', 'index.js')
          if (exists(entry)) return entry
        }
      } catch {}
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  try {
    const manifest = resolveModule(`${CLI_PACKAGE}/package.json`)
    if (JSON.parse(read(manifest)).name !== CLI_PACKAGE) return null
    const entry = join(dirname(manifest), 'dist', 'index.js')
    return exists(entry) ? entry : null
  } catch {
    return null
  }
}
