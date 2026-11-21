import type Database from 'better-sqlite3'

/** Latest nonempty title for this session, including records outside the date filter. */
export function getSessionTitle(db: Database.Database, sessionId: string, deviceInstanceId?: string, tool?: string): string | undefined {
  const row = db.prepare(`SELECT session_title FROM activity_session_titles
    WHERE session_id = @sessionId
      ${deviceInstanceId ? 'AND device_instance_id = @deviceInstanceId' : ''}
      ${tool ? 'AND tool = @tool' : ''}
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `).get({ sessionId, deviceInstanceId, tool }) as { session_title: string } | undefined
  return row?.session_title || undefined
}
