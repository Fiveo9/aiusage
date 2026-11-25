export function isStateObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export interface PendingCallState {
  name: string
  ts: number
  lineOffset: number
  orphanId: string
}

export function readPendingCalls(value: unknown, cutoff: number): PendingCallState[] | undefined {
  if (!Array.isArray(value)) return undefined
  const calls: PendingCallState[] = []
  for (const entry of value) {
    if (!isStateObject(entry) || typeof entry.name !== 'string' || !entry.name
      || typeof entry.ts !== 'number' || !Number.isFinite(entry.ts)
      || !isOffset(entry.lineOffset) || entry.lineOffset >= cutoff
      || typeof entry.orphanId !== 'string' || !entry.orphanId) return undefined
    calls.push({ name: entry.name, ts: entry.ts, lineOffset: entry.lineOffset, orphanId: entry.orphanId })
  }
  return calls
}
