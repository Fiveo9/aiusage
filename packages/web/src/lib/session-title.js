export function sessionLabel(session, unnamed) {
  const title = typeof session?.sessionTitle === 'string' ? session.sessionTitle.trim() : ''
  if (title) return title
  const rawId = typeof session?.sessionId === 'string' ? session.sessionId : ''
  const uuid = rawId.match(/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i)?.[1]
  const id = (uuid || rawId.split(/[\\/]/).pop() || '').slice(0, 8)
  return id ? `${unnamed} · ${id}` : unnamed
}
