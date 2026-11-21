import { createHmac, randomBytes, createHash } from 'node:crypto'

export function computeHmac(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex')
}

export function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function generateNonce(): string {
  return randomBytes(16).toString('hex')
}

export function generateIdempotencyKey(): string {
  return randomBytes(16).toString('hex')
}

export function buildCanonicalString(
  method: string,
  path: string,
  bodyHash: string,
  timestamp: string,
  nonce: string,
  deviceId: string,
  idempotencyKey: string
): string {
  return [method, path, bodyHash, timestamp, nonce, deviceId, idempotencyKey].join('\n')
}

export function base64url(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data
  return buf.toString('base64url')
}

export function sha256Buffer(data: string): Buffer {
  return createHash('sha256').update(data).digest()
}
