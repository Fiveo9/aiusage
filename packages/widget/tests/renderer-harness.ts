import { readFileSync } from 'node:fs'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { compile, parse } from 'svelte/compiler'
import * as runtime from 'svelte/internal'
import { onDestroy, tick } from 'svelte'
import * as sharedFormat from '@aiusage/core/format'

// Run the actual TypeScript component script/reactive graph without a DOM fragment.
export function renderer(url: URL, props: Record<string, unknown>, fields: string) {
  const source = readFileSync(url, 'utf8')
  const scriptSource = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]
  let script = transpileModule(scriptSource, { compilerOptions: {
    module: ModuleKind.ESNext, target: ScriptTarget.ES2020, verbatimModuleSyntax: true,
  } }).outputText
  const instance = parse(`<script>${script}</script>`).instance!
  const bindings = new Set<string>()
  const sharedProps: Record<string, unknown> = {}
  for (const node of [...instance.content.body].reverse() as any[]) {
    if (node.type !== 'ImportDeclaration') continue
    for (const specifier of node.specifiers) {
      bindings.add(specifier.local.name)
      if (node.source.value === '@aiusage/core/format') {
        const value = (sharedFormat as Record<string, unknown>)[specifier.imported.name]
        if (value === undefined) throw Error('Unknown shared formatter import')
        sharedProps[specifier.local.name] = value
      }
    }
    script = script.slice(0, node.start - 8) + script.slice(node.end - 8)
  }
  for (const binding of ['onMount', 'onDestroy', 'afterUpdate']) bindings.delete(binding)
  const code = compile(`<script>${[...bindings].map(name => `export let ${name};`).join('\n')}
    export let report; ${script} $: report(${fields});</script>`, { generate: 'dom', css: 'external' }).js.code
    .replace(/import\s*\{([^}]+)\}\s*from ["']svelte\/internal["'];?/g,
      (_, names) => `const { ${names.replace(/\bas\b/g, ':')} } = runtime;`)
    .replace(/import ["']svelte\/internal\/disclose-version["'];?/g, '')
    .replace(/export default (\w+);?/, 'return $1;')
  const mounts: Array<() => unknown> = [], cleanups: Array<() => void> = [], reports: any[] = []
  const Component = new Function('runtime', 'onDestroy', 'onMount', 'afterUpdate', code)(
    runtime, onDestroy, (callback: () => unknown) => mounts.push(callback), () => {})
  const component = new Component({ target: {}, props: { ...sharedProps, ...props, report: (value: unknown) => reports.push(value) } })
  return { component, reports, source, mount: async () => {
    for (const callback of mounts) { const cleanup = await callback(); if (typeof cleanup === 'function') cleanups.push(cleanup as () => void) }
  }, destroy: () => { for (const cleanup of cleanups.splice(0)) cleanup(); component.$destroy() } }
}
export async function flushRenderer() { await Promise.resolve(); await Promise.resolve(); await tick() }
