import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { getLocalDayStart, queryWidgetData } from '../src/data'

beforeAll(() => vi.stubEnv('TZ', 'America/New_York'))
afterAll(() => vi.unstubAllEnvs())

it('uses calendar midnights across the New York DST transitions', () => {
  const springBefore = new Date('2026-03-08T12:00:00-05:00')
  const springStart = getLocalDayStart(springBefore)
  const springNext = getLocalDayStart(springBefore, 1)
  expect(springNext - springStart).toBe(23 * 60 * 60 * 1000)

  const fallBefore = new Date('2026-11-01T12:00:00-04:00')
  const fallStart = getLocalDayStart(fallBefore)
  const fallNext = getLocalDayStart(fallBefore, 1)
  expect(fallNext - fallStart).toBe(25 * 60 * 60 * 1000)
})

it('keeps range starts aligned to local dates', () => {
  const date = new Date('2026-03-09T12:00:00-04:00')
  const start = getLocalDayStart(date, -1)
  expect(new Date(start).getDate()).toBe(8)
  expect(new Date(start).getHours()).toBe(0)
})

it('constructs the target midnight directly when a source midnight is skipped', () => {
  vi.stubEnv('TZ', 'America/Havana')
  try {
    const start = getLocalDayStart(new Date('2026-03-08T12:00:00-04:00'), 1)
    expect(new Date(start).getDate()).toBe(9)
    expect(new Date(start).getHours()).toBe(0)
  } finally { vi.stubEnv('TZ', 'America/New_York') }
})

it.each([
  ['2026-03-08', '2026-03-09', '-04:00'],
  ['2026-11-01', '2026-11-02', '-05:00'],
])('assigns late-night records correctly on %s', (day, nextDay, offset) => {
  const db = new Database(':memory:')
  vi.useFakeTimers()
  vi.setSystemTime(new Date(`${day}T12:00:00${offset}`))
  try {
    db.exec(`CREATE TABLE records (
      ts INTEGER, tool TEXT, model TEXT, session_id TEXT,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
      thinking_tokens INTEGER DEFAULT 0, cost REAL DEFAULT 0
    )`)
    const insert = db.prepare('INSERT INTO records (ts, input_tokens, tool, model, session_id) VALUES (?, ?, ?, ?, ?)')
    insert.run(new Date(`${day}T23:30:00${offset}`).getTime(), 10, 'codex', 'synthetic', 'a')
    insert.run(new Date(`${nextDay}T00:00:00${offset}`).getTime(), 100, 'codex', 'synthetic', 'b')
    const result = queryWidgetData(db, 3)
    expect(result.todayTokens.total).toBe(10)
    expect(result.rangeTokens.total).toBe(10)
    expect(result.sessionCountToday).toBe(1)
    expect(result.dailyHistory.map(d => d.date)).toEqual(day.startsWith('2026-03')
      ? ['2026-03-06', '2026-03-07', '2026-03-08']
      : ['2026-10-30', '2026-10-31', '2026-11-01'])
    expect(result.dailyHistory.map(d => d.tokens)).toEqual([0, 0, 10])
  } finally { db.close(); vi.useRealTimers() }
})
