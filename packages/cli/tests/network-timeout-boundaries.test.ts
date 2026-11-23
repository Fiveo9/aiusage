import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/device-auth/credentials.js', () => ({ loadCredentials: () => ({ device_id: 'synthetic-device', device_secret: 'synthetic-only' }) }))
vi.mock('../src/site-url.js', () => ({ getSiteUrl: () => 'https://synthetic.invalid' }))
const aws = vi.hoisted(() => ({ config: null as any }))
vi.mock('@aws-sdk/client-s3', () => {
  class Command { constructor(public input: unknown) {} }
  return { S3Client: class { constructor(config: unknown) { aws.config = config } },
    GetObjectCommand: Command, PutObjectCommand: Command, HeadObjectCommand: Command, ListObjectsV2Command: Command,
    DeleteObjectCommand: Command, DeleteObjectsCommand: Command }
})
import { cloudPush, cloudPull, cloudClear } from '../src/sync/cloud.js'
import { startDeviceAuth, completeDeviceAuth } from '../src/device-auth/api.js'
import { fetchLitellmPricing } from '../src/pricing-registry.js'
import { S3SyncBackend } from '../src/sync/s3.js'

describe('review network deadlines', () => {
  beforeEach(() => { vi.stubEnv('AIUSAGE_S3_PROXY', '') })
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
    expect(aws.config.requestHandler).toMatchObject({ connectionTimeout: 5_000, requestTimeout: 30_000, socketTimeout: 30_000 })
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
