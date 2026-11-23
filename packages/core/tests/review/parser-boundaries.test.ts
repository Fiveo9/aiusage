import { describe, expect, it } from 'vitest'
import type { ParseContext, Parser } from '../../src/types.js'
import { CodexParser } from '../../src/parsers/codex.js'
import { CodeFuseParser } from '../../src/parsers/codefuse.js'
import { QoderParser } from '../../src/parsers/qoder.js'
import { OpenClawParser } from '../../src/parsers/openclaw.js'
import { ClaudeCodeParser } from '../../src/parsers/claude-code.js'
import { CopilotParser } from '../../src/parsers/copilot.js'
import { GrokParser } from '../../src/parsers/grok.js'
import { GenericJsonlParser } from '../../src/parsers/generic-jsonl.js'

const factories = [CodexParser, CodeFuseParser, QoderParser, OpenClawParser, ClaudeCodeParser, CopilotParser, GrokParser]
function context(parser: Parser, lineOffset = 0): ParseContext {
  return { tool: parser.tool, sourceFile: 'synthetic.jsonl', lineOffset, sessionId: 'context-session', now: 1_790_000_000_000, device: 'Synthetic', deviceInstanceId: 'synthetic-instance' }
}
const call = { type: 'response_item', timestamp: 1000, payload: { type: 'function_call', name: 'Read' } }
const usage = { type: 'event_msg', timestamp: 1001, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, output_tokens: 2 } } } }
const qoderCall = { type: 'tool.requested', ts: 1000, loop_id: 'loop', data: { tool_name: 'Read' } }
const qoderUsage = { type: 'model.response.completed', ts: 1001, loop_id: 'loop', data: { model: 'qoder-auto', input_tokens: 5, output_tokens: 2 } }

describe('JSONL parser input boundaries', () => {
  for (const Constructor of factories) {
    it.each(['null', '[]'])(`${Constructor.name} rejects non-object JSON %s`, line => {
      const parser = new Constructor()
      expect(() => parser.parseLine(line, context(parser))).not.toThrow()
      expect(parser.parseLine(line, context(parser))).toBeNull()
    })
  }
  it.each(['null', '[]'])('GenericJsonlParser rejects non-object JSON %s', line => {
    const parser = new GenericJsonlParser('gemini')
    expect(parser.parseLine(line, context(parser))).toBeNull()
  })
  it.each([['Codex', CodexParser], ['Claude Code', ClaudeCodeParser], ['OpenClaw', OpenClawParser]] as const)('%s never returns NaN for an invalid timestamp', (_name, Constructor) => {
    const parser = new Constructor()
    const line = Constructor === CodexParser ? { ...usage, timestamp: 'not-a-time' }
      : { timestamp: 'not-a-time', type: 'assistant', message: { role: 'assistant', model: 'unknown', usage: { input: 1, output: 1, input_tokens: 1, output_tokens: 1 } } }
    const result = parser.parseLine(JSON.stringify(line), context(parser))
    if (result?.record) expect(Number.isFinite(result.record.ts)).toBe(true)
  })
})

describe('incremental finalize and orphan adoption', () => {
  for (const Constructor of [CodexParser, CodeFuseParser, QoderParser]) {
    it(`${Constructor.name} does not finalize historical pending calls again`, () => {
      const parser = new Constructor()
      parser.parseLine(JSON.stringify(Constructor === QoderParser ? qoderCall : call), context(parser))
      expect(parser.finalize(100)).toEqual([])
    })
    it(`${Constructor.name} reports the orphan IDs a completed record adopts`, () => {
      const parser = new Constructor()
      const input = JSON.stringify(Constructor === QoderParser ? qoderCall : call)
      parser.parseLine(input, context(parser))
      const orphan = parser.finalize()[0].toolCalls[0]
      expect(orphan).toMatchObject({ tool: parser.tool })
      parser.parseLine(input, context(parser))
      const result = parser.parseLine(JSON.stringify(Constructor === QoderParser ? qoderUsage : usage), context(parser, 100))
      expect(result).toHaveProperty('replacedToolCallIds', [orphan.id])
    })
  }
  it('Copilot does not finalize historical fallback records again', () => {
    const parser = new CopilotParser()
    parser.parseLine(JSON.stringify(inference()), context(parser))
    expect(parser.finalize(100)).toEqual([])
  })
  it('Copilot reports a previous-poll fallback replaced by a later ChatSpan', () => {
    const parser = new CopilotParser()
    parser.parseLine(JSON.stringify(inference()), context(parser))
    const old = parser.finalize()[0].record!
    parser.parseLine(JSON.stringify(inference()), context(parser))
    expect(parser.parseLine(JSON.stringify({ ...inference(), type: 'span', name: 'chat synthetic' }), context(parser, 100))?.record).not.toBeNull()
    expect(parser.finalize(100).flatMap(result => result.replacedRecordIds || [])).toContain(old.id)
  })
})
function inference() {
  return { type: 'log', traceId: 'synthetic-trace', body: 'GenAI inference: synthetic', attributes: { 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 5, 'gen_ai.request.model': 'gpt-4o-mini', 'gen_ai.response.id': 'synthetic-response' } }
}

