import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pageSource = readFileSync(
  fileURLToPath(new URL('../src/routes/sessions/+page.svelte', import.meta.url)),
  'utf8',
)

// The reactive statement that puts the list back on page 1: `$: <stores>, (page = 1)`
function pageResetDependencies(): string[] {
  const match = pageSource.match(/^\s*\$:\s*(.+?),\s*\(page = 1\)\s*$/m)
  return match ? match[1].split(',').map(dep => dep.trim()) : []
}

describe('sessions page', () => {
  it('goes back to page 1 when the date range, the device or the tool changes', () => {
    expect(pageResetDependencies().sort()).toEqual(['$dateRange', '$selectedDevice', '$selectedTool'])
  })

  it('resets the page before the statement that loads the data', () => {
    const reset = pageSource.indexOf('(page = 1)')
    const load = pageSource.search(/^\s*\$:.*loadData\(\)\s*$/m)

    expect(reset).toBeGreaterThan(-1)
    expect(load).toBeGreaterThan(reset)
  })

  it('ignores responses that are not for the latest request', () => {
    expect(pageSource).toContain('const isLatest = beginRequest()')
    expect(pageSource).toMatch(/await fetchSessions\([^)]*\)\s*if \(!isLatest\(\)\) return\s*data = response/)
  })
})
