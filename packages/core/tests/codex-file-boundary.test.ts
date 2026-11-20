import { expect, it } from 'vitest'
import { CodexParser } from '../src/parsers/codex.js'
import type { ParseContext } from '../src/types.js'

const context: ParseContext = {
  sourceFile: 'synthetic-a.jsonl', lineOffset: 0, sessionId: 'a', tool: 'codex',
  now: 1, device: 'synthetic', deviceInstanceId: 'synthetic',
}
const usage = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count',
  last_token_usage: { input_tokens: 10, output_tokens: 20 } } })
const model = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-4o' } })

it('retains model within a file, then clears it even without orphan calls', () => {
  const parser = new CodexParser()
  parser.parseLine(model, context)
  expect(parser.parseLine(usage, context)?.record?.model).toBe('gpt-4o')
  expect(parser.finalize()).toEqual([])
  const next = parser.parseLine(usage, { ...context, sourceFile: 'synthetic-b.jsonl' })
  expect(next?.record).toMatchObject({ model: 'unknown', cost: 0, costSource: 'unknown' })
})

it('emits orphans once and clears both pending calls and model at the boundary', () => {
  const parser = new CodexParser()
  parser.parseLine(model, context)
  parser.parseLine(JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'synthetic' } }), context)
  expect(parser.finalize()[0].toolCalls).toHaveLength(1)
  expect(parser.finalize()).toEqual([])
  expect(parser.parseLine(usage, { ...context, sourceFile: 'synthetic-b.jsonl' }))
    .toMatchObject({ record: { model: 'unknown' }, toolCalls: [] })
})