describe('usage and field corrections', () => {
  it.each(['completion_tokens_details', 'output_tokens_details'])('extracts included reasoning from %s without counting it twice', detailsKey => {
    const parser = new GenericJsonlParser('gemini')
    const result = parser.parseLine(JSON.stringify({ model: 'gpt-4o-mini', session_id: 'wire-session', usage: { prompt_tokens: 10, completion_tokens: 8, [detailsKey]: { reasoning_tokens: 3 } } }), context(parser))!
    expect(result.record).toMatchObject({ outputTokens: 5, thinkingTokens: 3, sessionId: 'wire-session' })
  })
  it('OpenClaw reads the top-level timestamp and rejects empty tool names', () => {
    const parser = new OpenClawParser()
    const result = parser.parseLine(JSON.stringify({ timestamp: 1000, message: { role: 'assistant', usage: { input: 1, output: 1 }, content: [{ type: 'toolCall', name: '' }, { type: 'toolCall', name: 'Read' }] } }), context(parser))!
    expect(result.record?.ts).toBe(1000)
    expect(result.toolCalls.map(tc => tc.name)).toEqual(['Read'])
  })
  it('OpenClaw stamps orphan calls with their tool', () => {
    const parser = new OpenClawParser()
    const result = parser.parseLine(JSON.stringify({ timestamp: 1000, message: { role: 'assistant', content: [{ type: 'toolCall', name: 'Read' }] } }), context(parser))!
    expect(result.toolCalls[0]).toMatchObject({ tool: 'openclaw' })
  })
  it('OpenClaw adopts missing-time orphans by stable block id and keeps unrelated calls', () => {
    const parser = new OpenClawParser()
    const content = [{ type: 'toolCall', id: 'synthetic-call', name: 'Read' }]
    const orphan = parser.parseLine(JSON.stringify({ message: { role: 'assistant', content } }), context(parser))!
    const unrelated = parser.parseLine(JSON.stringify({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'other-call', name: 'Read' }] } }), context(parser, 50))!
    const result = parser.parseLine(JSON.stringify({ message: { role: 'assistant', content, usage: { input: 1, output: 1 } } }), { ...context(parser, 100), now: 1_790_000_100_000 })!
    expect(result.replacedToolCallIds).toEqual([orphan.toolCalls[0].id])
    expect(result.replacedToolCallIds).not.toContain(unrelated.toolCalls[0].id)
  })
  it('OpenClaw does not guess adoption when no timestamp or stable identity exists', () => {
    const parser = new OpenClawParser()
    const content = [{ type: 'toolCall', name: 'Read' }]
    const orphan = parser.parseLine(JSON.stringify({ message: { role: 'assistant', content } }), context(parser))!
    const result = parser.parseLine(JSON.stringify({ message: { role: 'assistant', content, usage: { input: 1, output: 1 } } }), context(parser, 100))!
    expect(result.replacedToolCallIds ?? []).not.toContain(orphan.toolCalls[0].id)
  })
  it('Grok retains usage observed before the first user-message boundary', () => {
    const parser = new GrokParser()
    parser.parseLine(JSON.stringify({ method: 'session/update', params: { _meta: { totalTokens: 10 }, update: { sessionUpdate: 'agent_message_chunk' } } }), context(parser))
    const result = parser.parseLine(JSON.stringify({ method: 'session/update', params: { update: { sessionUpdate: 'user_message_chunk' } } }), context(parser, 100))
    expect(result?.record?.inputTokens).toBe(10)
  })
})
