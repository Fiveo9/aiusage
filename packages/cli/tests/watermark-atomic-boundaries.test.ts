import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WatermarkManager } from '../src/watermark.js'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

describe('review atomic watermark save', () => {
  let directory: string | undefined
  afterEach(() => {
    vi.mocked(renameSync).mockClear()
    if (directory) rmSync(directory, { recursive: true, force: true })
    directory = undefined
  })
  it('preserves the last complete watermark on rename failure, then can retry', () => {
    directory = mkdtempSync(join(tmpdir(), 'aiusage-watermark-atomic-'))
    const file = join(directory, 'watermark.json')
    const manager = new WatermarkManager(file)
    manager.setTraeLastImported(1)
    manager.save()
    const before = readFileSync(file, 'utf8')
    manager.setTraeLastImported(2)
    vi.mocked(renameSync).mockImplementationOnce(() => { throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' }) })
    expect(() => manager.save()).toThrow('synthetic rename failure')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(readdirSync(directory)).toEqual(['watermark.json'])
    manager.save()
    expect(new WatermarkManager(file).getTraeLastImported()).toBe(2)
  })
})
