import { afterEach, describe, expect, it } from 'vitest'
import { writable } from 'svelte/store'
import { createScriptHarness } from './script-harness.js'

const charts: Array<ReturnType<typeof createScriptHarness>> = []
afterEach(() => { for (const chart of charts.splice(0)) chart.destroy() })
function chart(kind: 'Cost' | 'Token', props: Record<string, unknown>, fields: (source: string) => string, setup = '') {
  const rendered = createScriptHarness(new URL(`../src/lib/components/charts/Svg${kind}Chart.svelte`, import.meta.url),
    { t: writable((key: string) => key), formatTokens: (value: number) => String(value), ...props }, fields, setup)
  charts.push(rendered)
  return rendered
}

describe('review actual SVG bar and hover expressions', () => {
  it.each(['Cost', 'Token'] as const)('keeps a minimum-height %s bar above the baseline', kind => {
    const days = kind === 'Cost' ? [{ date: 'small', cost: 1e-8 }, { date: 'large', cost: 1 }]
      : [{ date: 'small', inputTokens: 1 }, { date: 'large', inputTokens: 1e9 }]
    const rendered = chart(kind, { days, mode: 'total' }, source => {
      const markup = source.slice(source.indexOf('</script>') + 9)
      const declarations = [...markup.matchAll(/\{@const (barY|barH) = ([^}]+)\}/g)].map(match => `const ${match[1]} = ${match[2]};`).join('\n')
      return `{ bars: days.map(day => { ${kind === 'Token' ? 'const total = getDayTotal(day);' : ''}
        ${declarations} return { y: barY, h: barH, baseline: PAD_TOP + innerH }; }) }`
    })
    for (const bar of rendered.reports.at(-1).bars) {
      expect(bar.h).toBeGreaterThanOrEqual(2)
      expect(bar.y + bar.h).toBeLessThanOrEqual(bar.baseline + 1e-9)
    }
  })
  it('keeps minimum token segments adjacent and inside the plot', () => {
    const rendered = chart('Token', { days: [{ date: 'peak', inputTokens: 1e9, thinkingTokens: 1 }], mode: 'breakdown' },
      () => '{ segments: buildSegments(days[0], activeSeries), top: PAD_TOP, baseline: PAD_TOP + innerH }')
    const { segments, top, baseline } = rendered.reports.at(-1)
    let bottom = baseline
    for (const segment of segments) {
      expect(segment.h).toBeGreaterThanOrEqual(1.5 - 1e-9)
      expect(segment.y + segment.h).toBeCloseTo(bottom, 8)
      expect(segment.y).toBeGreaterThanOrEqual(top - 1e-9)
      bottom = segment.y
    }
  })
  it.each(['Cost', 'Token'] as const)('does not render a stale-index %s highlight or dim every bar', kind => {
    const rendered = chart(kind, { days: [{ date: 'one', cost: 1, inputTokens: 1 }] }, source => {
      const markup = source.slice(source.indexOf('</script>') + 9)
      const guard = markup.match(/\{#if ([^}]+)\}\s*<rect/)![1]
      const dimmed = markup.match(/class:dimmed=\{([^}]+)\}/)![1]
      return `{ highlight: Boolean(${guard}), dimmed: days.map((day, i) => Boolean(${dimmed})) }`
    }, 'hoveredIdx = 7;')
    expect(rendered.reports.at(-1)).toEqual({ highlight: false, dimmed: [false] })
  })
})
