export interface JsonlEntry { line: string; offset: number }

/** Return only complete input. Offsets refer to source bytes, not decoded UTF-8. */
export function completeJsonlEntries(buffer: Buffer): { entries: JsonlEntry[]; nextOffset: number } {
  const tailStart = buffer.lastIndexOf(0x0a) + 1
  let nextOffset = buffer.length
  if (tailStart < buffer.length) {
    const tail = buffer.subarray(tailStart).toString('utf8')
    if (tail.trim()) {
      try {
        JSON.parse(tail)
      } catch {
        nextOffset = tailStart
      }
    }
  }
  const entries: JsonlEntry[] = []
  let offset = 0
  while (offset <= nextOffset) {
    const newline = buffer.indexOf(0x0a, offset)
    const end = newline >= 0 && newline < nextOffset ? newline : nextOffset
    entries.push({ line: buffer.toString('utf8', offset, end), offset })
    if (end === nextOffset) break
    offset = end + 1
  }
  return { entries, nextOffset }
}

/** Compatibility API for callers that only need decoded complete lines. */
export function completeJsonlInput(buffer: Buffer): { lines: string[]; nextOffset: number } {
  const { entries, nextOffset } = completeJsonlEntries(buffer)
  return { lines: entries.map(entry => entry.line), nextOffset }
}
