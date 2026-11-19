import { describe, expect, it } from 'vitest'
import { completeJsonlInput } from '../../src/jsonl.js'

describe('incremental JSONL boundaries', () => {
  it('retries a partial tail after the writer completes it', () => {
    const prefix = '{"model":"中文"}\r\n'
    const incomplete = prefix + '{"tokens":'
    const first = completeJsonlInput(Buffer.from(incomplete))
    expect(first.nextOffset).toBe(Buffer.byteLength(prefix))
    expect(first.lines.filter(Boolean)).toEqual(['{"model":"中文"}\r'])
    const completed = Buffer.from(incomplete + '123}\n')
    const second = completeJsonlInput(completed.subarray(first.nextOffset))
    expect(second.lines.filter(Boolean)).toEqual(['{"tokens":123}'])
    expect(first.nextOffset + second.nextOffset).toBe(completed.length)
  })

  it('accepts a complete final record without a newline', () => {
    const input = Buffer.from('{"tokens":123}')
    expect(completeJsonlInput(input)).toEqual({ lines: ['{"tokens":123}'], nextOffset: input.length })
  })

  it('does not stall on a malformed terminated line', () => {
    const input = Buffer.from('invalid\n{"tokens":1}\n')
    expect(completeJsonlInput(input).nextOffset).toBe(input.length)
  })

  it('keeps a tail split inside a multibyte UTF-8 character', () => {
    const input = Buffer.from('{"model":"中文"}')
    const split = input.indexOf(Buffer.from('中')) + 1
    expect(completeJsonlInput(input.subarray(0, split)).nextOffset).toBe(0)
    expect(completeJsonlInput(input).nextOffset).toBe(input.length)
  })

  it('handles empty input and blank lines', () => {
    expect(completeJsonlInput(Buffer.alloc(0)).nextOffset).toBe(0)
    expect(completeJsonlInput(Buffer.from('\r\n\n')).nextOffset).toBe(3)
  })
})
