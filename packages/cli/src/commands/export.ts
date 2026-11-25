import type Database from 'better-sqlite3'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface ExportOptions {
  /** Inclusive lower bound on `ts`, in ms since epoch. */
  startTs?: number
  /** Exclusive upper bound on `ts`, in ms since epoch. */
  endTs?: number
}

function exportTimestamp(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (typeof value === 'string' && !value.trim()) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportData(db: Database.Database, format: 'csv' | 'json' | 'ndjson', options?: ExportOptions): string {
  return [...exportDataChunks(db, format, options)].join('')
}

/** Compatibility exportData may buffer; real output consumers use these bounded row chunks. */
export function* exportDataChunks(db: Database.Database, format: 'csv' | 'json' | 'ndjson', options?: ExportOptions): Generator<string> {
  const timeWhere = [
    typeof options?.startTs === 'number' ? 'ts >= @startTs' : '',
    typeof options?.endTs === 'number' ? 'ts < @endTs' : '',
  ].filter(Boolean).join(' AND ')
  const timeParam = {
    ...(typeof options?.startTs === 'number' ? { startTs: options.startTs } : {}),
    ...(typeof options?.endTs === 'number' ? { endTs: options.endTs } : {}),
  }
  // Table order, as an export without bounds has always had: with a `ts` bound
  // SQLite reads through the `ts DESC` index and would return newest first.
  const records = db.prepare(`SELECT * FROM records${timeWhere ? ` WHERE ${timeWhere}` : ''} ORDER BY rowid`).iterate(timeParam) as Iterable<any>

  if (format === 'csv') {
    const headers = 'timestamp,tool,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,thinking_tokens,cost,cost_source,session_id,device,device_instance_id'
    yield headers
    for (const r of records) {
      yield '\r\n' + [exportTimestamp(r.ts), r.tool, r.model, r.provider, r.input_tokens, r.output_tokens, r.cache_read_tokens,
        r.cache_write_tokens, r.thinking_tokens, r.cost, r.cost_source, r.session_id, r.device, r.device_instance_id].map(csvCell).join(',')
    }
    return
  }

  if (format === 'json') {
    let first = true
    for (const r of records) {
      yield first ? '[\n' : ',\n'
      const data = {
      timestamp: exportTimestamp(r.ts),
      tool: r.tool,
      model: r.model,
      provider: r.provider,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      thinkingTokens: r.thinking_tokens,
      cost: r.cost,
      costSource: r.cost_source,
      sessionId: r.session_id,
      device: r.device,
      deviceInstanceId: r.device_instance_id,
      }
      yield JSON.stringify(data, null, 2).split('\n').map(line => `  ${line}`).join('\n')
      first = false
    }
    yield first ? '[]' : '\n]'
    return
  }

  // ndjson
  let first = true
  for (const r of records) {
    if (!first) yield '\n'
    yield JSON.stringify({
    id: r.id,
    ts: r.ts,
    tool: r.tool,
    model: r.model,
    provider: r.provider,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    thinkingTokens: r.thinking_tokens,
    cost: r.cost,
    costSource: r.cost_source,
    sessionKey: r.session_id,
    device: r.device,
    deviceInstanceId: r.device_instance_id,
    updatedAt: r.updated_at,
    })
    first = false
  }
}

export async function writeExportData(
  db: Database.Database, format: 'csv' | 'json' | 'ndjson', output: Writable,
  options?: ExportOptions, trailingNewline = false,
): Promise<void> {
  function* chunks() { yield* exportDataChunks(db, format, options); if (trailingNewline) yield '\n' }
  if (output !== process.stdout) { await pipeline(Readable.from(chunks()), output); return }
  // pipeline retains listeners on its destination. A disposable proxy keeps
  // repeated stdout exports bounded and never ends/destroys the actual stdout.
  const proxy = new Writable({
    write(chunk, encoding, callback) {
      try { output.write(chunk, encoding, callback) }
      catch (error) { callback(error as Error) }
    },
  })
  const onError = (error: Error) => proxy.destroy(error)
  output.on('error', onError)
  try { await pipeline(Readable.from(chunks()), proxy) }
  finally { output.off('error', onError) }
}
