/**
* Shares of the home page's token composition bar, in percent.
*
* Thinking (reasoning) tokens are stored apart from output tokens, so a bar
* built from input, output and cache alone would leave them out. They are
* generated tokens billed at the output price, so they are shown in the
* output segment and the four segments add up to the whole total.
* @param {{ outputTokens?: unknown; thinkingTokens?: unknown; } | null | undefined} data
*/
export function displayOutputTokens(data) {
  return (Number(data?.outputTokens) || 0) + (Number(data?.thinkingTokens) || 0)
}

/**
* @param {{ inputTokens?: any; outputTokens?: any; thinkingTokens?: any; cacheReadTokens?: any; cacheWriteTokens?: any; } | null} data
*/
export function tokenComposition(data) {
  const input = Number(data?.inputTokens) || 0
  const output = displayOutputTokens(data)
  const cacheRead = Number(data?.cacheReadTokens) || 0
  const cacheWrite = Number(data?.cacheWriteTokens) || 0
  const total = input + output + cacheRead + cacheWrite
  const pct = (/** @type {number} */ part) => (total > 0 ? (part / total) * 100 : 0)
  return {
    inputPct: pct(input),
    outputPct: pct(output),
    cacheReadPct: pct(cacheRead),
    cacheWritePct: pct(cacheWrite),
  }
}
