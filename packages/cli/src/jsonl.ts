/** Return only complete JSONL input, keeping an unfinished tail for the next poll. */
export function completeJsonlInput(buffer: Buffer): { lines: string[]; nextOffset: number } {
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
  return { lines: buffer.subarray(0, nextOffset).toString('utf8').split('\n'), nextOffset }
}
