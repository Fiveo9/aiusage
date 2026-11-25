import { readFileSync } from 'node:fs'
import { compile, parse } from 'svelte/compiler'
import * as runtime from 'svelte/internal'
import { onDestroy, tick } from 'svelte'

/** Execute the delivered component script and its real compiled reactive graph.
 * The fragment is empty, so lifecycle/request tests need no simulated browser DOM.
 */
export function createScriptHarness(url: URL, props: Record<string, unknown>, fields: string | ((source: string) => string), setup = '') {
  const source = readFileSync(url, 'utf8')
  const instance = parse(source).instance!
  const content = instance.content as typeof instance.content & { start: number; end: number }
  const start = content.start
  let script = source.slice(start, content.end)
  const bindings = new Set<string>()
  for (const node of [...instance.content.body].reverse() as any[]) {
    if (node.type !== 'ImportDeclaration') continue
    for (const specifier of node.specifiers) bindings.add(specifier.local.name)
    script = script.slice(0, node.start - start) + script.slice(node.end - start)
  }
  bindings.delete('onMount')
  bindings.delete('onDestroy')
  const harness = `<script>
    ${[...bindings].map(name => `export let ${name};`).join('\n')}
    export let report;
    ${script}
    ${setup}
    $: report(${typeof fields === 'function' ? fields(source) : fields});
  </script>`
  const code = compile(harness, { generate: 'dom', css: 'external' }).js.code
    .replace(/import\s*\{([^}]+)\}\s*from ["']svelte\/internal["'];?/g,
      (_, names) => `const { ${names.replace(/\bas\b/g, ':')} } = runtime;`)
    .replace(/import ["']svelte\/internal\/disclose-version["'];?/g, '')
    .replace(/export default (\w+);?/, 'return $1;')
  const mounts: Array<() => unknown> = []
  const Component = new Function('runtime', 'onDestroy', 'onMount', code)(runtime, onDestroy, (callback: () => unknown) => mounts.push(callback))
  const reports: any[] = []
  const component = new Component({ target: {}, props: { ...props, report: (value: unknown) => reports.push(value) } })
  return { component, reports, source, mount: () => Promise.all(mounts.map(callback => callback())), destroy: () => component.$destroy() }
}

export async function flushScript() {
  await Promise.resolve()
  await Promise.resolve()
  await tick()
}

export function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
