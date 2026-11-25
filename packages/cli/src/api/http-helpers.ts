import http from 'node:http'

export function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

export function bodyTooLarge(res: http.ServerResponse): void {
  res.setHeader('Connection', 'close')
  json(res, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'JSON body exceeds the allowed size' } }, 413)
}

export function isDatabaseLockedError(error: unknown): boolean {
  return error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message)
}

export function databaseBusy(res: http.ServerResponse): void {
  json(res, {
    error: {
      code: 'DATABASE_BUSY',
      message: 'Database is busy. Wait for the current refresh, sync, or import to finish and retry.',
    },
  }, 503)
}
