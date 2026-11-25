import { describe, expect, it } from 'vitest'
import { Aggregator } from '../src/aggregator.js'
import { compileModelPriceMatcher, resolveModelPriceMatch } from '../src/pricing.js'
import type { ParseContext, Tool } from '../src/types.js'

function context(tool: Tool, lineOffset = 0, replayCutoff = 0): ParseContext {
  return {
    tool, lineOffset, replayCutoff, sourceFile: '/synthetic/session/updates.jsonl',
    sessionId: 'session', device: 'test', deviceInstanceId: 'test-instance', now: 1_700_000_000_000,
    recordId: (seed, offset) => `${seed}:${offset}`,
  }
}

describe('F19 resumable parser state', () => {
  it.each(['codex', 'codefuse'] as const)('%s restores model and adopts the original orphan', (tool) => {
    const first = new Aggregator()
    first.parseLine(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-sol' } }), context(tool))
    first.parseLine(JSON.stringify({ type: 'response_item', timestamp: 1_700_000_000_000,
      payload: { type: 'function_call', name: 'Read', arguments: 'PRIVATE_SENTINEL' } }), context(tool, 10))
    const state = JSON.parse(JSON.stringify(first.getState(tool)))
    const orphan = first.finalize()[0].toolCalls[0]
    expect(JSON.stringify(state)).not.toContain('PRIVATE_SENTINEL')
    const second = new Aggregator()
    expect(second.restoreState(tool, state, context(tool, 1000, 1000))).toBe(true)
    const result = second.parseLine(JSON.stringify({ type: 'event_msg', timestamp: 1_700_000_001_000,
      payload: { type: 'token_count', last_token_usage: { input_tokens: 30, output_tokens: 10 } } }), context(tool, 1000, 1000))!
    expect(result.record?.model).toBe('gpt-6-sol')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.replacedToolCallIds).toEqual([orphan.id])
    expect(second.finalize(1000)).toEqual([])
  })

  it('restores Qoder pending calls by loop without persisting arguments', () => {
    const first = new Aggregator()
    first.parseLine(JSON.stringify({ type: 'tool.requested', loop_id: 'loop', ts: 1_700_000_000_000,
      data: { tool_name: 'Read', arguments: 'PRIVATE_SENTINEL' } }), context('qoder', 10))
    const state = JSON.parse(JSON.stringify(first.getState('qoder')))
    const orphan = first.finalize()[0].toolCalls[0]
    expect(JSON.stringify(state)).not.toContain('PRIVATE_SENTINEL')
    const second = new Aggregator()
    expect(second.restoreState('qoder', state, context('qoder', 1000, 1000))).toBe(true)
    const result = second.parseLine(JSON.stringify({ type: 'model.response.completed', loop_id: 'loop', ts: 1_700_000_001_000,
      data: { model: 'qoder-auto', input_tokens: 10, output_tokens: 5 } }), context('qoder', 1000, 1000))!
    expect(result.replacedToolCallIds).toEqual([orphan.id])
    expect(result.toolCalls[0].recordId).toBe(result.record!.id)
  })

  function grok(total?: number, user = false) {
    return JSON.stringify({ method: 'session/update', params: { sessionId: 'session', _meta: { modelId: 'grok-4', totalTokens: total },
      update: { sessionUpdate: user ? 'user_message_chunk' : 'agent_message_chunk', content: 'PRIVATE_SENTINEL' } } })
  }

  it('restores the active Grok turn under its original record id', () => {
    const first = new Aggregator()
    first.parseLine(grok(undefined, true), context('grok', 0))
    first.parseLine(grok(100), context('grok', 10))
    const state = JSON.parse(JSON.stringify(first.getState('grok')))
    const original = first.finalize()[0].record!
    expect(JSON.stringify(state)).not.toContain('PRIVATE_SENTINEL')
    const second = new Aggregator()
    expect(second.restoreState('grok', state, context('grok', 1000, 1000))).toBe(true)
    second.parseLine(grok(180), context('grok', 1000, 1000))
    expect(second.finalize(1000)[0].record).toMatchObject({ id: original.id, inputTokens: 180 })
  })

  it('does not charge the Grok cumulative baseline again on a new turn', () => {
    const first = new Aggregator()
    first.parseLine(grok(undefined, true), context('grok', 0))
    first.parseLine(grok(100), context('grok', 10))
    const state = JSON.parse(JSON.stringify(first.getState('grok')))
    first.finalize()
    const second = new Aggregator()
    expect(second.restoreState('grok', state, context('grok', 1000, 1000))).toBe(true)
    expect(second.parseLine(grok(undefined, true), context('grok', 1000, 1000))).toBeNull()
    second.parseLine(grok(180), context('grok', 1100, 1000))
    expect(second.finalize(1000)[0].record?.inputTokens).toBe(80)
  })

  function copilot(chat: boolean) {
    return JSON.stringify({ traceId: 'trace', ...(chat ? { type: 'span', name: 'chat test' } : {}), body: 'PRIVATE_SENTINEL',
      attributes: { 'event.name': 'copilot_chat.agent.turn', 'gen_ai.operation.name': chat ? 'chat' : 'invoke_agent',
        'gen_ai.usage.input_tokens': 30, 'gen_ai.response.model': 'gpt-6-sol', 'gen_ai.response.id': 'response' } })
  }

  it('retires the previous Copilot fallback when an appended ChatSpan wins', () => {
    const first = new Aggregator()
    first.parseLine(copilot(false), context('copilot', 10))
    const state = JSON.parse(JSON.stringify(first.getState('copilot')))
    const fallbackId = first.finalize()[0].record!.id
    expect(JSON.stringify(state)).not.toContain('PRIVATE_SENTINEL')
    expect(JSON.stringify(state)).not.toContain('inputTokens')
    const second = new Aggregator()
    expect(second.restoreState('copilot', state, context('copilot', 1000, 1000))).toBe(true)
    expect(second.parseLine(copilot(true), context('copilot', 1000, 1000))?.record).not.toBeNull()
    expect(second.finalize(1000)).toEqual([{ record: null, toolCalls: [], replacedRecordIds: [fallbackId] }])
  })

  it('does not emit appended lower-priority Copilot usage already covered by a ChatSpan', () => {
    const first = new Aggregator()
    first.parseLine(copilot(true), context('copilot', 10))
    const state = JSON.parse(JSON.stringify(first.getState('copilot')))
    first.finalize()
    const second = new Aggregator()
    expect(second.restoreState('copilot', state, context('copilot', 1000, 1000))).toBe(true)
    second.parseLine(copilot(false), context('copilot', 1000, 1000))
    expect(second.finalize(1000)).toEqual([])
  })

  it('rejects unsupported, mismatched, and malformed snapshots for a safe full replay', () => {
    const aggregator = new Aggregator()
    expect(aggregator.restoreState('codex', { version: 99, tool: 'codex', data: {} }, context('codex', 1000, 1000))).toBe(false)
    expect(aggregator.restoreState('codex', { version: 1, tool: 'qoder', data: {} }, context('codex', 1000, 1000))).toBe(false)
    expect(aggregator.restoreState('codex', { version: 1, tool: 'codex', data: { currentModel: null, pendingToolCalls: [{ name: 'Read' }] } }, context('codex', 1000, 1000))).toBe(false)
  })
})

