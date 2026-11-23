import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, delimiter } from 'node:path'

const fixture = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'aiusage-discovery-windows-')) }
})
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => fixture.root, platform: () => 'win32' }))
vi.mock('../src/config.js', () => ({ loadConfig: () => null }))
import { discoverLogFiles, getDbPath } from '../src/discovery.js'

function file(path: string): string { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, ''); return path }
const env = { APPDATA: join(fixture.root, 'provided-roaming'), LOCALAPPDATA: join(fixture.root, 'provided-local'),
  XDG_DATA_HOME: join(fixture.root, 'provided-xdg'), USERPROFILE: fixture.root }

describe('review discovery context and Windows delimiter boundaries', () => {
  afterAll(() => rmSync(fixture.root, { recursive: true, force: true }))
  it.each([
    ['cursor', () => join(env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb')],
    ['qoder-db', () => join(env.APPDATA, 'Qoder', 'SharedClientCache', 'cache', 'db', 'local.db')],
    ['kilocode-db', () => join(env.APPDATA, 'kilo', 'kilo.db')],
    ['goose', () => join(env.APPDATA, 'goose', 'sessions', 'sessions.db')],
    ['zed', () => join(env.LOCALAPPDATA, 'Zed', 'threads', 'threads.db')],
  ] as Array<[string, () => string]>)('uses supplied context env rather than global env for %s', (key, expectedPath) => {
    const expected = file(expectedPath())
    expect(getDbPath(key, env)).toBe(expected)
  })
  it('keeps Windows drive letters when splitting semicolon-delimited IDE roots', () => {
    const first = join(fixture.root, 'first-ide')
    const second = join(fixture.root, 'second-ide')
    const expected = join(second, 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks')
    mkdirSync(expected, { recursive: true })
    expect(getDbPath('roocode', { ...env, AIUSAGE_IDE_ROOTS: `${first}${delimiter}${second}` })).toBe(expected)
  })
  it('does not scan default Kiro roots when an explicit Kiro path is supplied', () => {
    const custom = join(fixture.root, 'explicit-kiro')
    const selected = file(join(custom, 'selected.jsonl'))
    file(join(env.APPDATA, 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'dev_data', 'tokens_generated.jsonl'))
    file(join(env.APPDATA, 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'workspace-sessions', 'default.json'))
    const paths = discoverLogFiles({ ...env, AIUSAGE_KIRO_PATH: custom }).filter(source => source.tool === 'kiro').flatMap(source => source.paths)
    expect(paths).toEqual([selected])
  })
})
