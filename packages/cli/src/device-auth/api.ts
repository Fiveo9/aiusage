const DEVICE_START_PATH = '/api/cli/device/start'
const DEVICE_COMPLETE_PATH = '/api/cli/device/complete'
export interface DeviceStartRequest {
  device_name: string
  cli_version: string
  device_challenge: string
}

export interface DeviceStartResponse {
  device_request_id: string
  user_code: string
  verification_url: string
  expires_at: string
  interval: number
}

export interface DeviceCompleteRequest {
  device_request_id: string
  device_verifier: string
}

export interface DeviceCompleteResponse {
  device_id: string
  device_secret: string
}

export class DeviceAuthApiError extends Error {
  constructor(
    message: string,
    public code?: string,
    public retryAfter?: number
  ) {
    super(message)
    this.name = 'DeviceAuthApiError'
  }
}

async function readJsonOrNull(response: Response): Promise<any | null> {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) return null
  return response.json().catch(() => null)
}

function endpointUnavailableMessage(path: string, status: number): string {
  return `Device authorization endpoint ${path} is unavailable (HTTP ${status}). The site deployment is not routing this API request to the Node server.`
}

export function clampPollingInterval(value: unknown): number {
  const interval = Number(value)
  return Number.isFinite(interval) && interval > 0 ? Math.max(1, Math.min(60, interval)) : 5
}

export function validateVerificationUrl(value: unknown, serverUrl?: string): string {
  try {
    if (typeof value !== 'string' || /[\\\u0000-\u0020\u007f`"'<>|;$()]/.test(value)) throw new Error()
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
    if (serverUrl && url.origin !== new URL(serverUrl).origin) throw new Error()
    return url.href
  } catch {
    throw new DeviceAuthApiError('Invalid browser verification URL', 'invalid_response')
  }
}

function responseError(data: any, path: string, status: number): DeviceAuthApiError {
  return new DeviceAuthApiError(
    typeof data?.error === 'string' ? data.error : endpointUnavailableMessage(path, status),
    typeof data?.error_code === 'string' && data.error_code
      ? data.error_code : typeof data?.error === 'string' ? data.error : 'endpoint_unavailable'
  )
}

export async function startDeviceAuth(
  serverUrl: string,
  request: DeviceStartRequest
): Promise<DeviceStartResponse> {
  const response = await fetch(new URL(DEVICE_START_PATH, validateVerificationUrl(serverUrl)).href, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  const data = await readJsonOrNull(response)

  if (!response.ok) {
    throw responseError(data, DEVICE_START_PATH, response.status)
  }

  if (!data) {
    throw new DeviceAuthApiError(endpointUnavailableMessage(DEVICE_START_PATH, response.status), 'endpoint_unavailable')
  }

  const expiresAt = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : NaN
  if (typeof data.device_request_id !== 'string' || !data.device_request_id.trim()
    || data.device_request_id.length > 256
    || typeof data.user_code !== 'string' || !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(data.user_code)
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new DeviceAuthApiError('Invalid device authorization response', 'invalid_response')
  }
  return {
    device_request_id: data.device_request_id,
    user_code: data.user_code,
    verification_url: validateVerificationUrl(data.verification_url, serverUrl),
    expires_at: new Date(expiresAt).toISOString(),
    interval: clampPollingInterval(data.interval),
  }
}

export async function completeDeviceAuth(
  serverUrl: string,
  request: DeviceCompleteRequest
): Promise<DeviceCompleteResponse> {
  const response = await fetch(new URL(DEVICE_COMPLETE_PATH, validateVerificationUrl(serverUrl)).href, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  const data = await readJsonOrNull(response)

  if (response.status === 202 || (response.ok && data?.pending === true)) {
    throw new DeviceAuthApiError('Authorization pending', 'authorization_pending')
  }

  if (!response.ok) {
    throw responseError(data, DEVICE_COMPLETE_PATH, response.status)
  }

  if (!data) {
    throw new DeviceAuthApiError(endpointUnavailableMessage(DEVICE_COMPLETE_PATH, response.status), 'endpoint_unavailable')
  }

  if (typeof data.device_id !== 'string' || !data.device_id.trim()
    || typeof data.device_secret !== 'string' || !data.device_secret.trim()) {
    throw new DeviceAuthApiError('Invalid device auth response: missing device credentials', 'invalid_response')
  }

  return { device_id: data.device_id, device_secret: data.device_secret }
}

