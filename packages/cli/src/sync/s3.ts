import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { normalizeS3Prefix, normalizeS3Endpoint } from './s3-location.js'
import { isToolCallPath } from './tool-call-snapshot.js'
import { isSafeSyncPath } from './safe-path.js'

export interface S3Config {
  bucket: string
  prefix: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string
  region?: string
}

function s3ProxyHandler() {
  const timeouts = { connectionTimeout: 5_000, socketTimeout: 30_000, requestTimeout: 30_000 }
  const configuredProxy = process.env.AIUSAGE_S3_PROXY
  if (!configuredProxy?.trim()) return timeouts

  const proxy = configuredProxy.trim()
  if (/[\r\n]/.test(configuredProxy) || !/^https?:\/\//i.test(proxy) || !URL.canParse(proxy)) {
    throw new Error('AIUSAGE_S3_PROXY must be an HTTP or HTTPS proxy URL.')
  }
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (!(major >= 25 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21))) {
    throw new Error('AIUSAGE_S3_PROXY requires Node.js 22.21+, 24.5+, or 25+ (not Node.js 23).')
  }

  const normalizedProxy = new URL(proxy).href
  const proxyEnv = { HTTP_PROXY: normalizedProxy, HTTPS_PROXY: normalizedProxy }
  const agentOptions = { keepAlive: true, maxSockets: 50, proxyEnv }
  return {
    ...timeouts,
    httpAgent: new HttpAgent(agentOptions),
    httpsAgent: new HttpsAgent(agentOptions),
  }
}

export class S3SyncBackend {
  readonly supportsToolCalls = true
  private client: S3Client
  private bucket: string
  private prefix: string
  private closed = false
  private ownedAgents: Array<{ destroy(): void }> = []

  constructor(config: S3Config) {
    this.bucket = config.bucket
    // Ensure prefix ends with / and doesn't start with / (the same
    // normalisation the sync target key applies, so both name the same store).
    this.prefix = normalizeS3Prefix(config.prefix)
    const endpoint = normalizeS3Endpoint(config.endpoint)
    const requestHandler = s3ProxyHandler()
    if ('httpAgent' in requestHandler) this.ownedAgents.push(requestHandler.httpAgent, requestHandler.httpsAgent)
    this.client = new S3Client({
      region: config.region ?? 'auto',
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      ...(requestHandler ? { requestHandler } : {}),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    })
  }

  getObjectKey(path: string): string {
    if (!isSafeSyncPath(path)) throw new Error('Invalid S3 sync relative path')
    return `${this.prefix}${path}`
  }

  async readFile(path: string): Promise<string | null> {
    const key = this.getObjectKey(path)
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
      const response = await this.client.send(command)
      if (!response.Body) throw new Error('S3 GetObject returned no body.')
      return await response.Body.transformToString('utf-8')
    } catch (error: any) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        return null
      }
      throw error
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const key = this.getObjectKey(path)
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: content,
      ContentType: isToolCallPath(path) || /^[^/]+\/manifest\.json$/.test(path) ? 'application/json' : 'application/x-ndjson',
    })
    await this.client.send(command)
  }

  async listFiles(): Promise<string[]> {
    return (await this.listFilesWithDigests()).paths
  }

  async listFilesWithDigests(): Promise<{ paths: string[]; digests: Map<string, string> }> {
    const files: string[] = []
    const digests = new Map<string, string>()
    for (const entry of await this.listEntries()) {
      if (entry.path.endsWith('.ndjson') || /^[^/]+\/(manifest\.json|tool-calls\.v1\.json)$/.test(entry.path)) {
        if (!isSafeSyncPath(entry.path)) throw new Error('S3 returned an unsafe sync path in its listing.')
        files.push(entry.path)
        if (entry.path.endsWith('.ndjson') || isToolCallPath(entry.path)) {
          const etag = entry.etag?.replace(/^"|"$/g, '')
          if (etag && /^[0-9a-f]{32}$/i.test(etag)) digests.set(entry.path, etag.toLowerCase())
        }
      }
    }
    return { paths: files.sort(), digests }
  }

  /**
   * Content digests from the listing: for single-part uploads (which is all
   * this backend ever writes) the S3/R2 ETag is the hex MD5 of the object.
   * Multipart ETags (containing '-') are not digests and are left out, so the
   * orchestrator falls back to reading those files.
   */
  async listFileDigests(): Promise<Map<string, string>> {
    return (await this.listFilesWithDigests()).digests
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.client.destroy() }
    finally { for (const agent of this.ownedAgents) agent.destroy() }
  }

  /** Every object under the prefix (data files and namespace manifests alike). */
  private async listEntries(): Promise<Array<{ path: string; etag?: string }>> {
    const entries: Array<{ path: string; etag?: string }> = []
    let continuationToken: string | undefined
    const seenTokens = new Set<string>()

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.prefix,
        ContinuationToken: continuationToken,
      })
      const response = await this.client.send(command)

      if (typeof response.IsTruncated !== 'boolean'
        || (response.Contents !== undefined && !Array.isArray(response.Contents))) {
        throw new Error('S3 returned an invalid object listing.')
      }
      if (response.Contents) {
        for (const obj of response.Contents) {
          const key = obj?.Key
          if (typeof key !== 'string' || !key.startsWith(this.prefix)) {
            throw new Error('S3 returned an invalid object key in its listing.')
          }
          const relPath = key.slice(this.prefix.length)
          if (relPath) entries.push({ path: relPath, etag: obj.ETag })
        }
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
      if (response.IsTruncated) {
        if (typeof continuationToken !== 'string' || !continuationToken.trim() || seenTokens.has(continuationToken)) {
          throw new Error('S3 listing is truncated without a progressing continuation token.')
        }
        seenTokens.add(continuationToken)
      }
    } while (continuationToken)

    return entries
  }

  async fileExists(path: string): Promise<boolean> {
    const key = this.getObjectKey(path)
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
      await this.client.send(command)
      return true
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false
      }
      throw error
    }
  }

  async deleteFile(path: string): Promise<void> {
    const key = this.getObjectKey(path)
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    })
    await this.client.send(command)
  }

  /**
   * Remove every file of the sync layout under the prefix — day files and
   * namespace manifests, exactly what `listFiles` reports. Anything else a
   * shared prefix may hold was not written by this backend and is left
   * alone. Returns the number of data files removed.
   *
   * `DeleteObjects` succeeds as a request even when individual keys could
   * not be deleted; those come back in `Errors`. A wipe that silently left
   * objects behind would be reported as complete while peers keep mirroring
   * them, so any per-object failure is thrown.
   */
  async deleteAllData(): Promise<number> {
    const files = await this.listFiles()
    if (files.length === 0) return 0

    // Delete in batches of 1000 (S3 limit)
    const BATCH_SIZE = 1000
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE)
      const command = new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: {
          Objects: batch.map(f => ({ Key: this.getObjectKey(f) })),
          Quiet: true,
        },
      })
      const response = await this.client.send(command)
      const errors = response.Errors ?? []
      if (errors.length > 0) {
        const first = errors[0]
        const key = first.Key ? first.Key.slice(this.prefix.length) : 'unknown key'
        const detail = [first.Code, first.Message].filter(Boolean).join(': ')
        throw new Error(`Could not delete ${errors.length} object(s) from the S3 sync target (first: '${key}'${detail ? `, ${detail}` : ''}).`)
      }
    }

    return files.filter(f => f.endsWith('.ndjson') || isToolCallPath(f)).length
  }
}
