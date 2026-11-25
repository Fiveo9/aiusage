import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { compile, parse } from 'svelte/compiler'
import * as runtime from 'svelte/internal'
import { onDestroy, tick } from 'svelte'
import { writable } from 'svelte/store'
import { createRequestTracker } from '../src/lib/sessions-paging.js'
import { groupModelCosts } from '../src/lib/model-display.js'

// Execute the actual page script with synthetic stores and asynchronous API
// responses. No DOM or selector components are needed to exercise Svelte's
// compiled reactive dependency graph.
function createHarness(fetchCost: () => Promise<unknown>) {
  const source = readFileSync(new URL('../src/routes/cost/+page.svelte', import.meta.url), 'utf8')
  const instance = parse(source).instance!
  const content = instance.content as typeof instance.content & { start: number; end: number }
  const start = content.start
  let script = source.slice(start, content.end)
  for (const node of [...content.body].reverse() as Array<(typeof content.body)[number] & { start: number; end: number }>) {
    if (node.type === 'ImportDeclaration') {
      script = script.slice(0, node.start - start) + script.slice(node.end - start)
    }
  }
  const harness = `<script>
    export let dateRange;
    export let selectedDevice;
    export let selectedTool;
    export let modelDisplayMode;
    export let fetchCost;
    export let groupModelCosts;
    export let createRequestTracker;
    export let report;
    ${script}
    $: report({ totalCost, dailyAvg, shares: Object.values(data?.byTool || {}).map(
      cost => totalCost > 0 ? ((cost / totalCost) * 100).toFixed(1) : null
    ) });
  </script>`
  const code = compile(harness, { generate: 'dom', css: 'external' }).js.code
    .replace(/import\s*\{([^}]+)\}\s*from ["']svelte\/internal["'];?/g,
      (_, names) => `const { ${names.replace(/\bas\b/g, ':')} } = runtime;`)
    .replace(/import ["']svelte\/internal\/disclose-version["'];?/g, '')
    .replace(/export default (\w+);?/, 'return $1;')
  const Component = new Function('runtime', 'onDestroy', code)(runtime, onDestroy)
  const dateRange = writable({ range: 'week' })
  const reports: Array<{ totalCost: number; dailyAvg: number; shares: Array<string | null> }> = []
  const component = new Component({ target: {}, props: {
    dateRange,
    selectedDevice: writable(''),
    selectedTool: writable(''),
    modelDisplayMode: writable('full'),
    fetchCost,
    groupModelCosts,
    createRequestTracker,
    report: (value: typeof reports[number]) => reports.push(value),
  } })
  return { component, dateRange, reports }
}

describe('cost page reactive totals', () => {
  it('updates totals, daily average and shares after asynchronous loads and date changes', async () => {
    let respond!: (value: unknown) => void
    const fetchCost = vi.fn(() => new Promise(resolve => { respond = resolve }))
    const { component, dateRange, reports } = createHarness(fetchCost)
    try {
      expect(reports.at(-1)).toMatchObject({ totalCost: 0, dailyAvg: 0 })
      respond({ data: [{ cost: 2 }, { cost: 6 }], byTool: { codex: 2, cursor: 6 }, byModel: {} })
      await Promise.resolve()
      await tick()
      expect(reports.at(-1)).toEqual({ totalCost: 8, dailyAvg: 4, shares: ['25.0', '75.0'] })

      dateRange.set({ range: 'month' })
      await tick()
      expect(fetchCost).toHaveBeenCalledTimes(2)
      respond({ data: [{ cost: 10 }], byTool: { codex: 10 }, byModel: {} })
      await Promise.resolve()
      await tick()
      expect(reports.at(-1)).toEqual({ totalCost: 10, dailyAvg: 10, shares: ['100.0'] })
    } finally {
      component.$destroy()
    }
  })

  it('keeps empty and missing daily costs finite', async () => {
    const { component, reports } = createHarness(async () => ({
      data: [{ cost: 3 }, {}], byTool: {}, byModel: {},
    }))
    try {
      await Promise.resolve()
      await tick()
      expect(reports.at(-1)).toEqual({ totalCost: 3, dailyAvg: 1.5, shares: [] })
    } finally {
      component.$destroy()
    }
  })
})
