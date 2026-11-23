import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type http from 'node:http'
import type { StatsRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'
import { exportData } from '../../src/commands/export.js'
import { generateSummary } from '../../src/commands/summary.js'
import { getDateRangeBounds } from '../../src/api/server.js'
import { isTrustedApiRequest } from '../../src/api/trust.js'
import { extractProjectFromCwd } from '../../src/api/project-extraction.js'

function row(id: string, owner: string, tokens: number): StatsRecord {
  return { id, ts: 1000, ingestedAt: 1000, updatedAt: 1000, lineOffset: 0, tool: owner === 'a' ? 'codex' : 'claude-code',
    model: 'synthetic', provider: 'synthetic', inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    thinkingTokens: 0, cost: tokens, costSource: 'log', sessionId: id, sourceFile: `${id}.jsonl`, device: `Display ${owner}`, deviceInstanceId: owner }
}
describe('review CLI support boundaries', () => {
  let db: Database.Database
  beforeEach(() => { db = new Database(':memory:'); initializeDatabase(db) })
  afterEach(() => db.close())
  it('escapes commas, quotes and CRLF in every exported CSV text cell', () => {
    const model = 'synthetic, "quoted"\r\nnext'
    insertRecord(db, { ...row('one', 'a', 1), model, device: 'Device, "A"' })
    const csv = exportData(db, 'csv')
    expect(csv).toContain(`"${model.replace(/"/g, '""')}"`)
    expect(csv).toContain('"Device, ""A"""')
  })
  it('does not throw when a legacy row has an out-of-Date-range timestamp', () => {
    insertRecord(db, row('one', 'a', 1))
    db.exec('UPDATE records SET ts = 1e100')
    expect(() => exportData(db, 'csv')).not.toThrow()
    expect(JSON.parse(exportData(db, 'json'))[0].timestamp).toBeNull()
  })
  it('keeps a valid legacy ISO timestamp in formatted exports', () => {
    insertRecord(db, row('one', 'a', 1))
    const timestamp = '2026-01-01T00:00:00.000Z'
    db.prepare('UPDATE records SET ts = ?').run(timestamp)
    expect(JSON.parse(exportData(db, 'json'))[0].timestamp).toBe(timestamp)
    expect(exportData(db, 'csv')).toContain(timestamp)
  })
  it('filters a selected device even with no current state identity, including tool calls', () => {
    insertRecord(db, row('one', 'a', 10)); insertRecord(db, row('two', 'b', 20))
    db.exec("INSERT INTO tool_calls (id, record_id, tool, name, ts, call_index) VALUES ('call-a', 'one', 'codex', 'Read', 1000, 0), ('call-b', 'two', 'claude-code', 'Write', 1000, 0)")
    expect(generateSummary(db, { device: 'a' })).toMatchObject({ totalTokens: 10, recordCount: 1, topToolCalls: [{ name: 'Read', count: 1 }], deviceLabel: 'Display a' })
  })
  it('filters summary tool calls by the same requested tool and time bounds', () => {
    insertRecord(db, row('one', 'a', 10)); insertRecord(db, row('two', 'b', 20))
    db.exec("INSERT INTO tool_calls (id, record_id, tool, name, ts, call_index) VALUES ('call-a', 'one', 'codex', 'Read', 1000, 0), ('late-a', 'one', 'codex', 'Late', 5000, 1), ('call-b', 'two', 'claude-code', 'Write', 1000, 0)")
    expect(generateSummary(db, { tool: 'codex', startTs: 0, endTs: 2000 }).topToolCalls).toEqual([{ name: 'Read', count: 1 }])
  })
  it('loads the current device label from records rather than only remote mirrors', () => {
    insertRecord(db, row('one', 'a', 1))
    expect(generateSummary(db, { device: 'a', currentDeviceInstanceId: 'a' }).deviceLabel).toBe('Display a')
  })
  it('migrates the tool-call view so a NULL-parent mirror of an existing local orphan is not counted twice', () => {
    db.exec("INSERT INTO tool_calls (id, record_id, tool, name, ts, call_index) VALUES ('shared', NULL, 'codex', 'Read', 1000, 0); INSERT INTO synced_tool_calls VALUES ('target', 'a', 'shared', NULL, 'codex', 'Read', 1000, 0)")
    expect(db.prepare('SELECT COUNT(*) AS n FROM activity_tool_calls').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({ v: 20 })
  })
})

describe('review date/host/path boundaries', () => {
  it.each([
    ['bad', null, null], ['all', 'not-a-date', '2026-01-02'], ['all', '2026-02-30', '2026-03-02'],
    ['all', '2026-01-03', '2026-01-02'], ['all', '', '2026-01-02'],
  ])('rejects an invalid date selection %j', (range, from, to) => {
    expect(() => getDateRangeBounds(range, from, to)).toThrow()
  })
  it('keeps the documented missing-side-open date range semantics', () => {
    expect(getDateRangeBounds('all', '2026-01-01', null)).toEqual({ start: new Date(2026, 0, 1).getTime() })
    expect(getDateRangeBounds('all', null, '2026-01-01')).toEqual({ end: new Date(2026, 0, 2).getTime() })
  })
  it.each([undefined, 'https, http'])('compares canonical HTTPS :443 origins with forwarded protocol %j', forwarded => {
    const req = { url: '/api/config', headers: { host: 'dashboard.example:443', origin: 'https://dashboard.example',
      ...(forwarded ? { 'x-forwarded-proto': forwarded } : {}) }, socket: { encrypted: !forwarded } } as unknown as http.IncomingMessage
    expect(isTrustedApiRequest(req, 'synthetic-only')).toBe(true)
  })
  it.each(['C:\\Projects\\my-project\\pkg', 'C:\\users\\synthetic\\Projects\\my-project\\pkg', 'C:/Repositories/my-project/pkg'])
  ('extracts the project rather than the drive or Windows home in %s', cwd => {
    expect(extractProjectFromCwd(cwd)).toBe('my-project')
  })
})
