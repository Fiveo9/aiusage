import type { Tool, ParseContext, ParseResult, RecordIdBuilder, ParserSnapshot } from './types.js'
import { isStateObject } from './parser-state.js'
import type { Parser } from './parsers/index.js'
import { ClaudeCodeParser } from './parsers/claude-code.js'
import { CodexParser } from './parsers/codex.js'
import { CodeFuseParser } from './parsers/codefuse.js'
import { OpenClawParser } from './parsers/openclaw.js'
import { QoderParser } from './parsers/qoder.js'
import { CopilotParser } from './parsers/copilot.js'
import { GenericJsonlParser } from './parsers/generic-jsonl.js'
import { GrokParser } from './parsers/grok.js'

export interface CreateContextOptions {
  replayCutoff?: number
  tool: Tool
  sourceFile: string
  lineOffset: number
  sessionId: string
  device: string
  deviceInstanceId: string
  platform?: string
  exchangeRate?: number
  recordId?: RecordIdBuilder
}

export class Aggregator {
  private parsers: Map<Tool, Parser>
  private activeParser: Parser | null = null

  constructor() {
    this.parsers = new Map([
      ['claude-code', new ClaudeCodeParser()],
      ['codex', new CodexParser()],
      ['codefuse', new CodeFuseParser()],
      ['openclaw', new OpenClawParser()],
      ['qoder', new QoderParser()],
      ['copilot', new CopilotParser()],
      ['gemini', new GenericJsonlParser('gemini', 'gemini-unknown')],
      ['kimi', new GenericJsonlParser('kimi', 'kimi-for-coding')],
      ['codebuddy', new GenericJsonlParser('codebuddy', 'codebuddy-unknown')],
      ['grok', new GrokParser()],
      ['antigravity', new GenericJsonlParser('antigravity', 'antigravity-unknown')],
      ['omp', new GenericJsonlParser('omp', 'omp-unknown')],
      ['pi', new GenericJsonlParser('pi', 'pi-unknown')],
      ['craft', new GenericJsonlParser('craft', 'craft-unknown')],
      ['droid', new GenericJsonlParser('droid', 'droid-unknown')],
    ])
  }

  createContext(options: CreateContextOptions): ParseContext {
    return {
      ...options,
      now: Date.now(),
    }
  }

  parseLine(line: string, context: ParseContext): ParseResult | null {
    // Get or create parser for this tool
    if (!this.activeParser || this.activeParser.tool !== context.tool) {
      this.activeParser = this.parsers.get(context.tool) ?? null
    }

    if (!this.activeParser) {
      return null
    }

    try { return this.activeParser.parseLine(line, context) }
    catch { return null } // A malformed line must not discard the rest of its file.
  }

  finalize(replayCutoff = 0): ParseResult[] {
    const results: ParseResult[] = []
    for (const parser of this.parsers.values()) {
      if (parser.finalize) {
        results.push(...parser.finalize(replayCutoff))
      }
    }
    return results
  }

  hasState(tool: Tool): boolean {
    return typeof this.parsers.get(tool)?.restoreState === 'function'
  }

  getState(tool: Tool): ParserSnapshot | undefined {
    const parser = this.parsers.get(tool)
    return parser?.getState ? { version: 1, tool, data: parser.getState() } : undefined
  }

  restoreState(tool: Tool, snapshot: unknown, context: ParseContext): boolean {
    if (!isStateObject(snapshot) || snapshot.version !== 1 || snapshot.tool !== tool || context.tool !== tool) return false
    try { return this.parsers.get(tool)?.restoreState?.(snapshot.data, context) === true }
    catch { return false }
  }
}
