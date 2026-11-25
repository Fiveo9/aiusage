import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { queryWidgetData } from '../src/data'

it('matches CLI all-device totals without counting merged or own synced copies twice', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`CREATE TABLE records (ts INTEGER, tool TEXT, model TEXT, session_id TEXT, origin TEXT, device_instance_id TEXT,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0, thinking_tokens INTEGER DEFAULT 0, cost REAL DEFAULT 0);
      CREATE TABLE synced_records (ts INTEGER, tool TEXT, model TEXT, session_key TEXT, device_instance_id TEXT,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0, thinking_tokens INTEGER DEFAULT 0, cost REAL DEFAULT 0);`)
    const now = Date.now()
    db.prepare('INSERT INTO records (ts,tool,model,session_id,origin,device_instance_id,input_tokens,cost) VALUES (?,?,?,?,?,?,?,?)')
      .run(now, 'codex', 'local', 'local-session', 'local', 'self', 100, 1)
    db.prepare('INSERT INTO records (ts,tool,model,session_id,origin,device_instance_id,input_tokens,cost) VALUES (?,?,?,?,?,?,?,?)')
      .run(now, 'codex', 'peer', 'peer-session', 'synced', 'peer', 200, 2)
    const remote = db.prepare('INSERT INTO synced_records (ts,tool,model,session_key,device_instance_id,input_tokens,cost) VALUES (?,?,?,?,?,?,?)')
    remote.run(now, 'codex', 'local', 'local-session', 'self', 100, 1)
    remote.run(now, 'codex', 'peer', 'peer-session', 'peer', 200, 2)
    remote.run(now, 'cursor', 'remote-only', 'third-session', 'third', 50, 0.5)
    const result = (queryWidgetData as any)(db, 30, 'self')
    expect(result.todayTokens.total).toBe(350)
    expect(result.rangeTokens.total).toBe(350)
    expect(result.todayCost).toBe(3.5)
    expect(result.dailyHistory.at(-1).tokens).toBe(350)
    expect(result.topModel.name).toBe('peer')
    expect(result.sessionCountToday).toBe(3)
  } finally { db.close() }
})
