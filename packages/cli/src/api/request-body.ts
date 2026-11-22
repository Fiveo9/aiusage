import type { IncomingMessage } from 'node:http'

export class BodyTooLargeError extends Error {
  constructor() { super('Request body too large') }
}

export function readBodyBuffer(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.pause()
      reject(new BodyTooLargeError())
      return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onAborted = () => onError(new Error('Request aborted'))
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > maxBytes) {
        req.pause()
        cleanup()
        chunks.length = 0
        reject(new BodyTooLargeError())
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => {
      cleanup()
      resolve(Buffer.concat(chunks, bytes))
    }
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onAborted)
  })
}

export async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const text = (await readBodyBuffer(req, maxBytes)).toString('utf8')
  const value = text.trim() ? JSON.parse(text) : {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError('Expected JSON object')
  return value
}
