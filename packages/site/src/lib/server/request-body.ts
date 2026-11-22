import { error } from '@sveltejs/kit'

export const DEFAULT_JSON_BODY_LIMIT = 1024 * 1024
export const AUTH_BODY_LIMIT = 16 * 1024

export async function readLimitedBuffer(request: Request, maxBytes = DEFAULT_JSON_BODY_LIMIT): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw error(500, 'Invalid request body limit')
  const declared = request.headers.get('content-length')
  if (declared != null) {
    if (!/^\d+$/.test(declared)) throw error(400, 'Invalid Content-Length')
    if (Number(declared) > maxBytes) throw error(413, 'Payload too large')
  }
  if (!request.body) return Buffer.alloc(0)
  const reader = request.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) throw error(413, 'Payload too large')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, bytes)
  } finally {
    // Cancelling an adapter-node body can destroy the socket before its 413
    // response is delivered. Stop reading and let response completion close it.
    reader.releaseLock()
  }
}

export async function readLimitedText(request: Request, maxBytes = DEFAULT_JSON_BODY_LIMIT): Promise<string> {
  return (await readLimitedBuffer(request, maxBytes)).toString('utf8')
}

export function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch {
    throw error(400, 'Invalid JSON object')
  }
}

export async function readLimitedJson(request: Request, maxBytes = DEFAULT_JSON_BODY_LIMIT): Promise<Record<string, unknown>> {
  return parseJsonObject(await readLimitedText(request, maxBytes))
}
