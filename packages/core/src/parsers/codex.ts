import type { Parser, ParseResult, ParseContext } from '../types.js'
import type { StatsRecord, ToolCallRecord, Tool } from '../types.js'
import { recordIdFor, generateToolCallId, generateOrphanToolCallId } from '../record-id.js'
import { inferProvider } from '../provider.js'
import { calculateCost } from '../pricing.js'
import { parseTimestamp } from '../timestamp.js'

interface PendingToolCall {
  name: string
  ts: number
  lineOffset: number
  orphanId: string
}

export class CodexParser implements Parser {
  readonly tool: Tool = 'codex'
  private pendingToolCalls: PendingToolCall[] = []
  private currentModel: string | null = null

  parseLine(line: string, context: ParseContext): ParseResult | null {
    let parsed: any
    try {
      parsed = JSON.parse(line)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

    // Support multiple formats:
    //   { event_msg: { payload: ... } }        — oldest wrapped format
    //   { type: 'event_msg', payload: ... }     — unwrapped event_msg
    //   { type: 'response_item', payload: ... } — newer format (function_call lives here)
    const payload = parsed.event_msg?.payload
      ?? (parsed.type === 'event_msg' || parsed.type === 'response_item' ? parsed.payload : undefined)

    // Track model from turn_context events (top-level or wrapped)
    const turnCtx = parsed.type === 'turn_context' ? parsed.payload : undefined
    if (typeof turnCtx?.model === 'string' && turnCtx.model) {
      this.currentModel = turnCtx.model
    }
    if (payload?.type === 'turn_context' && typeof payload.model === 'string' && payload.model) {
      this.currentModel = payload.model
    }

    if (!payload) return null

    // Skip non-token_count/function_call lines
    if (payload.type !== 'token_count' && payload.type !== 'function_call') return null

    // Store function_call as pending
    if (payload.type === 'function_call') {
      const rawFcTs = parsed.event_msg?.timestamp ?? parsed.timestamp
      const ts = parseTimestamp(rawFcTs, rawFcTs == null ? context.now : NaN, 'ms')
      if (!Number.isFinite(ts)) return null
      const rawName = payload.name ?? payload.function?.name
      const name = typeof rawName === 'string' && rawName ? rawName : 'unknown'
      this.pendingToolCalls.push({
        // newer format: payload.name; older format: payload.function.name
        name, ts, lineOffset: context.lineOffset,
        orphanId: generateOrphanToolCallId(this.tool, rawFcTs == null ? `${recordIdFor(context, context.sourceFile, context.lineOffset)}:${name}` : name,
          rawFcTs == null ? 0 : ts, this.pendingToolCalls.length),
      })
      return null
    }

    // Process token_count — support both old format (payload.last_token_usage) and new format (payload.info.last_token_usage)
    const usage = payload.last_token_usage ?? payload.info?.last_token_usage
    if (!usage) {
      return null
    }

    const rawModel = payload.model ?? parsed.model ?? this.currentModel
    const model = typeof rawModel === 'string' && rawModel ? rawModel : 'unknown'
    const rawTs = parsed.event_msg?.timestamp ?? parsed.timestamp ?? context.now
    const ts = parseTimestamp(rawTs, NaN, 'ms')
    if (!Number.isFinite(ts)) return null

    // Codex reports input_tokens inclusive of cached_input_tokens. Store only the
    // uncached part so cached tokens are not counted (and priced) twice.
    const cacheReadTokens = usage.cached_input_tokens ?? 0
    const inputTokens = Math.max(0, (usage.input_tokens ?? 0) - cacheReadTokens)
    // Codex also reports output_tokens inclusive of reasoning_output_tokens
    // (total_tokens = input_tokens + output_tokens). Totals sum the output and
    // thinking columns and pricing charges both at the output price, so store
    // only the non-reasoning part as output.
    const thinkingTokens = usage.reasoning_output_tokens ?? 0
    const outputTokens = Math.max(0, (usage.output_tokens ?? 0) - thinkingTokens)
    const cacheWriteTokens = 0 // Codex doesn't provide this

    const cost = model === 'unknown' ? 0 : calculateCost(model, {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      thinkingTokens,
    }, context.exchangeRate)

    const costSource = model === 'unknown' ? 'unknown' as const : 'pricing' as const
    const provider = inferProvider(model)

    const recordId = recordIdFor(context, context.sourceFile, context.lineOffset)

    const record: StatsRecord = {
      id: recordId,
      ts,
      ingestedAt: context.now,
      updatedAt: context.now,
      lineOffset: context.lineOffset,
      tool: this.tool,
      model,
      provider,
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

    // Associate pending tool calls
    const toolCalls: ToolCallRecord[] = this.pendingToolCalls.map((tc, callIndex) => ({
      id: generateToolCallId(recordId, tc.name, tc.ts, callIndex),
      recordId,
      name: tc.name,
      ts: tc.ts,
      callIndex,
    }))

    const replacedToolCallIds = this.pendingToolCalls.map(tc => tc.orphanId)
    // Clear pending queue
    this.pendingToolCalls = []

    return { record, toolCalls, ...(replacedToolCallIds.length ? { replacedToolCallIds } : {}) }
  }

  finalize(replayCutoff = 0): ParseResult[] {
    this.currentModel = null
    // Handle orphan tool calls (no subsequent token_count)
    if (this.pendingToolCalls.length === 0) return []

    const toolCalls: ToolCallRecord[] = this.pendingToolCalls.map((tc, callIndex) => ({
      id: tc.orphanId,
      recordId: null,
      tool: this.tool,
      name: tc.name,
      ts: tc.ts,
      callIndex,
    })).filter((_, index) => this.pendingToolCalls[index].lineOffset >= replayCutoff)

    this.pendingToolCalls = []

    return toolCalls.length ? [{ record: null, toolCalls }] : []
  }
}
