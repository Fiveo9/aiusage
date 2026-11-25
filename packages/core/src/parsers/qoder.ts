import type { Parser, ParseResult, ParseContext } from '../types.js'
import type { StatsRecord, Tool, ToolCallRecord } from '../types.js'
import { recordIdFor, generateToolCallId, generateOrphanToolCallId } from '../record-id.js'
import { inferProvider } from '../provider.js'
import { calculateCost, resolvePrice } from '../pricing.js'
import { normalizeQoderModel } from '../qoder-model.js'
import { parseTimestamp } from '../timestamp.js'
import { isStateObject, readPendingCalls } from '../parser-state.js'

interface PendingToolCall {
  name: string
  ts: number
  lineOffset: number
  orphanId: string
}

function toNumber(value: unknown): number {
  if (value == null) return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function toTimestamp(value: unknown, fallback: number): number {
  return parseTimestamp(value, value == null ? fallback : NaN, 'ms')
}

export class QoderParser implements Parser {
  readonly tool: Tool = 'qoder'
  private pendingToolCallsByLoopId = new Map<string, PendingToolCall[]>()

  getState(): unknown {
    return { pendingByLoop: [...this.pendingToolCallsByLoopId].map(([loop, calls]) => [loop, calls.map(call => ({ ...call }))]) }
  }

  restoreState(state: unknown, context: ParseContext): boolean {
    if (!isStateObject(state) || !Array.isArray(state.pendingByLoop)) return false
    const pending = new Map<string, PendingToolCall[]>()
    for (const pair of state.pendingByLoop) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') return false
      const calls = readPendingCalls(pair[1], context.replayCutoff ?? 0)
      if (!calls) return false
      pending.set(pair[0], calls)
    }
    this.pendingToolCallsByLoopId = pending
    return true
  }

  parseLine(line: string, context: ParseContext): ParseResult | null {
    let parsed: any
    try {
      parsed = JSON.parse(line)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

    if (parsed.type === 'tool.requested') {
      const loopId = parsed.loop_id ?? parsed.turn_id
      const toolName = parsed.data?.tool_name
      if (typeof loopId !== 'string' || typeof toolName !== 'string' || !toolName) {
        return null
      }

      const pending = this.pendingToolCallsByLoopId.get(loopId) ?? []
      const ts = toTimestamp(parsed.ts, context.now)
      if (!Number.isFinite(ts)) return null
      pending.push({
        name: toolName,
        ts, lineOffset: context.lineOffset,
        orphanId: generateOrphanToolCallId(this.tool, parsed.ts == null ? `${recordIdFor(context, context.sourceFile, context.lineOffset)}:${toolName}` : toolName,
          parsed.ts == null ? 0 : ts, pending.length),
      })
      this.pendingToolCallsByLoopId.set(loopId, pending)
      return null
    }

    if (parsed.type !== 'model.response.completed') return null

    const data = parsed.data
    if (!data || typeof data !== 'object') return null

    const ts = toTimestamp(parsed.ts, context.now)
    if (!Number.isFinite(ts)) return null
    const rawModel = normalizeQoderModel(String(data.model ?? ''))
    const model = rawModel === 'unknown' ? 'qoder-auto' : rawModel
    const inputTokens = toNumber(data.input_tokens)
    const outputTokens = toNumber(data.output_tokens)
    const cacheReadTokens = toNumber(data.cache_read_input_tokens ?? data.cache_read_tokens)
    const cacheWriteTokens = toNumber(data.cache_creation_input_tokens ?? data.cache_write_input_tokens ?? data.cache_write_tokens)
    const thinkingTokens = toNumber(data.thinking_tokens)
      || toNumber(data.reasoning_tokens)
      || toNumber(data.reasoning_output_tokens)

    if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + thinkingTokens === 0) {
      return null
    }

    const hasPrice = resolvePrice(model) != null
    const cost = hasPrice ? calculateCost(model, {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      thinkingTokens,
    }, context.exchangeRate) : 0
    const costSource = hasPrice ? 'pricing' as const : 'unknown' as const
    const recordId = recordIdFor(context, context.sourceFile, context.lineOffset)

    const record: StatsRecord = {
      id: recordId,
      ts,
      ingestedAt: context.now,
      updatedAt: context.now,
      lineOffset: context.lineOffset,
      tool: this.tool,
      model,
      provider: inferProvider(model),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      thinkingTokens,
      cost,
      costSource,
      sessionId: context.sessionId,
      sourceFile: context.sourceFile,
      device: context.device,
      deviceInstanceId: context.deviceInstanceId,
      platform: context.platform,
    }

    const loopId = parsed.loop_id ?? parsed.turn_id
    const pendingToolCalls = typeof loopId === 'string'
      ? this.pendingToolCallsByLoopId.get(loopId) ?? []
      : []
    if (typeof loopId === 'string') {
      this.pendingToolCallsByLoopId.delete(loopId)
    }

    const toolCalls: ToolCallRecord[] = pendingToolCalls.map((tc, callIndex) => ({
      id: generateToolCallId(recordId, tc.name, tc.ts, callIndex),
      recordId,
      name: tc.name,
      ts: tc.ts,
      callIndex,
    }))

    return { record, toolCalls, ...(pendingToolCalls.length ? { replacedToolCallIds: pendingToolCalls.map(tc => tc.orphanId) } : {}) }
  }

  finalize(replayCutoff = 0): ParseResult[] {
    const toolCalls: ToolCallRecord[] = []

    for (const pending of this.pendingToolCallsByLoopId.values()) {
      for (const [callIndex, tc] of pending.entries()) {
        if (tc.lineOffset < replayCutoff) continue
        toolCalls.push({
          id: tc.orphanId,
          recordId: null,
          tool: this.tool,
          name: tc.name,
          ts: tc.ts,
          callIndex,
        })
      }
    }

    this.pendingToolCallsByLoopId.clear()
    return toolCalls.length > 0 ? [{ record: null, toolCalls }] : []
  }
}
