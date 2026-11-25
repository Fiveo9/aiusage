import { openSync, readSync, closeSync, fstatSync } from 'node:fs'

export interface JsonlEntry { line: string; offset: number }

/** Bounded by one source line; a split UTF-8 code point is decoded only after joining. */
export class JsonlFileReader implements Iterable<JsonlEntry> {
  nextOffset: number

  constructor(private file: string, private startOffset = 0, private chunkSize = 64 * 1024) {
    if (!Number.isSafeInteger(startOffset) || startOffset < 0 || !Number.isSafeInteger(chunkSize) || chunkSize < 1) {
      throw new RangeError('Invalid JSONL byte range')
    }
    this.nextOffset = startOffset
  }

  *[Symbol.iterator](): Generator<JsonlEntry> {
    const fd = openSync(this.file, 'r')
    try {
      const end = fstatSync(fd).size
      if (this.startOffset > end) throw new RangeError('JSONL offset exceeds source size')
      let position = this.startOffset
      let lineOffset = position
      let parts: Buffer[] = []
      let length = 0
      while (position < end) {
        const chunk = Buffer.allocUnsafe(Math.min(this.chunkSize, end - position))
        const count = readSync(fd, chunk, 0, chunk.length, position)
        if (count === 0) break
        let start = 0
        for (let newline = chunk.indexOf(0x0a); newline >= 0 && newline < count; newline = chunk.indexOf(0x0a, start)) {
          const segment = chunk.subarray(start, newline)
          const line = length ? Buffer.concat([...parts, segment], length + segment.length).toString('utf8') : segment.toString('utf8')
          this.nextOffset = position + newline + 1
          yield { line, offset: lineOffset }
          lineOffset = this.nextOffset
          parts = []
          length = 0
          start = newline + 1
        }
        if (start < count) {
          const segment = chunk.subarray(start, count)
          parts.push(segment)
          length += segment.length
        }
        position += count
      }
      const tail = Buffer.concat(parts, length).toString('utf8')
      if (tail.trim()) {
        try { JSON.parse(tail) }
        catch { this.nextOffset = lineOffset; return }
      }
      this.nextOffset = position
      yield { line: tail, offset: lineOffset }
    } finally {
      closeSync(fd)
    }
  }
}

/** Reading only the first complete line also closes the descriptor on early return. */
export function readJsonlHead(file: string): string | undefined {
  for (const entry of new JsonlFileReader(file)) return entry.line
  return undefined
}

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
