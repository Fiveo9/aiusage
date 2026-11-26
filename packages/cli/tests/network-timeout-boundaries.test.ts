import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/device-auth/credentials.js', () => ({ loadCredentials: () => ({ device_id: 'synthetic-device', device_secret: 'synthetic-only' }) }))
vi.mock('../src/site-url.js', () => ({ getSiteUrl: () => 'https://synthetic.invalid' }))
const aws = vi.hoisted(() => ({ config: null as any, destroy: vi.fn() }))
vi.mock('@aws-sdk/client-s3', () => {
  class Command { constructor(public input: unknown) {} }
  return { S3Client: class { constructor(config: unknown) { aws.config = config }; destroy = aws.destroy },
    GetObjectCommand: Command, PutObjectCommand: Command, HeadObjectCommand: Command, ListObjectsV2Command: Command,
    DeleteObjectCommand: Command, DeleteObjectsCommand: Command }
})
import { cloudPush, cloudPull, cloudClear } from '../src/sync/cloud.js'
import { startDeviceAuth, completeDeviceAuth } from '../src/device-auth/api.js'
import { fetchLitellmPricing } from '../src/pricing-registry.js'
import { S3SyncBackend, resolveS3ProxyEnv } from '../src/sync/s3.js'

const PROXY_ENV_KEYS = [
  'AIUSAGE_S3_PROXY',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
] as const

describe('review network deadlines', () => {
  beforeEach(() => {
    aws.config = null
    aws.destroy.mockReset()
    for (const key of PROXY_ENV_KEYS) vi.stubEnv(key, '')
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
  it.each(['push', 'pull', 'clear', 'device-start', 'device-complete', 'pricing'])('uses a finite native fetch deadline for %s', async operation => {
    const fetcher = vi.fn(async () => Response.json({ error: 'synthetic failure' }, { status: 500 }))
    vi.stubGlobal('fetch', fetcher)
    const deadline = vi.spyOn(AbortSignal, 'timeout')
    const call = operation === 'push' ? cloudPush([], [], 'synthetic', 1)
      : operation === 'pull' ? cloudPull()
      : operation === 'clear' ? cloudClear()
      : operation === 'device-start' ? startDeviceAuth('https://synthetic.invalid', { device_name: 'Synthetic', cli_version: '0.0.0', device_challenge: 'synthetic-only' })
      : operation === 'device-complete' ? completeDeviceAuth('https://synthetic.invalid', { device_request_id: 'synthetic', device_verifier: 'synthetic-only' })
      : fetchLitellmPricing()
    await expect(call).rejects.toBeInstanceOf(Error)
    expect(fetcher).toHaveBeenCalledOnce()
    expect((fetcher.mock.calls[0] as unknown[])[1]).toMatchObject({ signal: expect.any(AbortSignal) })
    expect(deadline).toHaveBeenCalledWith(30_000)
  })
  it('keeps S3 connection/request/socket deadlines enabled without a proxy', () => {
    new S3SyncBackend({ bucket: 'synthetic', prefix: '', accessKeyId: 'synthetic-only', secretAccessKey: 'synthetic-only' })
    expect(aws.config.requestHandler).toMatchObject({ connectionTimeout: 15_000, requestTimeout: 30_000, socketTimeout: 30_000 })
    expect(aws.config.requestHandler.httpAgent).toBeUndefined()
    expect(aws.config.requestHandler.httpsAgent).toBeUndefined()
  })
  it('picks up standard proxy env vars for S3 and destroys owned agents on close', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7890')
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:7890')
    vi.stubEnv('NO_PROXY', 'localhost,127.0.0.1')
    const backend = new S3SyncBackend({ bucket: 'synthetic', prefix: '', accessKeyId: 'synthetic-only', secretAccessKey: 'synthetic-only' })
    const { httpAgent, httpsAgent } = aws.config.requestHandler
    expect(aws.config.requestHandler).toMatchObject({ connectionTimeout: 15_000, requestTimeout: 30_000, socketTimeout: 30_000 })
    expect(httpAgent).toBeDefined()
    expect(httpsAgent).toBeDefined()
    const httpDestroy = vi.spyOn(httpAgent, 'destroy')
    const httpsDestroy = vi.spyOn(httpsAgent, 'destroy')
    backend.close()
    expect(aws.destroy).toHaveBeenCalledOnce()
    expect(httpDestroy).toHaveBeenCalledOnce()
    expect(httpsDestroy).toHaveBeenCalledOnce()
  })
  it('resolves AIUSAGE_S3_PROXY strictly and overrides ambient proxy env', () => {
    expect(resolveS3ProxyEnv({
      AIUSAGE_S3_PROXY: 'http://127.0.0.1:8888',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost',
    }, '24.5.0')).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:8888/',
      HTTPS_PROXY: 'http://127.0.0.1:8888/',
    })
    expect(() => resolveS3ProxyEnv({ AIUSAGE_S3_PROXY: 'socks5://127.0.0.1:7890' }, '24.5.0'))
      .toThrow('AIUSAGE_S3_PROXY must be an HTTP or HTTPS proxy URL.')
    for (const ver of ['20.19.0', '23.11.0', '24.4.0']) {
      expect(() => resolveS3ProxyEnv({ AIUSAGE_S3_PROXY: 'http://127.0.0.1:7890' }, ver))
        .toThrow('AIUSAGE_S3_PROXY requires Node.js 22.21+, 24.5+, or 25+ (not Node.js 23).')
    }
  })
  it('falls back to standard HTTP/HTTPS/ALL/NO_PROXY env vars and ignores unsupported values safely', () => {
    expect(resolveS3ProxyEnv({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'https://127.0.0.1:7891',
      NO_PROXY: ' localhost,127.0.0.1 ',
    }, '22.21.0')).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890/',
      HTTPS_PROXY: 'https://127.0.0.1:7891/',
      NO_PROXY: 'localhost,127.0.0.1',
    })
    expect(resolveS3ProxyEnv({
      http_proxy: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890',
      no_proxy: '::1',
    }, '25.0.0')).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890/',
      HTTPS_PROXY: 'http://127.0.0.1:7890/',
      NO_PROXY: '::1',
    })
    expect(resolveS3ProxyEnv({ ALL_PROXY: 'http://127.0.0.1:7890' }, '24.5.0')).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890/',
      HTTPS_PROXY: 'http://127.0.0.1:7890/',
    })
    expect(resolveS3ProxyEnv({ HTTPS_PROXY: 'socks5://127.0.0.1:7890' }, '24.5.0')).toBeUndefined()
    expect(resolveS3ProxyEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890' }, '20.19.0')).toBeUndefined()
  })
  it('propagates an aborted deadline instead of leaving a fetch pending', async () => {
    const controller = new AbortController()
    const failure = new Error('synthetic deadline expired')
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })))
    const request = cloudPull()
    controller.abort(failure)
    await expect(request).rejects.toBe(failure)
  })
})
