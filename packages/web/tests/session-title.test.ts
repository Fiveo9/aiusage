import { describe, expect, it } from 'vitest'
import { sessionLabel } from '../src/lib/session-title.js'

describe('session title display', () => {
  it('prefers the real title and preserves punctuation and Unicode', () => {
    expect(sessionLabel({ sessionTitle: '  修复 UI / API：会话标题  ', sessionId: '1234567890' }, '未命名会话'))
      .toBe('修复 UI / API：会话标题')
  })
  it('falls back to an unnamed label and the first eight ID characters', () => {
    for (const sessionTitle of [undefined, null, '', '  ', 42]) {
      expect(sessionLabel({ sessionTitle, sessionId: '019abcde-1234-5678' }, '未命名会话'))
        .toBe('未命名会话 · 019abcde')
    }
  })
  it('handles short or missing IDs and the English label', () => {
    expect(sessionLabel({ sessionId: 's1' }, 'Unnamed session')).toBe('Unnamed session · s1')
    expect(sessionLabel({}, '未命名会话')).toBe('未命名会话')
  })
  it('uses the UUID rather than the date prefix in legacy Codex IDs', () => {
    expect(sessionLabel({ sessionId: '2026-11-20T01-02-03-019abcde-1234-5678-90ab-1234567890ab' }, '未命名会话'))
      .toBe('未命名会话 · 019abcde')
  })
})