describe('F19 compiled price matching', () => {
  it('enumerates a snapshot once and retains exact, case, provider, and longest-prefix precedence', () => {
    let enumerations = 0
    const data = Object.assign(Object.create(null), { 'gpt': 1, 'gpt-6': 2, 'GPT-6': 3, 'glm-5': 4, constructor: 5 })
    const table = new Proxy(data, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target) } })
    const matcher = compileModelPriceMatcher(table)
    const afterCompile = enumerations
    for (const name of ['gpt-6', 'GpT-6', 'gpt-6-sol', 'z-ai/glm-5', 'constructor', 'missing']) {
      expect(matcher(name)).toEqual(resolveModelPriceMatch(name, data))
    }
    expect(enumerations).toBe(afterCompile)
    expect(afterCompile).toBeLessThanOrEqual(2)
  })

  it('keeps the uncached compatibility matcher responsive to mutable tables', () => {
    const table = { 'gpt-6': 1 }
    expect(resolveModelPriceMatch('gpt-6-sol', table)?.entry).toBe(1)
    table['gpt-6'] = 2
    expect(resolveModelPriceMatch('gpt-6-sol', table)?.entry).toBe(2)
  })

  it('keeps non-enumerable own exact keys without promoting them to prefix entries', () => {
    const table = Object.create(null)
    Object.defineProperty(table, 'constructor', { value: 9 })
    const matcher = compileModelPriceMatcher(table)
    expect(matcher('constructor')?.entry).toBe(9)
    expect(matcher('constructor-suffix')).toBeUndefined()
  })

  it('does not evaluate unrelated getters in the mutable-table compatibility API', () => {
    const table = { 'gpt-6': 2 }
    Object.defineProperty(table, 'unrelated', { enumerable: true, get() { throw new Error('Unrelated price must not be evaluated') } })
    expect(resolveModelPriceMatch('gpt-6', table)?.entry).toBe(2)
    expect(resolveModelPriceMatch('gpt-6-sol', table)?.entry).toBe(2)
  })
})
