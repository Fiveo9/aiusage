import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { env } from '$env/dynamic/private'
import { registerSiteResource } from '../resource-lifecycle.js'

let client: S3Client | undefined
let configuration: string | undefined
let unregister: (() => void) | undefined

function getClient(): S3Client {
  const accountId = env.R2_ACCOUNT_ID
  const accessKeyId = env.R2_ACCESS_KEY_ID
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 storage not configured: missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY')
  }

  const signature = JSON.stringify([accountId, accessKeyId, secretAccessKey])
  if (client && configuration === signature) return client
  const previous = client
  client = undefined
  configuration = undefined
  unregister?.()
  unregister = undefined
  previous?.destroy()
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey }
  })
  configuration = signature
  unregister = registerSiteResource(() => {
    client?.destroy()
    client = undefined
    configuration = undefined
    unregister = undefined
  })
  return client
}

function getBucket(): string {
  return env.R2_BUCKET || 'aiusage'
}

function getPublicUrl(): string {
  return env.R2_PUBLIC_URL || `https://${env.R2_ACCOUNT_ID}.r2.dev`
}

export async function uploadFile(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<string> {
  const client = getClient()
  await client.send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable'
  }))
  return `${getPublicUrl().replace(/\/+$/, '')}/${key}`
}

export async function deleteFile(key: string): Promise<void> {
  const client = getClient()
  await client.send(new DeleteObjectCommand({
    Bucket: getBucket(),
    Key: key
  }))
}

export function extractKeyFromUrl(url: string, requiredPrefix?: string): string | null {
  try {
    const base = new URL(`${getPublicUrl().replace(/\/+$/, '')}/`)
    const target = new URL(url)
    if (target.origin !== base.origin || target.search || target.hash || !target.pathname.startsWith(base.pathname)) return null
    const key = decodeURIComponent(target.pathname.slice(base.pathname.length))
    if (!key || key.includes('\\') || key.split('/').some(part => !part || part === '.' || part === '..')) return null
    if (requiredPrefix && !key.startsWith(requiredPrefix)) return null
    return key
  } catch { return null }
}
