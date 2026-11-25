import http from 'node:http'
import path from 'node:path'
import { hostname, platform, tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { resolveExchangeRate } from '@aiusage/core'
import { loadConfig } from '../config.js'
import { discoverTools } from '../discovery.js'
import { isKelivoSourceFile, runParseKelivo } from '../commands/parse-kelivo.js'
import { insertChangedRecords, recordIdsForReread } from '../db/records.js'
import type { DetectedTool } from '../discovery.js'
import { BodyTooLargeError, readBodyBuffer } from './request-body.js'
import { json } from './http-helpers.js'
import type { ApiRouteContext } from './context.js'

function getManualImportMetadata(db: Database.Database): Record<string, { lastImportedAt: number }> {
  const rows = db.prepare(`
    SELECT tool, MAX(ingested_at) AS lastImportedAt
    FROM records
    WHERE tool IN ('kelivo')
    GROUP BY tool
  `).all() as Array<{ tool: string; lastImportedAt: number | null }>

  const metadata: Record<string, { lastImportedAt: number }> = {}
  for (const row of rows) {
    if (typeof row.lastImportedAt === 'number') {
      metadata[row.tool] = { lastImportedAt: row.lastImportedAt }
    }
  }
  return metadata
}

function attachManualImportMetadata(tools: DetectedTool[], db: Database.Database): DetectedTool[] {
  const metadata = getManualImportMetadata(db)
  return tools.map((tool) => {
    const toolMetadata = metadata[tool.tool]
    return toolMetadata ? { ...tool, ...toolMetadata } : tool
  })
}

function countExistingRecordIds(db: Database.Database, ids: string[]): number {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return 0

  const stmt = db.prepare('SELECT 1 FROM records WHERE id = ? LIMIT 1')
  let count = 0
  for (const id of uniqueIds) {
    if (stmt.get(id)) count++
  }
  return count
}

function multipartBoundary(contentType: string | string[] | undefined): string | null {
  const value = Array.isArray(contentType) ? contentType[0] : contentType
  if (!value) return null
  const match = value.match(/(?:^|;)\s*boundary=("([^"]+)"|[^;]+)/i)
  if (!match) return null
  return (match[2] ?? match[1]).replace(/^"|"$/g, '')
}

async function readMultipartFile(req: http.IncomingMessage): Promise<{ filename: string; data: Buffer } | null> {
  const maxFileBytes = 64 * 1024 * 1024
  const maxBodyBytes = maxFileBytes + 64 * 1024
  if (Number(req.headers['content-length']) > maxBodyBytes) {
    req.pause()
    throw new BodyTooLargeError()
  }
  const boundary = multipartBoundary(req.headers['content-type'])
  if (!boundary) return null

  const body = await readBodyBuffer(req, maxBodyBytes)
  const marker = Buffer.from(`--${boundary}`)
  let position = body.indexOf(marker)
  while (position !== -1) {
    position += marker.length
    if (body.subarray(position, position + 2).toString() === '--') return null
    if (body.subarray(position, position + 2).toString() === '\r\n') position += 2

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), position)
    if (headerEnd === -1) return null
    const headers = body.subarray(position, headerEnd).toString('utf-8')
    const filenameMatch = headers.match(/Content-Disposition:[^\r\n]*\bname="file"[^\r\n]*\bfilename="([^"]+)"/i)
    const dataStart = headerEnd + 4
    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), dataStart)
    if (nextBoundary === -1) return null
    if (filenameMatch) {
      const data = body.subarray(dataStart, nextBoundary)
      if (data.length > maxFileBytes) throw new BodyTooLargeError()
      return { filename: path.basename(filenameMatch[1]), data }
    }
    position = body.indexOf(marker, nextBoundary)
  }
  return null
}

function isKelivoBackupFilename(filename: string): boolean {
  return isKelivoSourceFile(filename)
}

export async function handleImportRoute(context: ApiRouteContext): Promise<boolean> {
  const { services, req, res, url } = context
  const { db, options, runDbWrite } = services
// ── /api/detected-tools ──────────────────────────────────────
  if (url.pathname === '/api/detected-tools' && req.method === 'GET') {
    const tools = attachManualImportMetadata(discoverTools(), db)
    json(res, { tools })
    return true
  }

  // ── /api/import/kelivo ────────────────────────────────────────
  if (url.pathname === '/api/import/kelivo' && req.method === 'POST') {
    let tempDir: string | null = null
    try {
      const upload = await readMultipartFile(req)
      if (!upload) {
        json(res, { error: { code: 'INVALID_UPLOAD', message: 'Missing uploaded file' } }, 400)
        return true
      }
      if (!isKelivoBackupFilename(upload.filename)) {
        json(res, { error: { code: 'INVALID_FILE', message: 'Upload a Kelivo .zip backup, chats.json, or Kelivo database (.db/.sqlite)' } }, 400)
        return true
      }

      tempDir = mkdtempSync(path.join(tmpdir(), 'aiusage-kelivo-'))
      const tempPath = path.join(tempDir, upload.filename)
      writeFileSync(tempPath, upload.data)

      const cfg = loadConfig()
      const now = Date.now()
      const deviceInstanceId = options?.currentDeviceInstanceId ?? 'unknown'
      // A message imported before this installation had a device id keeps
      // the record it was stored under (see recordIdsForReread), which can
      // fold a copy into it, so the backup is read in the write queue.
      const result = await runDbWrite(() => runParseKelivo({
        filePath: tempPath,
        device: cfg?.device || hostname() || `${platform()}-${process.arch}`,
        deviceInstanceId,
        recordId: recordIdsForReread(db, deviceInstanceId).recordId,
        platform: cfg?.platform ?? platform(),
        now,
        exchangeRate: resolveExchangeRate(cfg ?? {}),
      }))
      if (result.errors.length > 0 && result.records.length === 0) {
        json(res, { error: { code: 'IMPORT_FAILED', message: result.errors[0] }, errors: result.errors }, 400)
        return true
      }

      // The upload lives in a temp directory here; report the name the user
      // picked instead of this machine's temp path.
      const forUser = (message: string) => message.split(tempPath).join(upload.filename)

      const existingCount = await runDbWrite(() => {
        const existingCount = countExistingRecordIds(db, result.records.map((record) => record.id))
        // Ignore temp-path-only differences so an unchanged upload is not
        // queued for sync again, while still recording the manual import.
        insertChangedRecords(db, result.records)
        const stampImport = db.prepare('UPDATE records SET ingested_at = ? WHERE id = ?')
        for (const record of result.records) {
          stampImport.run(now, record.id)
        }
        return existingCount
      })
      const imported = result.records.length
      const added = Math.max(0, new Set(result.records.map((record) => record.id)).size - existingCount)
      json(res, {
        imported,
        added,
        lastImportedAt: imported > 0 ? now : undefined,
        errors: result.errors.map(forUser),
        warnings: result.warnings.map(forUser),
      })
    } finally {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    }
    return true
  }
  return false
}
